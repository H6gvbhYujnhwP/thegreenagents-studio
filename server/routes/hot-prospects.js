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
// Linked-row resolution (decision 2026-05-20, second session)
//
// A real customer can have TWO email_clients rows tied to them: a portal
// anchor (e.g. the cube6 row) and a separate inbox-owning row (e.g. the
// mail.engineeringsolutions.co.uk row), joined by customer_services with
// service_key='email'. From the user's mental model these are the same
// customer — hot prospects flagged on either row should be visible on either
// side. This helper returns the FULL SET of email_clients ids that belong to
// the same real customer, given ANY id in that set.
//
// Examples:
//   resolveLinkedSet('cube6')                                  → ['cube6', 'mail.engineeringsolutions.co.uk']
//   resolveLinkedSet('mail.engineeringsolutions.co.uk')        → ['cube6', 'mail.engineeringsolutions.co.uk']
//   resolveLinkedSet('manson') (self-linked or unlinked)       → ['manson']
//
// Self-links (email_client_id = linked_external_id in customer_services) are
// the natural default for portal customers using their own row for email — the
// migration in db.js:1001 explicitly allows them. Self-links contribute no
// extra ids to the set, so the result is always [inputId] in that case.
// ─────────────────────────────────────────────────────────────────────────────
function resolveLinkedSet(emailClientId) {
  if (!emailClientId) return [];
  const id = String(emailClientId);
  const set = new Set([id]);

  // Case 1: this id IS a portal anchor that links OUT to a different email
  // row. Add that linked row to the set.
  const outward = db.prepare(`
    SELECT linked_external_id FROM customer_services
    WHERE email_client_id = ? AND service_key = 'email'
      AND linked_external_id IS NOT NULL
      AND linked_external_id != email_client_id
  `).get(id);
  if (outward?.linked_external_id) set.add(String(outward.linked_external_id));

  // Case 2: this id is linked-TO by some portal customer's email service. Add
  // that portal anchor to the set. (Same self-link exemption — a self-link
  // shouldn't pull the row into "another customer's" set.)
  const inward = db.prepare(`
    SELECT email_client_id FROM customer_services
    WHERE linked_external_id = ? AND service_key = 'email'
      AND linked_external_id != email_client_id
  `).get(id);
  if (inward?.email_client_id) set.add(String(inward.email_client_id));

  return Array.from(set);
}

// Build a `WHERE col IN (?, ?, …)` fragment + matching params array.
// Used so a single-row customer still works (one placeholder) without forking
// the SQL between the multi-row and single-row cases.
function inClause(col, ids) {
  const placeholders = ids.map(() => '?').join(', ');
  return { sql: `${col} IN (${placeholders})`, params: ids };
}

// Look up the source-inbox name for a list of email_clients ids in one query.
// Returns a Map(id → name) so the caller can attach `source_inbox_name` to
// each prospect row without N+1 queries.
function getInboxNamesByIds(ids) {
  if (!ids || ids.length === 0) return new Map();
  const uniq = Array.from(new Set(ids.map(String)));
  const placeholders = uniq.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, name FROM email_clients WHERE id IN (${placeholders})`)
    .all(...uniq);
  return new Map(rows.map(r => [String(r.id), r.name]));
}

// Resolve the "CRM customer" — i.e. which row this prospect belongs to from
// the customer-switcher's point of view. For a linked customer, that's the
// portal anchor (Cube 6), not the inbox-owning row (mail.engineering…). For
// a self-linked or unlinked customer, it's the row itself. This is what the
// admin "Open in CRM" link needs to set as `last_customer_id` so the switcher
// can find the right card.
function resolveCrmCustomerId(emailClientId) {
  if (!emailClientId) return null;
  const id = String(emailClientId);
  // If this id is linked-TO by a portal customer's email service (i.e. it's
  // the inbox row of a linked pair), return the portal anchor's id.
  const inward = db.prepare(`
    SELECT email_client_id FROM customer_services
    WHERE linked_external_id = ? AND service_key = 'email'
      AND linked_external_id != email_client_id
  `).get(id);
  if (inward?.email_client_id) return String(inward.email_client_id);
  // Otherwise the row IS the customer card (portal anchor with outward link,
  // self-linked, or unlinked).
  return id;
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

  // Expand to the full linked set: hot prospects flagged from any row that
  // belongs to the same real customer all roll into this view. For a single-
  // row customer the set is just [emailClientId] and behaviour is unchanged.
  const linkedIds = resolveLinkedSet(emailClientId);
  const inboxNames = getInboxNamesByIds(linkedIds);
  const inClient = inClause('email_client_id', linkedIds);

  const search = String(req.query.search || '').trim().toLowerCase();
  // Ordering: urgent active (overdue + due today) first, then other active
  // rows (newest added first), then converted rows at the bottom (most-
  // recently converted first). The CASE block produces a numeric sort key:
  //   0 = active and overdue (follow_up_date < today)
  //   1 = active and due today (follow_up_date == today)
  //   2 = active otherwise
  //   3 = converted (closed_at IS NOT NULL)
  // Within each bucket we sort by follow_up_date ASC where it applies (so
  // the most-overdue comes first inside bucket 0), then added_at DESC as a
  // stable tiebreak. date('now') is UTC in SQLite — see project note about
  // timezone handling; for follow-up urgency UTC midnight is "good enough"
  // (slightly aggressive in BST but not wrong).
  const orderBy = `
    CASE
      WHEN closed_at IS NOT NULL THEN 3
      WHEN follow_up_date IS NULL THEN 2
      WHEN follow_up_date < date('now') THEN 0
      WHEN follow_up_date = date('now') THEN 1
      ELSE 2
    END ASC,
    follow_up_date ASC,
    closed_at DESC,
    added_at DESC
  `;
  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = db
      .prepare(
        `SELECT id, email_client_id, prospect_email, prospect_name,
                follow_up_date, notes, added_by, added_at, updated_at,
                closed_at, closed_by
           FROM hot_prospects
          WHERE ${inClient.sql}
            AND (LOWER(COALESCE(prospect_name,'')) LIKE ? OR LOWER(prospect_email) LIKE ?)
          ORDER BY ${orderBy}`
      )
      .all(...inClient.params, like, like);
  } else {
    rows = db
      .prepare(
        `SELECT id, email_client_id, prospect_email, prospect_name,
                follow_up_date, notes, added_by, added_at, updated_at,
                closed_at, closed_by
           FROM hot_prospects
          WHERE ${inClient.sql}
          ORDER BY ${orderBy}`
      )
      .all(...inClient.params);
  }

  // Attach source_inbox_name so the frontend can render the Inbox column.
  // Also expose has_linked_inboxes so the frontend can decide whether to
  // show the column at all (decision: only when the set has > 1 row).
  const hasLinkedInboxes = linkedIds.length > 1;
  const projected = rows.map(r => ({
    ...r,
    source_inbox_name: inboxNames.get(String(r.email_client_id)) || null,
  }));

  res.json({
    prospects: projected,
    has_linked_inboxes: hasLinkedInboxes,
  });
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
  // Hide rows that are linked-TO by a portal customer's email service —
  // those rows are "covered" by the portal anchor's switcher card and would
  // otherwise appear as a duplicate badge with its own count. Self-links
  // (where linked_external_id == email_client_id) are exempt; they're the
  // natural default and shouldn't pull the row out of the switcher.
  //
  // prospect_count aggregates across the linked set so the portal anchor's
  // card shows the total prospects for the real customer — not just the
  // ones flagged directly on the anchor row. The correlated subquery walks
  // the same set logic as resolveLinkedSet() but inlined as SQL because we
  // need it computed per row in one statement.
  //
  // The filter (inherited from the previous version): include every row
  // whose source is 'aws_domain'/'manual'/null (real or unclassified email
  // customers) OR whose portal_enabled is 1 (portal customers, including
  // portal-only ones that GET /api/email/clients hides). Operator-confirmed
  // 2026-05-20 (option B).
  const rows = db.prepare(`
    SELECT
      ec.id,
      ec.name,
      ec.color,
      ec.slug,
      ec.portal_enabled,
      ec.source,
      ec.logo_url,
      (
        SELECT COUNT(*) FROM hot_prospects hp
        WHERE hp.closed_at IS NULL  /* active only — converted prospects don't count toward the badge */
          AND (
                hp.email_client_id = ec.id
             OR hp.email_client_id IN (
                  SELECT cs.linked_external_id FROM customer_services cs
                  WHERE cs.email_client_id = ec.id
                    AND cs.service_key = 'email'
                    AND cs.linked_external_id IS NOT NULL
                    AND cs.linked_external_id != cs.email_client_id
                )
             OR hp.email_client_id IN (
                  SELECT cs2.email_client_id FROM customer_services cs2
                  WHERE cs2.linked_external_id = ec.id
                    AND cs2.service_key = 'email'
                    AND cs2.linked_external_id != cs2.email_client_id
                )
          )
      ) AS prospect_count
    FROM email_clients ec
    WHERE (ec.source IS NULL
           OR ec.source IN ('aws_domain', 'manual')
           OR ec.portal_enabled = 1)
      AND NOT EXISTS (
        SELECT 1 FROM customer_services cs3
        WHERE cs3.linked_external_id = ec.id
          AND cs3.service_key = 'email'
          AND cs3.linked_external_id != cs3.email_client_id
      )
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

  // Detect insert-vs-update so the frontend can show "Added" vs "Already on
  // the list". Done as a lookup before the upsert because RETURNING doesn't
  // give us a "what kind of row this was" signal. Cheap query — the
  // (email_client_id, prospect_email) UNIQUE index makes this an O(log n)
  // index hit.
  const existing = db
    .prepare('SELECT id FROM hot_prospects WHERE email_client_id = ? AND prospect_email = ?')
    .get(emailClientId, prospectEmail);
  const wasNew = !existing;

  const id = uuid();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Upsert: if the (client, email) pair already exists, refresh the supplied
  // fields. We only overwrite name/notes/follow_up if a value was actually
  // supplied in the request body, so calling POST with just an email doesn't
  // wipe out existing notes.
  //
  // source_reply_id is COALESCEd on the update path so the first reply to
  // ever flag this prospect "wins" — re-adding the same prospect from a
  // different (newer) reply won't change the source pin. Matches the
  // formspree-flagger's pattern.
  const stmt = db.prepare(`
    INSERT INTO hot_prospects (
      id, email_client_id, prospect_email, prospect_name,
      follow_up_date, notes, added_by, added_at, updated_at,
      source_reply_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email_client_id, prospect_email) DO UPDATE SET
      prospect_name   = COALESCE(excluded.prospect_name, hot_prospects.prospect_name),
      follow_up_date  = CASE WHEN excluded.follow_up_date IS NOT NULL
                             THEN excluded.follow_up_date
                             ELSE hot_prospects.follow_up_date END,
      notes           = COALESCE(excluded.notes, hot_prospects.notes),
      source_reply_id = COALESCE(hot_prospects.source_reply_id, excluded.source_reply_id),
      updated_at      = excluded.updated_at
    RETURNING id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by, source_reply_id
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
    now,
    source_reply_id || null
  );

  // Tell the caller which switcher card this prospect will live under. For
  // a linked customer (e.g. mail.engineeringsolutions.co.uk written here but
  // appearing under Cube 6's card), that's the portal anchor's id. For an
  // unlinked/self-linked customer it's just the row itself. The frontend's
  // "Open in CRM" link uses this to set last_customer_id correctly.
  const crmCustomerId = resolveCrmCustomerId(emailClientId);

  res.json({ prospect: row, was_new: wasNew, crm_customer_id: crmCustomerId });
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
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by
         FROM hot_prospects WHERE id = ?`
    )
    .get(id);

  res.json({ prospect: row });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/email/hot-prospects/:id/mark-converted
//
// Mark a prospect as converted (became a real customer). Stamps closed_at +
// closed_by. No-op (and returns success) if the prospect is already converted
// — calling this on an already-closed row is harmless and idempotent.
//
// Converted prospects keep all their data — only their position in the list
// (pushed to bottom under a Converted divider) and the sidebar/panel badge
// counts change. They can be reopened via /reopen below.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/mark-converted', (req, res) => {
  const id = String(req.params.id || '');
  const existing = db
    .prepare('SELECT * FROM hot_prospects WHERE id = ?')
    .get(id);
  if (!existing) {
    return res.status(404).json({ error: 'prospect not found' });
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    UPDATE hot_prospects
       SET closed_at = COALESCE(closed_at, ?),
           closed_by = COALESCE(closed_by, ?),
           updated_at = ?
     WHERE id = ?
  `).run(now, 'admin', now, id);

  const row = db
    .prepare(
      `SELECT id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by
         FROM hot_prospects WHERE id = ?`
    )
    .get(id);
  res.json({ prospect: row });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/email/hot-prospects/:id/reopen
//
// Reverse a mark-converted. Clears closed_at + closed_by so the prospect goes
// back to being active. The follow-up date (if any) and notes are preserved.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/reopen', (req, res) => {
  const id = String(req.params.id || '');
  const existing = db
    .prepare('SELECT id FROM hot_prospects WHERE id = ?')
    .get(id);
  if (!existing) {
    return res.status(404).json({ error: 'prospect not found' });
  }
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    UPDATE hot_prospects
       SET closed_at = NULL, closed_by = NULL, updated_at = ?
     WHERE id = ?
  `).run(now, id);
  const row = db
    .prepare(
      `SELECT id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by
         FROM hot_prospects WHERE id = ?`
    )
    .get(id);
  res.json({ prospect: row });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/email/hot-prospects/due-counts
//
// Powers the admin sidebar badge: { overdue: N, due_today: M, total: N+M }.
// Counts active (non-converted) prospects across ALL customers — admin's
// badge is a "you have something to do somewhere in the CRM" nudge, not a
// per-customer count. The customers list separately exposes prospect_count
// per card for the in-screen per-customer counts.
//
// Light query: scans only hot_prospects with a non-null follow_up_date that's
// today or earlier and closed_at IS NULL. Partial indexes keep this fast.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/due-counts', (req, res) => {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN follow_up_date < date('now') THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN follow_up_date = date('now') THEN 1 ELSE 0 END) AS due_today
    FROM hot_prospects
    WHERE closed_at IS NULL
      AND follow_up_date IS NOT NULL
      AND follow_up_date <= date('now')
  `).get();
  const overdue = Number(row?.overdue || 0);
  const dueToday = Number(row?.due_today || 0);
  res.json({ overdue, due_today: dueToday, total: overdue + dueToday });
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
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by, source_reply_id
         FROM hot_prospects WHERE id = ?`
    )
    .get(id);
  if (!prospect) {
    return res.status(404).json({ error: 'prospect not found' });
  }

  // Expand to the full linked set so the thread shows every message we've
  // ever exchanged with this prospect, regardless of which inbox the message
  // landed in. Single-row customers are a one-element set — no change in
  // behaviour for them.
  const linkedIds = resolveLinkedSet(prospect.email_client_id);
  const inboxNames = getInboxNamesByIds(linkedIds);
  const inboundClause  = inClause('email_client_id', linkedIds);
  const outboundClause = inClause('email_client_id', linkedIds);

  // Inbound: every reply received from this address on any inbox in the
  // linked set. LOWER() comparison matches the normalisation done at write
  // time. Returning subject/body so the UI can render the thread.
  const inbound = db
    .prepare(
      `SELECT id, email_client_id, from_address, from_name, subject,
              body_text, body_html, received_at, matched_campaign_id
         FROM email_replies
        WHERE ${inboundClause.sql}
          AND LOWER(from_address) = ?
        ORDER BY received_at ASC`
    )
    .all(...inboundClause.params, prospect.prospect_email);

  // Source-reply pin (Formspree leads + any future auto-flag where the
  // hot_prospects row references a specific email_replies row whose
  // from_address does NOT equal the prospect's email — e.g. Formspree
  // submissions, where from_address is noreply@formspree.io but the actual
  // prospect's email lives in the body). If the pinned reply isn't already
  // in the address-matched inbound list, fetch it and merge it in. We pull
  // it without any address filter — the source_reply_id IS the trust signal.
  // Linked-set filter still applies so a stale id can't leak in a foreign
  // customer's reply.
  if (prospect.source_reply_id) {
    const alreadyIncluded = inbound.some(r => r.id === prospect.source_reply_id);
    if (!alreadyIncluded) {
      const sourceClause = inClause('email_client_id', linkedIds);
      const sourceRow = db
        .prepare(
          `SELECT id, email_client_id, from_address, from_name, subject,
                  body_text, body_html, received_at, matched_campaign_id
             FROM email_replies
            WHERE id = ?
              AND ${sourceClause.sql}`
        )
        .get(prospect.source_reply_id, ...sourceClause.params);
      if (sourceRow) inbound.push(sourceRow);
    }
  }

  // Outbound: every message we sent to this address from any inbox in the
  // linked set. Matches against to_address; CC chains are intentionally not
  // followed (more noise than signal).
  const outbound = db
    .prepare(
      `SELECT id, email_client_id, from_address, to_address, subject,
              body_text, body_html, sent_at, error
         FROM email_outbound
        WHERE ${outboundClause.sql}
          AND LOWER(to_address) = ?
        ORDER BY sent_at ASC`
    )
    .all(...outboundClause.params, prospect.prospect_email);

  // Merge + tag direction + sort by timestamp. Each row carries its own
  // timestamp field (received_at vs sent_at); we normalise to `at` for the
  // sort and leave the original field in place. Each message also carries
  // the source-inbox name so the UI can show "via mail.engineering…" if
  // the customer has linked inboxes (cosmetic; not currently rendered, but
  // exposed for future).
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
      source_inbox_name: inboxNames.get(String(r.email_client_id)) || null,
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
      source_inbox_name: inboxNames.get(String(o.email_client_id)) || null,
    })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  // Attach source_inbox_name + has_linked_inboxes to the prospect so the
  // detail modal can show a "From mail.engineering…" subtitle and decide
  // whether to render the Inbox column-related metadata at all.
  const prospectWithSource = {
    ...prospect,
    source_inbox_name: inboxNames.get(String(prospect.email_client_id)) || null,
    has_linked_inboxes: linkedIds.length > 1,
  };

  res.json({ prospect: prospectWithSource, thread: merged });
});

export default router;
