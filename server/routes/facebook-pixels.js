// ─────────────────────────────────────────────────────────────────────────────
// Facebook Pixels (admin side)
//
// Admin-facing endpoints for managing each customer's Meta Pixel setup record.
// Mounted at /api/facebook-pixels in server/index.js, behind the global
// requireAuth Bearer-token middleware (same as every other admin endpoint).
//
// One row per customer in the `facebook_pixels` table (see db.js), keyed by
// email_client_id — the same customer identity the rest of the portal uses.
// "Adding a pixel customer" picks an existing customer from the dropdown
// (GET /available-customers), stores their Meta details, AND records a
// customer_services subscription (service_key='facebook_pixels') so the
// customer's portal shows the service as theirs. The customer-portal side
// (their own tracking view, tenant-scoped) is a separate stage.
//
// The actual Meta work (pixel, Conversions API, domain verification, events,
// campaigns) happens in Business Manager — this is Studio's management record.
// Live campaign numbers are NOT held here; that's Phase B (pulled from Meta).
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { metaConfigured, getPixelStats, listPixels } from '../services/meta-api.js';

const router = express.Router();
router.use(requireAuth);

const GOALS = ['leads', 'sales'];
const STATUSES = ['not_started', 'in_setup', 'active'];

// Columns the operator can write via POST/PUT. Anything else in the body is
// ignored — no accidental writes to id / email_client_id / timestamps.
const WRITABLE = [
  'business_id', 'ad_account_id', 'pixel_id', 'pixel_name', 'domain',
  'domain_verified', 'facebook_page', 'goal', 'conversion_event',
  'status', 'checklist_json', 'notes',
];

// Normalise a checklist value (object or string) to a JSON string for storage.
function toChecklistJson(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') {
    try { JSON.parse(val); return val; } catch { return null; }
  }
  try { return JSON.stringify(val); } catch { return null; }
}

// Shape one row for the API response — parse checklist_json back to an object
// so the frontend never has to JSON.parse, and coerce the boolean.
function shape(row) {
  if (!row) return row;
  let checklist = {};
  if (row.checklist_json) {
    try { checklist = JSON.parse(row.checklist_json); } catch { checklist = {}; }
  }
  return {
    ...row,
    domain_verified: !!row.domain_verified,
    checklist,
  };
}

// ── LIST ───────────────────────────────────────────────────────────────────
// Roster of pixel customers. Joins email_clients for the display name.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT fp.*, ec.name AS customer_name
    FROM facebook_pixels fp
    JOIN email_clients ec ON ec.id = fp.email_client_id
    ORDER BY ec.name COLLATE NOCASE ASC
  `).all();
  res.json(rows.map(shape));
});

// ── AVAILABLE CUSTOMERS (for the add dropdown) ───────────────────────────────
// Existing, non-hidden customers that aren't already a pixel customer.
router.get('/available-customers', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name
    FROM email_clients
    WHERE (hidden_at IS NULL)
      AND id NOT IN (SELECT email_client_id FROM facebook_pixels)
      AND id NOT IN (
        SELECT linked_external_id FROM customer_services
        WHERE linked_external_id IS NOT NULL AND email_client_id != linked_external_id
      )
    ORDER BY name COLLATE NOCASE ASC
  `).all();
  res.json(rows);
});

// ── AVAILABLE PIXELS (from Meta) ─────────────────────────────────────────────
// Lists the Meta Pixels in the business so the admin can pick one instead of
// typing the ID. Must sit before GET /:id (a literal path, not an :id). Always
// 200: { ok:true, pixels:[...] } or { ok:false, error, pixels:[] } so the UI
// can fall back to manual entry without breaking.
router.get('/available-pixels', async (req, res) => {
  if (!metaConfigured()) {
    return res.json({ ok: false, configured: false, error: 'Meta API is not configured.', pixels: [] });
  }
  try {
    const pixels = await listPixels();
    res.json({ ok: true, configured: true, pixels });
  } catch (err) {
    res.json({ ok: false, configured: true, error: err && err.message ? err.message : String(err), pixels: [] });
  }
});

// ── DETAIL ───────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT fp.*, ec.name AS customer_name
    FROM facebook_pixels fp
    JOIN email_clients ec ON ec.id = fp.email_client_id
    WHERE fp.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(shape(row));
});

// ── LIVE STATS (read-only pixel activity) ────────────────────────────────────
// Anonymous aggregate event counts from the customer's Meta Pixel — no personal
// or contact data (Meta doesn't expose that). Always 200; clean flags drive the
// UI:  no_pixel (none set yet) · ok:false (Meta error) · ok:true (counts).
router.get('/:id/stats', async (req, res) => {
  const row = db.prepare(
    'SELECT pixel_id, goal, conversion_event FROM facebook_pixels WHERE id = ?'
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const window = ['7d', '30d', 'lifetime'].includes(req.query.window) ? req.query.window : '30d';

  if (!metaConfigured()) {
    return res.json({ ok: false, configured: false, window, error: 'Meta API is not configured.' });
  }
  if (!row.pixel_id) {
    return res.json({ ok: true, configured: true, no_pixel: true, window, events: [] });
  }

  const stats = await getPixelStats({ pixelId: row.pixel_id, window });
  res.json({ configured: true, goal: row.goal, conversion_event: row.conversion_event, ...stats });
});

// ── ADD ───────────────────────────────────────────────────────────────────
// Body: email_client_id (required) + any WRITABLE fields. Creates the pixel
// record AND a customer_services subscription so the portal recognises it.
router.post('/', (req, res) => {
  const b = req.body || {};
  const emailClientId = b.email_client_id;
  if (!emailClientId) return res.status(400).json({ error: 'email_client_id is required' });

  const customer = db.prepare('SELECT id, name FROM email_clients WHERE id = ?').get(emailClientId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const existing = db.prepare('SELECT id FROM facebook_pixels WHERE email_client_id = ?').get(emailClientId);
  if (existing) return res.status(409).json({ error: 'This customer is already a pixel customer', id: existing.id });

  const goal = GOALS.includes(b.goal) ? b.goal : 'leads';
  const status = STATUSES.includes(b.status) ? b.status : 'not_started';

  const id = uuid();
  db.prepare(`
    INSERT INTO facebook_pixels
      (id, email_client_id, business_id, ad_account_id, pixel_id, pixel_name,
       domain, domain_verified, facebook_page, goal, conversion_event,
       status, checklist_json, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, emailClientId,
    b.business_id || null, b.ad_account_id || null, b.pixel_id || null, b.pixel_name || null,
    b.domain || null, b.domain_verified ? 1 : 0, b.facebook_page || null,
    goal, b.conversion_event || null,
    status, toChecklistJson(b.checklist_json), b.notes || null,
  );

  // Record the subscription so the customer's portal shows the service as theirs.
  // INSERT OR IGNORE against the unique (email_client_id, service_key) index —
  // safe if a subscription somehow already exists.
  db.prepare(`
    INSERT OR IGNORE INTO customer_services (email_client_id, service_key, linked_external_id, enabled_by)
    VALUES (?, 'facebook_pixels', NULL, 'admin')
  `).run(emailClientId);

  const row = db.prepare(`
    SELECT fp.*, ec.name AS customer_name
    FROM facebook_pixels fp JOIN email_clients ec ON ec.id = fp.email_client_id
    WHERE fp.id = ?
  `).get(id);
  res.json(shape(row));
});

// ── UPDATE ───────────────────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM facebook_pixels WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  if (b.goal !== undefined && !GOALS.includes(b.goal)) {
    return res.status(400).json({ error: 'Invalid goal' });
  }
  if (b.status !== undefined && !STATUSES.includes(b.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const sets = [];
  const vals = [];
  for (const col of WRITABLE) {
    if (b[col] === undefined) continue;
    if (col === 'domain_verified') { sets.push('domain_verified = ?'); vals.push(b.domain_verified ? 1 : 0); }
    else if (col === 'checklist_json') { sets.push('checklist_json = ?'); vals.push(toChecklistJson(b.checklist_json)); }
    else { sets.push(`${col} = ?`); vals.push(b[col] === null ? null : String(b[col])); }
  }
  if (sets.length === 0) return res.json(shape(existing));

  sets.push("updated_at = datetime('now')");
  vals.push(req.params.id);
  db.prepare(`UPDATE facebook_pixels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  const row = db.prepare(`
    SELECT fp.*, ec.name AS customer_name
    FROM facebook_pixels fp JOIN email_clients ec ON ec.id = fp.email_client_id
    WHERE fp.id = ?
  `).get(req.params.id);
  res.json(shape(row));
});

// ── REMOVE ───────────────────────────────────────────────────────────────────
// Deletes the pixel record and the customer_services subscription so the
// customer no longer sees the service. The customer record itself is untouched.
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT email_client_id FROM facebook_pixels WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM facebook_pixels WHERE id = ?').run(req.params.id);
  db.prepare(`DELETE FROM customer_services WHERE email_client_id = ? AND service_key = 'facebook_pixels'`)
    .run(existing.email_client_id);

  res.json({ ok: true });
});

export default router;
