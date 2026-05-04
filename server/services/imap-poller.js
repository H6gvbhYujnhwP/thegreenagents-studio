/**
 * imap-poller.js — Background worker that polls connected Gmail mailboxes
 * via IMAP, matches replies to campaign sends, and stores them in email_replies.
 *
 * Phase 3.1 scope: connect, fetch, store, match. Classification and
 * auto-unsubscribe live in classify-replies.js (Phase 3.2).
 *
 * Forward-only processing: when a mailbox is first connected we record
 * `connected_at`. The poller only fetches messages received AFTER that time.
 * Already-existing inbox messages are ignored — the user should clean them
 * up manually before connecting if they want a fresh start.
 *
 * Architecture: one Node interval timer that loops every POLL_INTERVAL_MS,
 * runs through all enabled inboxes serially (one at a time, not parallel),
 * each inbox connects → fetches → stores → disconnects. Serial processing
 * keeps memory low and prevents Gmail rate-limiting (~7 connections/account/sec).
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { decrypt } from './crypto-vault.js';

const POLL_INTERVAL_MS = 3 * 60 * 1000;   // 3 minutes
const MAX_FETCH_PER_POLL = 200;           // cap per cycle; on backfill this can fill quickly
const BACKFILL_DAYS = 30;                 // first-poll backfill window

let pollerHandle = null;
let isPolling = false;   // prevents overlapping runs if a poll takes >3 min

// Start the poller on app boot. Safe to call multiple times.
export function startPoller() {
  if (pollerHandle) return;
  console.log('[poller] starting — interval ' + (POLL_INTERVAL_MS / 1000) + 's');
  // First run after 30s (let the app finish booting), then every 3 min
  setTimeout(() => {
    pollAllInboxes();
    pollerHandle = setInterval(pollAllInboxes, POLL_INTERVAL_MS);
  }, 30_000);
}

// Stop the poller (used in tests, or for graceful shutdown).
export function stopPoller() {
  if (pollerHandle) clearInterval(pollerHandle);
  pollerHandle = null;
}

// One full pass — processes every enabled inbox serially.
async function pollAllInboxes() {
  if (isPolling) {
    console.log('[poller] previous run still in progress, skipping');
    return;
  }
  isPolling = true;
  try {
    const inboxes = db.prepare(
      "SELECT * FROM email_inboxes WHERE enabled = 1"
    ).all();

    for (const ib of inboxes) {
      try {
        await pollOneInbox(ib);
      } catch (err) {
        // Log but continue — one bad inbox shouldn't kill the whole loop
        console.error(`[poller] ${ib.email_address}: ${err.message}`);
        db.prepare(
          "UPDATE email_inboxes SET last_polled_at = datetime('now'), last_error = ? WHERE id = ?"
        ).run(err.message.slice(0, 500), ib.id);
      }
    }
  } finally {
    isPolling = false;
  }
}

// Manual one-off poll trigger — used by the "Check now" button.
// Returns { ok, fetched, scanned, error } so the UI can display feedback.
//   scanned = how many UIDs the IMAP search returned (visible inbox size in window)
//   fetched = how many we actually wrote to the DB this run (new since last poll)
export async function pollSingleInbox(inboxId) {
  const ib = db.prepare("SELECT * FROM email_inboxes WHERE id = ?").get(inboxId);
  if (!ib) return { ok: false, error: 'Inbox not found' };
  try {
    const result = await pollOneInbox(ib);
    return { ok: true, ...result };
  } catch (err) {
    db.prepare(
      "UPDATE email_inboxes SET last_polled_at = datetime('now'), last_error = ? WHERE id = ?"
    ).run(err.message.slice(0, 500), ib.id);
    return { ok: false, error: err.message };
  }
}

// Connect to one inbox, fetch new mail, parse, store, disconnect.
// Returns { fetched, scanned } — how many we stored vs how many we looked at.
//
// First poll for an inbox (last_uid = 0): fetches the last BACKFILL_DAYS of mail
// so the user sees recent context, not an empty inbox.
// Subsequent polls: fetches anything with UID > last_uid (efficient — IMAP UIDs
// only ever increase within a folder, so we never reprocess what we've seen).
async function pollOneInbox(inbox) {
  const password = decrypt(inbox.app_password_encrypted);
  const client = new ImapFlow({
    host: inbox.imap_host,
    port: inbox.imap_port,
    secure: true,
    auth: { user: inbox.email_address, pass: password },
    logger: false,
    socketTimeout: 30_000,
  });

  await client.connect();
  let stored = 0;
  let scanned = 0;

  try {
    await client.mailboxOpen('INBOX');

    const isFirstPoll = !inbox.last_uid || inbox.last_uid === 0;
    let uids;

    if (isFirstPoll) {
      // First poll for this inbox — backfill recent history so the UI isn't empty.
      const sinceDate = new Date(Date.now() - BACKFILL_DAYS * 86400 * 1000);
      uids = await client.search({ since: sinceDate }, { uid: true });
      console.log(`[poller] ${inbox.email_address}: first poll, backfilling ${BACKFILL_DAYS}d — ${uids.length} messages found`);
    } else {
      // Subsequent poll — Gmail IMAP UIDs are monotonically increasing.
      // ImapFlow doesn't take a UID range cleanly via search(), so we fetch all
      // UIDs and filter in JS. For large mailboxes this is ~10ms.
      const allUids = await client.search({ all: true }, { uid: true });
      uids = allUids.filter(u => u > inbox.last_uid);
    }

    scanned = uids.length;

    // Cap so a single poll can't take forever
    const toFetch = uids.slice(-MAX_FETCH_PER_POLL);

    if (toFetch.length === 0) {
      db.prepare("UPDATE email_inboxes SET last_polled_at = datetime('now'), last_error = NULL WHERE id = ?")
        .run(inbox.id);
      return { fetched: 0, scanned };
    }

    let highestUid = inbox.last_uid || 0;

    for (const uid of toFetch) {
      try {
        const message = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!message || !message.source) continue;

        const parsed = await simpleParser(message.source);
        const messageId = parsed.messageId || null;

        // Defensive dedupe — even if the UID filter above missed something, the
        // message_id check guarantees we never store the same email twice.
        if (messageId) {
          const existing = db.prepare(
            "SELECT id FROM email_replies WHERE message_id = ? AND inbox_id = ?"
          ).get(messageId, inbox.id);
          if (existing) {
            highestUid = Math.max(highestUid, uid);
            continue;
          }
        }

        // Threading info — In-Reply-To and References tell us this is a reply
        // to a previous message. We use these to match back to a campaign send.
        const inReplyTo = parsed.inReplyTo || null;
        const refsHeader = parsed.references
          ? (Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references)
          : null;

        let matchedSubscriberId = null;
        let matchedCampaignId = null;
        if (inReplyTo) {
          const cleanId = inReplyTo.replace(/[<>]/g, '');
          const sendRow = db.prepare(
            "SELECT subscriber_id, campaign_id FROM email_sends WHERE message_id = ? OR message_id = ?"
          ).get(cleanId, '<' + cleanId + '>');
          if (sendRow) {
            matchedSubscriberId = sendRow.subscriber_id;
            matchedCampaignId = sendRow.campaign_id;
          }
        }
        if (!matchedSubscriberId && refsHeader) {
          const refIds = refsHeader.split(/\s+/).map(r => r.replace(/[<>]/g, '')).filter(Boolean);
          for (const refId of refIds) {
            const sendRow = db.prepare(
              "SELECT subscriber_id, campaign_id FROM email_sends WHERE message_id = ?"
            ).get(refId);
            if (sendRow) {
              matchedSubscriberId = sendRow.subscriber_id;
              matchedCampaignId = sendRow.campaign_id;
              break;
            }
          }
        }
        // Fall back: match by sender email to any subscriber on this client's lists.
        // Catches replies where threading headers were stripped by gateways.
        if (!matchedSubscriberId && parsed.from?.value?.[0]?.address) {
          const fromAddr = parsed.from.value[0].address.toLowerCase();
          const subRow = db.prepare(`
            SELECT s.id FROM email_subscribers s
            JOIN email_lists l ON s.list_id = l.id
            WHERE LOWER(s.email) = ? AND l.email_client_id = ?
            ORDER BY s.created_at DESC LIMIT 1
          `).get(fromAddr, inbox.email_client_id);
          if (subRow) matchedSubscriberId = subRow.id;
        }

        const fromValue = parsed.from?.value?.[0] || {};
        db.prepare(`
          INSERT INTO email_replies (
            id, inbox_id, email_client_id, message_id, in_reply_to, references_header,
            from_address, from_name, subject, body_text, body_html, received_at,
            matched_subscriber_id, matched_campaign_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuid(),
          inbox.id,
          inbox.email_client_id,
          messageId,
          inReplyTo,
          refsHeader,
          (fromValue.address || '').toLowerCase(),
          fromValue.name || null,
          parsed.subject || null,
          parsed.text || null,
          parsed.html || null,
          (parsed.date || new Date()).toISOString(),
          matchedSubscriberId,
          matchedCampaignId,
        );

        stored++;
        highestUid = Math.max(highestUid, uid);
      } catch (err) {
        console.error(`[poller] ${inbox.email_address} uid ${uid}: ${err.message}`);
      }
    }

    db.prepare(
      "UPDATE email_inboxes SET last_polled_at = datetime('now'), last_error = NULL, last_uid = ? WHERE id = ?"
    ).run(highestUid, inbox.id);

  } finally {
    try { await client.logout(); } catch {}
  }

  if (stored > 0) console.log(`[poller] ${inbox.email_address}: stored ${stored} new emails (scanned ${scanned})`);
  return { fetched: stored, scanned };
}

// Verify IMAP credentials work without committing them to the DB.
// Used by the "test connection" button before saving a new inbox.
export async function testImapCredentials({ email, appPassword, host = 'imap.gmail.com', port = 993 }) {
  const client = new ImapFlow({
    host, port, secure: true,
    auth: { user: email, pass: appPassword },
    logger: false,
    socketTimeout: 15_000,
  });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    await client.logout();
    return { ok: true };
  } catch (err) {
    try { await client.logout(); } catch {}
    return { ok: false, error: err.message };
  }
}
