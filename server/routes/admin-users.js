/**
 * admin-users.js — Studio staff accounts + per-section access (SUPER-ADMIN only)
 *
 * Mounted at /api/admin-users. Every route requires super-admin (the env
 * break-glass login, or an is_super staff member). Regular staff never reach
 * these endpoints.
 *
 * Passwords are bcrypt (cost 12). They're never returned after creation/reset
 * except the one-time plaintext shown immediately so the super-admin can pass
 * it to the staff member out-of-band — same trust model as the customer portal
 * (blueprint #60): we can CHANGE a password, never REVEAL an existing one.
 */
import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireSuperAdmin } from '../middleware/auth.js';

const router = Router();
const BCRYPT_COST = 12;
const MIN_PW = 8;

// ── Canonical sidebar sections — the single source of truth for the tickbox
//    grid. The frontend renders the access grid from GET /sections so the two
//    never drift. Order + grouping mirror the live admin sidebar.
const SECTIONS = [
  { group: 'Social media',    key: 'linkedin_posts',     label: 'LinkedIn posts' },
  { group: 'Social media',    key: 'instagram',          label: 'Instagram' },
  { group: 'Social media',    key: 'tiktok',             label: 'TikTok' },
  { group: 'Social media',    key: 'meta_pixels',        label: 'Meta pixels' },
  { group: 'Social media',    key: 'facebook_ads',       label: 'Facebook ads' },
  { group: 'Email campaigns', key: 'customers',          label: 'Customers' },
  { group: 'Email campaigns', key: 'domain_health',      label: 'Domain health' },
  { group: 'Email campaigns', key: 'mailboxes',          label: 'Mailboxes' },
  { group: 'Customer portal', key: 'portal_customers',   label: 'Portal customers' },
  { group: 'CRM',             key: 'email_hot_prospects', label: 'E-mail campaign hot prospects' },
  { group: 'CRM',             key: 'crm_companies',       label: 'Sales CRM — companies' },
  { group: 'CRM',             key: 'crm_tasks',           label: 'Sales CRM — tasks' },
  { group: 'CRM',             key: 'crm_deals',           label: 'Sales CRM — deals' },
  { group: 'CRM',             key: 'crm_orders',          label: 'Sales CRM — orders' },
  { group: 'CRM',             key: 'crm_approvals',       label: 'Sales CRM — approval queue' },
  { group: 'CRM',             key: 'crm_purchasing',      label: 'Sales CRM — purchasing queue' },
  { group: 'App',             key: 'idyq',                label: 'IDYQ' },
];
const VALID_KEYS = new Set(SECTIONS.map(s => s.key));

router.use(requireSuperAdmin);

function genTempPassword() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

function sanitizeAccess(input) {
  const out = {};
  if (input && typeof input === 'object') {
    for (const k of Object.keys(input)) {
      if (VALID_KEYS.has(k) && input[k]) out[k] = true;
    }
  }
  return out;
}

function projectStaff(row) {
  let access = {};
  try { access = JSON.parse(row.access_json || '{}'); } catch { access = {}; }
  return {
    id: row.id,
    username: row.username,
    email: row.email || null,
    is_super: row.is_super ? 1 : 0,
    access,
    disabled: row.disabled_at ? 1 : 0,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at,
  };
}

// GET /sections — tickbox catalogue
router.get('/sections', (_req, res) => res.json({ sections: SECTIONS }));

// GET / — list staff. The env break-glass super is implicit (not a row here);
// the frontend shows the signed-in user separately from this list.
router.get('/', (_req, res) => {
  const rows = db.prepare(`SELECT * FROM admin_users ORDER BY LOWER(username) ASC`).all();
  res.json({ users: rows.map(projectStaff), sections: SECTIONS });
});

// POST / — create staff. password optional (random temp if absent).
router.post('/', async (req, res) => {
  const username = (req.body?.username || '').trim();
  const email = (req.body?.email || '').trim() || null;
  const is_super = req.body?.is_super ? 1 : 0;
  const access = is_super ? {} : sanitizeAccess(req.body?.access);

  if (!username) return res.status(400).json({ error: 'Username is required' });
  const dupe = db.prepare(`SELECT id FROM admin_users WHERE LOWER(username) = LOWER(?)`).get(username);
  if (dupe) return res.status(409).json({ error: 'That username is already taken' });

  let pw = req.body?.password;
  let kind = 'admin_chosen';
  if (!pw) { pw = genTempPassword(); kind = 'random'; }
  if (String(pw).length < MIN_PW) return res.status(400).json({ error: `Password must be at least ${MIN_PW} characters` });

  const hash = await bcrypt.hash(String(pw), BCRYPT_COST);
  const id = uuid();
  db.prepare(`
    INSERT INTO admin_users (id, username, email, password_hash, is_super, access_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, username, email, hash, is_super, JSON.stringify(access));

  const row = db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(id);
  res.json({ ok: true, user: projectStaff(row), password: pw, password_kind: kind });
});

// GET /:id
router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ user: projectStaff(row), sections: SECTIONS });
});

// PUT /:id — update profile / access / super / disabled (NOT password)
router.put('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const username = req.body?.username != null ? String(req.body.username).trim() : row.username;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (username.toLowerCase() !== row.username.toLowerCase()) {
    const dupe = db.prepare(`SELECT id FROM admin_users WHERE LOWER(username) = LOWER(?) AND id != ?`).get(username, row.id);
    if (dupe) return res.status(409).json({ error: 'That username is already taken' });
  }
  const email = req.body?.email != null ? (String(req.body.email).trim() || null) : row.email;
  const is_super = req.body?.is_super != null ? (req.body.is_super ? 1 : 0) : row.is_super;

  let existingAccess = {};
  try { existingAccess = JSON.parse(row.access_json || '{}'); } catch { existingAccess = {}; }
  const access = is_super ? {} : sanitizeAccess(req.body?.access != null ? req.body.access : existingAccess);

  let disabled_at = row.disabled_at;
  if (req.body?.disabled != null) {
    disabled_at = req.body.disabled
      ? (row.disabled_at || db.prepare(`SELECT datetime('now') AS t`).get().t)
      : null;
  }

  db.prepare(`
    UPDATE admin_users SET username=?, email=?, is_super=?, access_json=?, disabled_at=? WHERE id=?
  `).run(username, email, is_super, JSON.stringify(access), disabled_at, row.id);

  if (disabled_at) db.prepare(`DELETE FROM admin_sessions WHERE admin_user_id=?`).run(row.id);

  const updated = db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(row.id);
  res.json({ ok: true, user: projectStaff(updated) });
});

// POST /:id/reset-password — admin-chosen or random; shows once; kills sessions
router.post('/:id/reset-password', async (req, res) => {
  const row = db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  let pw = req.body?.new_password;
  let kind = 'admin_chosen';
  if (!pw) { pw = genTempPassword(); kind = 'random'; }
  if (String(pw).length < MIN_PW) return res.status(400).json({ error: `Password must be at least ${MIN_PW} characters` });

  const hash = await bcrypt.hash(String(pw), BCRYPT_COST);
  db.prepare(`UPDATE admin_users SET password_hash=?, last_login_at=NULL WHERE id=?`).run(hash, row.id);
  db.prepare(`DELETE FROM admin_sessions WHERE admin_user_id=?`).run(row.id);
  res.json({ ok: true, password: pw, password_kind: kind });
});

// DELETE /:id — remove staff + their sessions
router.delete('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM admin_sessions WHERE admin_user_id=?`).run(row.id);
  db.prepare(`DELETE FROM admin_users WHERE id=?`).run(row.id);
  res.json({ ok: true });
});

export default router;
