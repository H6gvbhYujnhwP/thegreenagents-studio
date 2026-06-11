/**
 * crm-contacts.js — people within a Sales CRM company (Phase 3)
 *
 * Mounted at /api/crm/contacts. Gated by requireAccess('crm_companies') —
 * contacts are part of the company record, so they share the companies
 * access tick. Scoped to tenant='tga' (the customer-portal phase resolves a
 * different tenant). Every call verifies the parent company is in this tenant
 * before touching its contacts.
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAccess } from '../middleware/auth.js';

const router = Router();
router.use(requireAccess('crm_companies'));

const TENANT = 'tga';

function companyInTenant(companyId) {
  return db.prepare(`SELECT id FROM crm_companies WHERE id = ? AND tenant = ?`).get(companyId, TENANT);
}

function project(r) {
  return {
    id: r.id,
    company_id: r.company_id,
    name: r.name,
    role: r.role || null,
    email: r.email || null,
    phone: r.phone || null,
    is_decision_maker: r.is_decision_maker ? 1 : 0,
  };
}

// GET /?company_id=  — contacts for one company (decision-makers first)
router.get('/', (req, res) => {
  const companyId = req.query.company_id || '';
  if (!companyInTenant(companyId)) return res.status(404).json({ error: 'Company not found' });
  const rows = db.prepare(`
    SELECT * FROM crm_contacts WHERE company_id = ? AND tenant = ?
    ORDER BY is_decision_maker DESC, LOWER(name) ASC
  `).all(companyId, TENANT);
  res.json({ contacts: rows.map(project) });
});

// POST /  — add a contact
router.post('/', (req, res) => {
  const b = req.body || {};
  const companyId = b.company_id || '';
  if (!companyInTenant(companyId)) return res.status(404).json({ error: 'Company not found' });
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Contact name is required' });
  const id = uuid();
  db.prepare(`
    INSERT INTO crm_contacts (id, company_id, tenant, name, role, email, phone, is_decision_maker)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, TENANT, name,
    (b.role || '').trim() || null, (b.email || '').trim() || null,
    (b.phone || '').trim() || null, b.is_decision_maker ? 1 : 0);
  res.json({ ok: true, contact: project(db.prepare(`SELECT * FROM crm_contacts WHERE id = ?`).get(id)) });
});

// PUT /:id
router.put('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM crm_contacts WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const name = b.name != null ? String(b.name).trim() : row.name;
  if (!name) return res.status(400).json({ error: 'Contact name is required' });
  const txt = (k) => (b[k] !== undefined ? (String(b[k]).trim() || null) : row[k]);
  const dm = b.is_decision_maker !== undefined ? (b.is_decision_maker ? 1 : 0) : row.is_decision_maker;
  db.prepare(`
    UPDATE crm_contacts SET name=?, role=?, email=?, phone=?, is_decision_maker=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name, txt('role'), txt('email'), txt('phone'), dm, row.id);
  res.json({ ok: true, contact: project(db.prepare(`SELECT * FROM crm_contacts WHERE id = ?`).get(row.id)) });
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  const row = db.prepare(`SELECT id FROM crm_contacts WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM crm_contacts WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

export default router;
