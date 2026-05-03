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
const MAX_FETCH_PER_POLL = 50;            // safety cap per inbox per cycle

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

// Manual one-off poll trigger — used by the "test connection" route.
// Returns { ok, fetched, error } so the UI can display feedback.
export async function pollSingleInbox(inboxId) {
  const ib = db.prepare("SELECT * FROM email_inboxes WHERE id = ?").get(inboxId);
  if (!ib) return { ok: false, error: 'Inbox not found' };
  try {
    const fetched = await pollOneInbox(ib);
    return { ok: true, fetched };
  } catch (err) {
    db.prepare(
      "UPDATE email_inboxes SET last_polled_at = datetime('now'), last_error = ? WHERE id = ?"
    ).run(err.message.slice(0, 500), ib.id);
    return { ok: false, error: err.message };
  }
}

// Connect to one inbox, fetch new mail, parse, store, disconnect.
// Returns the count of replies stored.
async function pollOneInbox(inbox) {
  const password = decrypt(inbox.app_password_encrypted);
  const client = new ImapFlow({
    host: inbox.imap_host,
    port: inbox.imap_port,
    secure: true,
    auth: { user: inbox.email_address, pass: password },
    logger: false,                    // suppress verbose imapflow logs
    socketTimeout: 30_000,
  });

  await client.connect();
  let stored = 0;

  try {
    // Open INBOX read-write so we can mark messages seen if we want to.
    // For Phase 3.1 we don't mark anything — Gmail will continue to show
    // them as unread in the user's mail client.
    await client.mailboxOpen('INBOX');

    // Forward-only: only messages received SINCE the inbox was connected.
    // Plus we additionally filter on UID > last_uid so we never re-process
    // a message we've already stored, even if connected_at is older.
    const sinceDate = new Date(inbox.connected_at);
    const searchCriteria = { since: sinceDate };

    // imapflow's search returns UIDs by default
    const uids = await client.search(searchCriteria, { uid: true });
    const newUids = uids.filter(u => u > (inbox.last_uid || 0)).slice(-MAX_FETCH_PER_POLL);
    if (newUids.length === 0) {
      db.prepare("UPDATE email_inboxes SET last_polled_at = datetime('now'), last_error = NULL WHERE id = ?")
        .run(inbox.id);
      return 0;
    }

    let highestUid = inbox.last_uid || 0;

    for (const uid of newUids) {
      try {
        const message = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!message || !message.source) continue;

        // Skip if we already have this message_id (defensive; the UID filter
        // above should catch this, but Gmail's IMAP UIDs occasionally repeat
        // across folder operations).
        const parsed = await simpleParser(message.source);
        const messageId = parsed.messageId || null;
        if (messageId) {
          const existing = db.prepare(
            "SELECT id FROM email_replies WHERE message_id = ? AND inbox_id = ?"
          ).get(messageId, inbox.id);
          if (existing) {
            highestUid = Math.max(highestUid, uid);
            continue;
          }
        }

        // Skip if the message is older than connected_at — defensive guard
        // since IMAP `since` can be off-by-a-day depending on TZ.
        if (parsed.date && parsed.date < new Date(inbox.connected_at)) {
          highestUid = Math.max(highestUid, uid);
          continue;
        }

        // Try to match the reply back to a campaign send by walking the
        // In-Reply-To / References headers. SES MessageIds we sent become the
        // Message-ID header of the original email; recipients reply with that
        // in their In-Reply-To.
        const inReplyTo = parsed.inReplyTo || null;
        const refsHeader = parsed.references
          ? (Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references)
          : null;

        let matchedSubscriberId = null;
        let matchedCampaignId = null;
        if (inReplyTo) {
          // Strip <> if present
          const cleanId = inReplyTo.replace(/[<>]/g, '');
          const sendRow = db.prepare(
            "SELECT subscriber_id, campaign_id FROM email_sends WHERE message_id = ? OR message_id = ?"
          ).get(cleanId, '<' + cleanId + '>');
          if (sendRow) {
            matchedSubscriberId = sendRow.subscriber_id;
            matchedCampaignId = sendRow.campaign_id;
          }
        }
        // Fall back: if In-Reply-To didn't match, try References (chain of prior msgs)
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
        // Fall back 2: match by sender email to any subscriber on this client's lists.
        // This catches replies where the recipient's mail client stripped the
        // threading headers (some corporate gateways do this).
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

        // Insert. Classification is left NULL for now; classify-replies.js
        // (Phase 3.2) will fill it in on a separate cron pass.
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

  if (stored > 0) console.log(`[poller] ${inbox.email_address}: stored ${stored} new replies`);
  return stored;
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
