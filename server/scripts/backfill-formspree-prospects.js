/**
 * backfill-formspree-prospects.js — One-shot sweep of existing email_replies
 *
 * Run on Render shell with:
 *   cd /opt/render/project/src && node server/scripts/backfill-formspree-prospects.js
 *
 * What it does:
 *   - Scans every row in email_replies whose sender address is @formspree.io
 *     AND whose subject matches the lead-keyword list (same detector as
 *     the live poller hook)
 *   - For each match, re-parses the body to extract prospect email + name
 *   - Skips any row whose parsed email matches the customer's own mailbox
 *     or sending domain (same filter the live hook applies — see isOwnAddress
 *     in formspree-flagger.js)
 *   - Upserts into hot_prospects via the same path the live hook uses
 *     (so duplicates safely refresh existing rows rather than creating
 *     a second one)
 *
 * Safe to run multiple times — the upsert is idempotent. Re-running won't
 * overwrite manual notes or follow-up dates the operator has added to any
 * existing prospect, because the upsert only updates name and updated_at.
 *
 * Output is logged per-row so you can see what was picked up and what was
 * skipped. The script does NOT delete or alter email_replies rows — it
 * only reads them.
 */

import db from '../db.js';
import {
  isFormspreeLead,
  parseFormspreeBody,
  localPartToName,
  upsertProspectAuto,
  isOwnAddress,
} from '../services/formspree-flagger.js';

console.log('[backfill] starting Formspree-prospect sweep…');
const startedAt = Date.now();

// We need the same shape simpleParser produces, but just for detection. The
// detector reads parsed.from.value[0].address + parsed.subject + parsed.text +
// parsed.html — we can build a minimal stand-in from the email_replies columns.
const rows = db.prepare(`
  SELECT id, email_client_id, from_address, subject, body_text, body_html, received_at
  FROM email_replies
  WHERE LOWER(from_address) LIKE '%@formspree.io'
  ORDER BY received_at ASC
`).all();

console.log(`[backfill] found ${rows.length} email_replies row(s) from @formspree.io`);

let flagged = 0;
let updated = 0;
let skippedNotLead = 0;
let skippedNoEmail = 0;
let skippedOwnAddress = 0;

for (const r of rows) {
  // Build the minimal parsed-shape the detector expects.
  const parsedShape = {
    from: { value: [{ address: r.from_address }] },
    subject: r.subject,
    text: r.body_text,
    html: r.body_html,
  };

  if (!isFormspreeLead(parsedShape)) {
    skippedNotLead++;
    continue;
  }

  const { email, name } = parseFormspreeBody(r.body_text, r.body_html);
  if (!email) {
    skippedNoEmail++;
    console.warn(`[backfill] no LABELLED email parseable from reply ${r.id} — subject="${r.subject || ''}"`);
    continue;
  }

  // Second defence: skip the customer's own mailbox or any address on a
  // domain they send from. Catches the same junk-row class that the parser
  // tightening is also designed to prevent.
  if (isOwnAddress(r.email_client_id, email)) {
    skippedOwnAddress++;
    console.log(`[backfill]   skipping own-address ${email} for client=${r.email_client_id} (reply ${r.id})`);
    continue;
  }

  const resolvedName = name || localPartToName(email) || null;
  const result = upsertProspectAuto({
    emailClientId: r.email_client_id,
    prospectEmail: email,
    prospectName: resolvedName,
  });

  if (!result) {
    console.warn(`[backfill] upsert returned null for ${email} — see prior log line`);
    continue;
  }
  if (result.was_new) {
    flagged++;
    console.log(`[backfill] + added ${email}${resolvedName ? ` (${resolvedName})` : ''} for client=${r.email_client_id}`);
  } else {
    updated++;
    console.log(`[backfill]   already on list: ${email} for client=${r.email_client_id} (refreshed)`);
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`[backfill] done in ${elapsed}s — added=${flagged}, refreshed=${updated}, skipped(not_lead)=${skippedNotLead}, skipped(no_email)=${skippedNoEmail}, skipped(own_address)=${skippedOwnAddress}, total_rows_seen=${rows.length}`);

process.exit(0);
