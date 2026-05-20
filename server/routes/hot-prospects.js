// ─────────────────────────────────────────────────────────────────────────────
// CRM — Hot Prospects (admin side)
//
// Admin-facing endpoints for the per-customer Hot Prospects list. Mounted at
// /api/email/hot-prospects in server/index.js, behind the global requireAuth
// Bearer-token middleware (same as every other admin endpoint).
//
// Each row lives in the `hot_prospects` table (see db.js). One row per
// (customer, prospect-email). Adding the same prospect twice UPDATES the
// existing row instead of inserting a duplicate — the unique index on
// (email_client_id, prospect_email) is the hard guarantee; the INSERT ON
// CONFLICT below is the friendly user-facing implementation.
//
// The email thread for a prospect is NOT stored on the row. It's built live
// in /api/email/hot-prospects/:id/thread by joining email_replies (inbound)
// and email_outbound (sent) on email address. This matches the agreed
// design — new mail auto-appears in the thread, no sync work required.
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Normalise an email address for storage and matching. Lower-cased + trimmed.
// Threading and the unique index both depend on this normalisation being
// applied at every write and read site.
function normaliseEmail(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  return s.length ? s : null;
}

// Validate an ISO calendar date 'YYYY-MM-DD'. Returns the string back if
// valid, null otherwise. We accept null/undefined/empty as "clear it".
function validateFollowUpDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined; // marker for "bad input"
  // Basic month/day sanity. new Date() is lenient ('2025-02-30' parses), so
  // also round-trip and compare to catch obviously invalid days.
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return undefined;
  const iso = d.toISOString().slice(0, 10);
  if (iso !== s) return undefined;
  return s;
}

// Confirm an email_client_id exists. Returns the row (with id + name) or null.
function getEmailClient(id) {
  if (!id) return null;
  return db
    .prepare('SELECT id, name FROM email_clients WHERE id = ?')
    .get(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/email/hot-prospects?email_client_id=...
//
// List one customer's prospects, newest-first by added_at. Optional ?search
// filter does a case-insensitive substring match across name and email.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const emailClientId = String(req.query.email_client_id || '').trim();
  if (!emailClientId) {
    return res.status(400).json({ error: 'email_client_id required' });
  }
  const client = getEmailClient(emailClientId);
  if (!client) {
    return res.status(404).json({ error: 'email client not found' });
  }

  const search = String(req.query.search || '').trim().toLowerCase();
  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = db
      .prepare(
        `SELECT id, email_client_id, prospect_email, prospect_name,
                follow_up_date, notes, added_by, added_at, updated_at
           FROM hot_prospects
          WHERE email_client_id = ?
            AND (LOWER(COALESCE(prospect_name,'')) LIKE ? OR LOWER(prospect_email) LIKE ?)
          ORDER BY added_at DESC`
      )
      .all(emailClientId, like, like);
  } else {
    rows = db
      .prepare(
        `SELECT id, email_client_id, prospect_email, prospect_name,
                follow_up_date, notes, added_by, added_at, updated_at
           FROM hot_prospects
          WHERE email_client_id = ?
          ORDER BY added_at DESC`
      )
      .all(emailClientId);
  }

  res.json({ prospects: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/email/hot-prospects/customers
//
// List of customers for the admin CRM's customer-switcher badges. Returns
// every portal-enabled email_client AND every aws_domain/manual one — i.e.
// the union of "real email customers" and "portal customers" (which can
// overlap — Manson is both). Critically broader than GET /api/email/clients,
// which filters out portal-only rows per decision #57 — but the CRM is the
// operator's mission control across the WHOLE customer roster, so portal-only
// customers (Cube6 etc.) need to appear here too. Operator-confirmed
// 2026-05-20 (option B).
//
// Each row carries a `prospect_count` so the badge can show how many
// prospects each customer has. Customers with zero prospects still appear,
// just with a "0" badge.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/customers', (req, res) => {
  // The filter: include every row whose source is 'aws_domain'/'manual'
  // (real email customers) OR whose portal_enabled is 1 (portal customers,
  // including portal-only ones that GET /api/email/clients hides). The
  // OR ensures we don't double-count rows that satisfy both — they just
  // appear once. NULL-source rows are also included for the same race-
  // safety reason GET /api/email/clients includes them.
  const rows = db.prepare(`
    SELECT
      ec.id,
      ec.name,
      ec.color,
      ec.slug,
      ec.portal_enabled,
      ec.source,
      ec.logo_url,
      (SELECT COUNT(*) FROM hot_prospects WHERE email_client_id = ec.id) AS prospect_count
    FROM email_clients ec
    WHERE ec.source IS NULL
       OR ec.source IN ('aws_domain', 'manual')
       OR ec.portal_enabled = 1
    ORDER BY ec.name ASC
  `).all();

  res.json({ customers: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/email/hot-prospects
//
// Add a prospect to a customer's Hot Prospects list. Body:
//   { email_client_id, prospect_email, prospect_name?, follow_up_date?,
//     notes?, source_reply_id? }
//
// If a row already exists for (email_client_id, prospect_email), we UPDATE
// it: any provided fields overwrite (so the operator can use this endpoint
// as "add or refresh"). The unique index makes this a single-statement
// upsert via INSERT ... ON CONFLICT DO UPDATE.
//
// source_reply_id is optional — if supplied (the email_replies row the
// "Send to Hot Prospects" button was clicked on), and prospect_name is not
// supplied, we auto-fill the name from email_replies.from_name. This is
// the only auto-fill we do; everything else lives in the live-joined thread.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const {
    email_client_id,
    prospect_email,
    prospect_name,
    follow_up_date,
    notes,
    source_reply_id,
  } = req.body || {};

  const emailClientId = String(email_client_id || '').trim();
  if (!emailClientId) {
    return res.status(400).json({ error: 'email_client_id required' });
  }
  const client = getEmailClient(emailClientId);
  if (!client) {
    return res.status(404).json({ error: 'email client not found' });
  }

  const prospectEmail = normaliseEmail(prospect_email);
  if (!prospectEmail || !prospectEmail.includes('@')) {
    return res.status(400).json({ error: 'valid prospect_email required' });
  }

  // If prospect_name wasn't supplied but a source reply was, try to lift the
  // name off the reply. Best-effort; missing source row is silently ignored.
  let resolvedName = (prospect_name !== undefined && prospect_name !== null)
    ? String(prospect_name).trim() || null
    : null;
  if (!resolvedName && source_reply_id) {
    const reply = db
      .prepare(
        'SELECT from_name FROM email_replies WHERE id = ? AND email_client_id = ?'
      )
      .get(String(source_reply_id), emailClientId);
    if (reply && reply.from_name) {
      resolvedName = String(reply.from_name).trim() || null;
    }
  }

  const followUp = validateFollowUpDate(follow_up_date);
  if (followUp === undefined) {
    return res.status(400).json({ error: "follow_up_date must be 'YYYY-MM-DD' or null" });
  }

  const cleanNotes = (notes === undefined || notes === null)
    ? null
    : (String(notes).trim() || null);

  // Identify the actor for added_by. The admin Bearer token doesn't carry a
  // username — there's a single STUDIO_PASSWORD — so admin adds are tagged
  // 'admin' with no further detail. (Portal-side adds DO carry a user id,
  // see the customer-portal mirror in routes/portal.js.)
  const addedBy = 'admin';

  const id = uuid();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Upsert: if the (client, email) pair already exists, refresh the supplied
  // fields. We only overwrite name/notes/follow_up if a value was actually
  // supplied in the request body, so calling POST with just an email doesn't
  // wipe out existing notes.
  const stmt = db.prepare(`
    INSERT INTO hot_prospects (
      id, email_client_id, prospect_email, prospect_name,
      follow_up_date, notes, added_by, added_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email_client_id, prospect_email) DO UPDATE SET
      prospect_name  = COALESCE(excluded.prospect_name, hot_prospects.prospect_name),
      follow_up_date = CASE WHEN excluded.follow_up_date IS NOT NULL
                            THEN excluded.follow_up_date
                            ELSE hot_prospects.follow_up_date END,
      notes          = COALESCE(excluded.notes, hot_prospects.notes),
      updated_at     = excluded.updated_at
    RETURNING id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at
  `);

  const row = stmt.get(
    id,
    emailClientId,
    prospectEmail,
    resolvedName,
    followUp,
    cleanNotes,
    addedBy,
    now,
    now
  );

  res.json({ prospect: row });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/email/hot-prospects/:id
//
// Update follow_up_date and/or notes on an existing prospect. Body accepts
// either or both. Sending an explicit null for follow_up_date clears it.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const id = String(req.params.id || '');
  const existing = db
    .prepare('SELECT * FROM hot_prospects WHERE id = ?')
    .get(id);
  if (!existing) {
    return res.status(404).json({ error: 'prospect not found' });
  }

  const updates = {};
  if ('follow_up_date' in (req.body || {})) {
    const v = validateFollowUpDate(req.body.follow_up_date);
    if (v === undefined) {
      return res.status(400).json({ error: "follow_up_date must be 'YYYY-MM-DD' or null" });
    }
    updates.follow_up_date = v;
  }
  if ('notes' in (req.body || {})) {
    const raw = req.body.notes;
    updates.notes = (raw === null || raw === undefined)
      ? null
      : (String(raw).trim() || null);
  }
  if ('prospect_name' in (req.body || {})) {
    const raw = req.body.prospect_name;
    updates.prospect_name = (raw === null || raw === undefined)
      ? null
      : (String(raw).trim() || null);
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no updatable fields supplied' });
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).concat('updated_at = ?');
  const values = Object.values(updates).concat(now, id);

  db.prepare(`UPDATE hot_prospects SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  const row = db
    .prepare(
      `SELECT id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at
         FROM hot_prospects WHERE id = ?`
    )
    .get(id);

  res.json({ prospect: row });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/email/hot-prospects/:id
//
// Remove a prospect from the list. Does NOT touch email_replies or
// email_outbound — those records of the conversation stay in the inbox.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const id = String(req.params.id || '');
  const existing = db
    .prepare('SELECT id FROM hot_prospects WHERE id = ?')
    .get(id);
  if (!existing) {
    return res.status(404).json({ error: 'prospect not found' });
  }
  db.prepare('DELETE FROM hot_prospects WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/email/hot-prospects/:id/thread
//
// Build the full email history with this prospect, live, by joining
// email_replies (inbound from this address) and email_outbound (sent to
// this address) and sorting by timestamp. This is the auto-update half of
// the design — no stored copy, so new mail is automatically part of the
// thread the next time the operator opens the prospect.
//
// Returned shape:
//   { prospect: {...}, thread: [ { id, direction, ... }, ... ] }
// direction is 'inbound' for replies received, 'outbound' for messages we
// sent. Sorted oldest-first so the UI can render the conversation top to
// bottom in natural reading order.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/thread', (req, res) => {
  const id = String(req.params.id || '');
  const prospect = db
    .prepare(
      `SELECT id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at
         FROM hot_prospects WHERE id = ?`
    )
    .get(id);
  if (!prospect) {
    return res.status(404).json({ error: 'prospect not found' });
  }

  // Inbound: every reply received from this address on any inbox belonging
  // to this customer. LOWER() comparison matches the normalisation done at
  // write time. Returning subject/body so the UI can render the thread.
  const inbound = db
    .prepare(
      `SELECT id, from_address, from_name, subject, body_text, body_html,
              received_at, matched_campaign_id
         FROM email_replies
        WHERE email_client_id = ?
          AND LOWER(from_address) = ?
        ORDER BY received_at ASC`
    )
    .all(prospect.email_client_id, prospect.prospect_email);

  // Outbound: every message we sent to this address from any of the
  // customer's mailboxes. Matches against to_address (and optionally
  // cc_address via a separate LIKE — kept simple here: only direct TO
  // matches counted, CC chains are noise more often than signal).
  const outbound = db
    .prepare(
      `SELECT id, from_address, to_address, subject, body_text, body_html,
              sent_at, error
         FROM email_outbound
        WHERE email_client_id = ?
          AND LOWER(to_address) = ?
        ORDER BY sent_at ASC`
    )
    .all(prospect.email_client_id, prospect.prospect_email);

  // Merge + tag direction + sort by timestamp. Each row carries its own
  // timestamp field (received_at vs sent_at); we normalise to `at` for the
  // sort and leave the original field in place so the UI can show "Received"
  // vs "Sent" without re-deriving it.
  const merged = [
    ...inbound.map(r => ({
      kind: 'reply',
      direction: 'inbound',
      at: r.received_at,
      id: r.id,
      from_address: r.from_address,
      from_name: r.from_name,
      subject: r.subject,
      body_text: r.body_text,
      body_html: r.body_html,
      matched_campaign_id: r.matched_campaign_id,
    })),
    ...outbound.map(o => ({
      kind: 'outbound',
      direction: 'outbound',
      at: o.sent_at,
      id: o.id,
      from_address: o.from_address,
      to_address: o.to_address,
      subject: o.subject,
      body_text: o.body_text,
      body_html: o.body_html,
      error: o.error,
    })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  res.json({ prospect, thread: merged });
});

export default router;
