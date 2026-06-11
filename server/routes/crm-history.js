/**
 * crm-history.js — activity timeline per Sales CRM company (Phase 4)
 *
 * Mounted at /api/crm/history. Gated by requireAccess('crm_companies') —
 * history is part of the company record. Scoped to tenant='tga'. Manual
 * entries (note/call/email/meeting) are stamped with the logged-in user's
 * name. Auto entries (status_change, etc.) are written by other routes.
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAccess } from '../middleware/auth.js';

const router = Router();
router.use(requireAccess('crm_companies'));

const TENANT = 'tga';
const MANUAL_KINDS = ['note', 'call', 'email', 'meeting'];

function companyInTenant(id) {
  return db.prepare(`SELECT id FROM crm_companies WHERE id = ? AND tenant = ?`).get(id, TENANT);
}

// Shared helper so other routes can drop an auto entry on the timeline.
export function logHistory(companyId, tenant, kind, body, author) {
  db.prepare(`INSERT INTO crm_history (id, company_id, tenant, kind, body, author) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(uuid(), companyId, tenant, kind, body, author || null);
}

function project(r) {
  return { id: r.id, company_id: r.company_id, kind: r.kind, body: r.body, author: r.author || null, created_at: r.created_at };
}

// GET /?company_id= — newest first
router.get('/', (req, res) => {
  const companyId = req.query.company_id || '';
  if (!companyInTenant(companyId)) return res.status(404).json({ error: 'Company not found' });
  const rows = db.prepare(`SELECT * FROM crm_history WHERE company_id = ? AND tenant = ? ORDER BY created_at DESC`).all(companyId, TENANT);
  res.json({ history: rows.map(project) });
});

// POST / — log a manual entry
router.post('/', (req, res) => {
  const b = req.body || {};
  const companyId = b.company_id || '';
  if (!companyInTenant(companyId)) return res.status(404).json({ error: 'Company not found' });
  const kind = MANUAL_KINDS.includes(b.kind) ? b.kind : 'note';
  const body = (b.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Please type what happened' });
  const author = req.adminUser ? req.adminUser.username : null;
  logHistory(companyId, TENANT, kind, body, author);
  const row = db.prepare(`SELECT * FROM crm_history WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`).get(companyId);
  res.json({ ok: true, entry: project(row) });
});

// DELETE /:id — remove a mistaken entry
router.delete('/:id', (req, res) => {
  const row = db.prepare(`SELECT id FROM crm_history WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM crm_history WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

export default router;
