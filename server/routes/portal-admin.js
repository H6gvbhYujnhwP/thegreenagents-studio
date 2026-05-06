/**
 * portal-admin.js — Admin-side endpoints for managing the customer portal.
 *
 * Mounted at /api/portal-admin in server/index.js. All routes require the
 * existing admin Bearer-token (requireAuth middleware) — these are NOT used
 * by the customer-facing portal. The admin uses these to:
 *   - List all email_clients (customers) with portal stats
 *   - Toggle service subscriptions (Email enabled, LinkedIn linked, etc.)
 *   - Manage portal users for each customer (add / remove / reset password)
 *   - List LinkedIn-side `clients` for the LinkedIn-link dropdown
 *
 * Note the path: /api/portal-admin (NOT /api/portal). The fetch interceptor
 * in src/App.jsx excludes /api/portal/* from the admin Bearer token because
 * those are customer-portal routes. /api/portal-admin/* is a separate prefix
 * that DOES get the Bearer token, since it's admin-only.
 */
import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const BCRYPT_COST = 12;

// All routes below require admin auth — apply once at the router level.
router.use(requireAuth);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a memorable temporary password — 12 chars, mixed case + digits, no
 * confusable characters (0/O, 1/l/I). Wez sees this once and reads it to the
 * customer over the phone, so easier to communicate than "$2b$12$abc...".
 */
function genTempPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz';
  let out = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Public projection of an email_clients row with portal stats. The stats
 * (user count, has linkedin link) help the admin grid show "0 users" warnings
 * etc. without N+1 queries from the frontend.
 */
function projectCustomer(row) {
  const userCount = db.prepare(
    `SELECT COUNT(*) AS n FROM client_users WHERE email_client_id = ?`
  ).get(row.id).n;

  // Resolve linked LinkedIn client name (if any) so the frontend can display
  // it without a second lookup.
  let linkedinClientName = null;
  if (row.linkedin_client_id) {
    const lc = db.prepare(`SELECT name FROM clients WHERE id = ?`).get(row.linkedin_client_id);
    linkedinClientName = lc ? lc.name : '(deleted LinkedIn client)';
  }

  return {
    id:                       row.id,
    name:                     row.name,
    slug:                     row.slug,
    color:                    row.color,
    portal_user_count:        userCount,
    service_email_enabled:    !!row.service_email_enabled,
    linkedin_client_id:       row.linkedin_client_id || null,
    linkedin_client_name:     linkedinClientName,
    // facebook_page_id: row.facebook_page_id || null,   // when shipped
  };
}

function projectUser(row) {
  return {
    id:            row.id,
    username:      row.username,
    email:         row.email,
    role:          row.role,
    created_at:    row.created_at,
    last_login_at: row.last_login_at,
  };
}

// ─── 1. GET /api/portal-admin/customers ───────────────────────────────────────
// List all email_clients with portal stats. Used by the Portal Customers
// admin page as the main list view.
router.get('/customers', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM email_clients ORDER BY name COLLATE NOCASE ASC
  `).all();
  res.json(rows.map(projectCustomer));
});

// ─── 2. GET /api/portal-admin/customers/:id ───────────────────────────────────
// Single-customer detail view (services + users in one payload to avoid
// flicker when opening the manage panel).
router.get('/customers/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM email_clients WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const users = db.prepare(`
    SELECT * FROM client_users WHERE email_client_id = ? ORDER BY username ASC
  `).all(req.params.id);

  res.json({
    customer: projectCustomer(row),
    users: users.map(projectUser),
  });
});

// ─── 3. PUT /api/portal-admin/customers/:id/services ──────────────────────────
// body: { service_email_enabled?: boolean, linkedin_client_id?: string|null }
// Updates one or both service-subscription flags. Frontend sends only the
// fields that changed to keep the audit trail clean if we add one later.
//
// Validates that linkedin_client_id (if provided non-null) actually exists
// in the LinkedIn `clients` table — otherwise returns 400. The UNIQUE index
// on email_clients.linkedin_client_id catches the "already linked elsewhere"
// case at SQLite level; we surface that as a friendly 409.
router.put('/customers/:id/services', (req, res) => {
  const cur = db.prepare(`SELECT * FROM email_clients WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};
  const updates = [];
  const params = [];

  if ('service_email_enabled' in body) {
    updates.push('service_email_enabled = ?');
    params.push(body.service_email_enabled ? 1 : 0);
  }

  if ('linkedin_client_id' in body) {
    const lcId = body.linkedin_client_id;
    if (lcId !== null && lcId !== '') {
      // Verify the LinkedIn client exists.
      const lc = db.prepare(`SELECT id FROM clients WHERE id = ?`).get(lcId);
      if (!lc) return res.status(400).json({ error: 'LinkedIn client not found' });
      updates.push('linkedin_client_id = ?');
      params.push(lcId);
    } else {
      updates.push('linkedin_client_id = NULL');
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No service fields provided' });
  }

  params.push(req.params.id);
  try {
    db.prepare(`UPDATE email_clients SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  } catch (e) {
    if (String(e.message).includes('UNIQUE') && String(e.message).includes('linkedin_client_id')) {
      return res.status(409).json({
        error: 'That LinkedIn account is already linked to another customer. Unlink it there first.'
      });
    }
    throw e;
  }

  const updated = db.prepare(`SELECT * FROM email_clients WHERE id = ?`).get(req.params.id);
  res.json(projectCustomer(updated));
});

// ─── 4. GET /api/portal-admin/customers/:id/users ─────────────────────────────
// List portal users for a customer.
router.get('/customers/:id/users', (req, res) => {
  const customer = db.prepare(`SELECT id FROM email_clients WHERE id = ?`).get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const rows = db.prepare(`
    SELECT * FROM client_users WHERE email_client_id = ? ORDER BY username ASC
  `).all(req.params.id);
  res.json(rows.map(projectUser));
});

// ─── 5. POST /api/portal-admin/customers/:id/users ────────────────────────────
// body: { username, email?, role: 'admin' | 'viewer' }
// Creates a portal user with a generated 12-char temporary password. The
// response includes the temp password ONCE (plaintext) so Wez can give it
// to the customer. After this response is sent, the password is unrecoverable
// — only the bcrypt hash is stored. last_login_at stays NULL so the portal's
// "Your password is temporary" banner shows on first sign-in.
router.post('/customers/:id/users', async (req, res) => {
  const customer = db.prepare(`SELECT id FROM email_clients WHERE id = ?`).get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const { username = '', email = '', role = 'viewer' } = req.body || {};
  const u = String(username).trim().toLowerCase();
  const e = String(email || '').trim().toLowerCase() || null;
  if (!u) return res.status(400).json({ error: 'Username is required' });
  if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(u)) {
    return res.status(400).json({
      error: 'Username must be 2–31 chars, lowercase letters/digits/._- only, starting with a letter or digit'
    });
  }
  if (!['admin', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or viewer' });
  }

  const tempPw = genTempPassword();
  const hash = await bcrypt.hash(tempPw, BCRYPT_COST);
  const id = `cu_${uuid()}`;

  try {
    db.prepare(`
      INSERT INTO client_users (id, email_client_id, username, email, password_hash, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, u, e, hash, role);
  } catch (err) {
    if (String(err.message).includes('UNIQUE') && String(err.message).includes('username')) {
      return res.status(409).json({ error: `A user with username "${u}" already exists for this customer.` });
    }
    throw err;
  }

  const row = db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(id);
  res.json({
    user: projectUser(row),
    temporary_password: tempPw,   // ONLY returned at creation time. Never stored plaintext.
  });
});

// ─── 6. DELETE /api/portal-admin/users/:id ────────────────────────────────────
// Removes a portal user. Also clears their sessions, password resets, and
// failed-login records so the table cleanup is tidy.
router.delete('/users/:id', (req, res) => {
  const row = db.prepare(`SELECT id, email_client_id, username FROM client_users WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.transaction(() => {
    db.prepare(`DELETE FROM client_sessions WHERE client_user_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM password_resets  WHERE client_user_id = ?`).run(req.params.id);
    db.prepare(`
      DELETE FROM client_login_attempts
      WHERE email_client_id = ? AND username = ?
    `).run(row.email_client_id, row.username);
    db.prepare(`DELETE FROM client_users WHERE id = ?`).run(req.params.id);
  })();
  res.json({ ok: true });
});

// ─── 7. POST /api/portal-admin/users/:id/reset-password ───────────────────────
// Admin sets a new temporary password for a portal user (used when a customer
// forgets theirs and wants Wez to reset it out-of-band rather than going
// through the email reset link).
//
// Side effects:
//   - All existing sessions for the user are killed (forces fresh sign-in
//     with the new temp password).
//   - last_login_at is reset to NULL so the "Your password is temporary"
//     banner appears again on next sign-in.
//   - Any pending email-link reset tokens are invalidated.
router.post('/users/:id/reset-password', async (req, res) => {
  const row = db.prepare(`SELECT * FROM client_users WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const tempPw = genTempPassword();
  const hash   = await bcrypt.hash(tempPw, BCRYPT_COST);

  db.transaction(() => {
    db.prepare(`
      UPDATE client_users SET password_hash = ?, last_login_at = NULL WHERE id = ?
    `).run(hash, req.params.id);
    db.prepare(`DELETE FROM client_sessions WHERE client_user_id = ?`).run(req.params.id);
    db.prepare(`
      UPDATE password_resets SET used_at = datetime('now')
      WHERE client_user_id = ? AND used_at IS NULL
    `).run(req.params.id);
  })();

  res.json({
    ok: true,
    temporary_password: tempPw,
  });
});

// ─── 8. GET /api/portal-admin/linkedin-clients ────────────────────────────────
// List LinkedIn-side `clients` for the "LinkedIn account" dropdown in the
// Services panel. Includes a flag indicating which ones are already linked
// to another email_client so the dropdown can grey those out (or omit them).
router.get('/linkedin-clients', (req, res) => {
  const rows = db.prepare(`
    SELECT
      c.id,
      c.name,
      c.brand,
      ec.id   AS linked_to_id,
      ec.name AS linked_to_name,
      ec.slug AS linked_to_slug
    FROM clients c
    LEFT JOIN email_clients ec ON ec.linkedin_client_id = c.id
    ORDER BY c.name COLLATE NOCASE ASC
  `).all();
  res.json(rows.map(r => ({
    id:             r.id,
    name:           r.name,
    brand:          r.brand,
    linked_to_id:   r.linked_to_id   || null,
    linked_to_name: r.linked_to_name || null,
    linked_to_slug: r.linked_to_slug || null,
  })));
});

export default router;
