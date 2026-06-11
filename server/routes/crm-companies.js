/**
 * crm-companies.js — Sales CRM company records (Phase 2)
 *
 * Mounted at /api/crm/companies. Gated by requireAccess('crm_companies') —
 * the super-admin always passes; a staff member needs the "Sales CRM —
 * companies" box ticked.
 *
 * TENANT: this file serves The Green Agents' own pipeline (tenant='tga').
 * Each customer's private CRM is the same tables scoped to their own tenant —
 * wired in the customer-portal phase. Keeping the tenant in one constant here
 * means the customer-portal version just resolves a different value.
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAccess } from '../middleware/auth.js';
import { logHistory } from './crm-history.js';

const router = Router();
router.use(requireAccess('crm_companies'));

const TENANT = 'tga';
const STATUSES = ['suspect', 'prospect', 'hot_prospect', 'customer'];
const STATUS_LABEL = { suspect: 'Suspect', prospect: 'Prospect', hot_prospect: 'Hot prospect', customer: 'Customer' };
function superName() { return process.env.STUDIO_USERNAME || 'Admin'; }

// Resolve account_manager_id → display name (super sentinel, staff row, or unassigned)
function managerName(id, amUsername) {
  if (id === '__super__') return superName();
  if (id && amUsername) return amUsername;
  return null; // unassigned, or owner row deleted
}

function project(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    account_manager_id: row.account_manager_id || null,
    account_manager_name: managerName(row.account_manager_id, row.am_username),
    website: row.website || null,
    phone: row.phone || null,
    address: row.address || null,
    town: row.town || null,
    postcode: row.postcode || null,
    category: row.category || null,
    source: row.source || null,
    notes: row.notes || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Validate an incoming account_manager_id → a storable value or null.
function resolveManagerId(raw) {
  if (!raw) return null;
  if (raw === '__super__') return '__super__';
  const exists = db.prepare(`SELECT id FROM admin_users WHERE id = ?`).get(raw);
  return exists ? raw : null;
}

const LIST_SELECT = `
  SELECT c.*, au.username AS am_username
  FROM crm_companies c
  LEFT JOIN admin_users au ON au.id = c.account_manager_id
`;

// GET /assignees — who a company can be assigned to (super + active staff).
// Available to any CRM user (not super-only) so the owner dropdown populates.
router.get('/assignees', (_req, res) => {
  const staff = db.prepare(`SELECT id, username FROM admin_users WHERE disabled_at IS NULL ORDER BY LOWER(username)`).all();
  res.json({
    assignees: [
      { id: '__super__', name: superName() },
      ...staff.map(s => ({ id: s.id, name: s.username })),
    ],
  });
});

// GET / — list + per-status counts. Optional ?status= and ?q=.
router.get('/', (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const q = (req.query.q || '').trim().toLowerCase();

  const where = ['c.tenant = ?'];
  const args = [TENANT];
  if (status) { where.push('c.status = ?'); args.push(status); }
  if (q) {
    where.push('(LOWER(c.name) LIKE ? OR LOWER(c.town) LIKE ? OR LOWER(c.postcode) LIKE ? OR LOWER(au.username) LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const rows = db.prepare(`${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC`).all(...args);

  const counts = { all: 0, suspect: 0, prospect: 0, hot_prospect: 0, customer: 0 };
  for (const r of db.prepare(`SELECT status, COUNT(*) n FROM crm_companies WHERE tenant=? GROUP BY status`).all(TENANT)) {
    if (counts[r.status] != null) counts[r.status] = r.n;
    counts.all += r.n;
  }
  res.json({ companies: rows.map(project), counts });
});

// GET /:id
router.get('/:id', (req, res) => {
  const row = db.prepare(`${LIST_SELECT} WHERE c.tenant = ? AND c.id = ?`).get(TENANT, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ company: project(row) });
});

// POST / — create
router.post('/', (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Company name is required' });
  const status = STATUSES.includes(b.status) ? b.status : 'suspect';
  const id = uuid();
  db.prepare(`
    INSERT INTO crm_companies
      (id, tenant, name, status, account_manager_id, website, phone, address, town, postcode, category, source, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, name, status, resolveManagerId(b.account_manager_id),
    (b.website || '').trim() || null, (b.phone || '').trim() || null,
    (b.address || '').trim() || null, (b.town || '').trim() || null,
    (b.postcode || '').trim() || null, (b.category || '').trim() || null,
    (b.source || '').trim() || null, (b.notes || '').trim() || null,
  );
  const row = db.prepare(`${LIST_SELECT} WHERE c.id = ?`).get(id);
  res.json({ ok: true, company: project(row) });
});

// PUT /:id — update any field(s). Only keys present in the body are changed.
router.put('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM crm_companies WHERE tenant = ? AND id = ?`).get(TENANT, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};

  const name = b.name != null ? String(b.name).trim() : row.name;
  if (!name) return res.status(400).json({ error: 'Company name is required' });
  const status = b.status != null ? (STATUSES.includes(b.status) ? b.status : row.status) : row.status;
  const account_manager_id = b.account_manager_id !== undefined ? resolveManagerId(b.account_manager_id) : row.account_manager_id;

  const txt = (k) => (b[k] !== undefined ? (String(b[k]).trim() || null) : row[k]);

  db.prepare(`
    UPDATE crm_companies SET
      name=?, status=?, account_manager_id=?, website=?, phone=?, address=?, town=?, postcode=?, category=?, source=?, notes=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    name, status, account_manager_id,
    txt('website'), txt('phone'), txt('address'), txt('town'), txt('postcode'),
    txt('category'), txt('source'), txt('notes'), row.id,
  );
  const updated = db.prepare(`${LIST_SELECT} WHERE c.id = ?`).get(row.id);

  // Auto-log a status change onto the company timeline (audit trail).
  if (status !== row.status) {
    const who = req.adminUser ? req.adminUser.username : null;
    logHistory(row.id, TENANT, 'status_change', `Moved from ${STATUS_LABEL[row.status] || row.status} to ${STATUS_LABEL[status] || status}`, who);
  }

  res.json({ ok: true, company: project(updated) });
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  const row = db.prepare(`SELECT id FROM crm_companies WHERE tenant = ? AND id = ?`).get(TENANT, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM crm_contacts WHERE company_id = ?`).run(row.id);
  db.prepare(`DELETE FROM crm_history WHERE company_id = ?`).run(row.id);
  db.prepare(`DELETE FROM crm_tasks WHERE company_id = ?`).run(row.id);
  db.prepare(`DELETE FROM crm_companies WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

export default router;
