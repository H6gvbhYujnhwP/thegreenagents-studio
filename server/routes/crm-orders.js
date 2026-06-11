/**
 * crm-orders.js — Sales CRM order workflow (Phase 7)
 *
 * Mounted at /api/crm/orders. Scoped to tenant='tga'. Gating is PER ACTION:
 *   write / forward / send-to-purchasing  → crm_orders
 *   approve / reject                       → SUPER-ADMIN ONLY (admin approves)
 *   purchasing update / complete           → crm_purchasing
 *   read (list/get)                         → any of orders/approvals/purchasing
 *
 * Lifecycle: draft → awaiting_approval → approved → purchasing → completed,
 * with reject sending it back to 'rejected' (editable again). Every transition
 * logs a line to the company timeline.
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAccess, requireAnyAccess, requireSuperAdmin } from '../middleware/auth.js';
import { logHistory } from './crm-history.js';

const router = Router();
const TENANT = 'tga';
const READ = requireAnyAccess(['crm_orders', 'crm_approvals', 'crm_purchasing']);
const STATUS_LABEL = {
  draft: 'Draft', awaiting_approval: 'Awaiting approval', approved: 'Approved',
  rejected: 'Rejected', purchasing: 'Purchasing', completed: 'Completed',
};

function companyInTenant(id) { return db.prepare(`SELECT id, name FROM crm_companies WHERE id = ? AND tenant = ?`).get(id, TENANT); }
function money2(n) { const v = Number(n); return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
function actor(req) { return req.adminUser ? req.adminUser.username : null; }

function getLines(orderId) {
  return db.prepare(`SELECT id, description, qty, unit_price, sort FROM crm_order_lines WHERE order_id = ? ORDER BY sort ASC, rowid ASC`).all(orderId)
    .map(l => ({ id: l.id, description: l.description, qty: l.qty, unit_price: l.unit_price, line_total: money2(l.qty * l.unit_price) }));
}
function recomputeValue(orderId) {
  const r = db.prepare(`SELECT COALESCE(SUM(qty * unit_price), 0) v FROM crm_order_lines WHERE order_id = ?`).get(orderId);
  const v = money2(r.v);
  db.prepare(`UPDATE crm_orders SET value = ?, updated_at = datetime('now') WHERE id = ?`).run(v, orderId);
  return v;
}
function replaceLines(orderId, lines) {
  db.prepare(`DELETE FROM crm_order_lines WHERE order_id = ?`).run(orderId);
  const ins = db.prepare(`INSERT INTO crm_order_lines (id, order_id, tenant, description, qty, unit_price, sort) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  (Array.isArray(lines) ? lines : []).forEach((l, i) => {
    const desc = (l && l.description ? String(l.description).trim() : '');
    if (!desc) return;
    ins.run(uuid(), orderId, TENANT, desc, money2(l.qty || 0), money2(l.unit_price || 0), i);
  });
}

function project(r, withLines) {
  const o = {
    id: r.id, company_id: r.company_id, company_name: r.company_name || null,
    order_no: r.order_no, title: r.title || null, status: r.status, status_label: STATUS_LABEL[r.status] || r.status,
    value: r.value, profit: r.profit, notes: r.notes || null,
    approver: r.approver || null, approved_at: r.approved_at || null, decision_comment: r.decision_comment || null,
    purchasing_status: r.purchasing_status || null, purchasing_notes: r.purchasing_notes || null,
    sent_to_purchasing_at: r.sent_to_purchasing_at || null, completed_at: r.completed_at || null,
    created_at: r.created_at,
  };
  if (withLines) o.lines = getLines(r.id);
  return o;
}

const SELECT = `SELECT o.*, c.name AS company_name FROM crm_orders o LEFT JOIN crm_companies c ON c.id = o.company_id`;

// ── Reads ───────────────────────────────────────────────────────────────────
router.get('/', READ, (req, res) => {
  // one company's orders
  if (req.query.company_id) {
    if (!companyInTenant(req.query.company_id)) return res.status(404).json({ error: 'Company not found' });
    const rows = db.prepare(`${SELECT} WHERE o.tenant = ? AND o.company_id = ? ORDER BY o.created_at DESC`).all(TENANT, req.query.company_id);
    return res.json({ orders: rows.map(r => project(r, false)) });
  }
  // dashboard / queues
  const queue = req.query.queue; // 'approval' | 'purchasing' | undefined
  let statusClause = '', args = [TENANT];
  if (queue === 'approval') statusClause = ` AND o.status = 'awaiting_approval'`;
  else if (queue === 'purchasing') statusClause = ` AND o.status = 'purchasing'`;
  else if (['draft','awaiting_approval','approved','rejected','purchasing','completed'].includes(req.query.status)) { statusClause = ` AND o.status = ?`; args.push(req.query.status); }
  const rows = db.prepare(`${SELECT} WHERE o.tenant = ?${statusClause} ORDER BY o.updated_at DESC`).all(...args);

  const counts = {};
  for (const r of db.prepare(`SELECT status, COUNT(*) n FROM crm_orders WHERE tenant=? GROUP BY status`).all(TENANT)) counts[r.status] = r.n;
  res.json({ orders: rows.map(r => project(r, false)), counts });
});

router.get('/:id', READ, (req, res) => {
  const r = db.prepare(`${SELECT} WHERE o.tenant = ? AND o.id = ?`).get(TENANT, req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ order: project(r, true) });
});

// ── Write (crm_orders) ────────────────────────────────────────────────────────
router.post('/', requireAccess('crm_orders'), (req, res) => {
  const b = req.body || {};
  if (!companyInTenant(b.company_id)) return res.status(404).json({ error: 'Company not found' });
  const id = uuid();
  const next = db.prepare(`SELECT COALESCE(MAX(order_no), 0) + 1 AS n FROM crm_orders WHERE tenant = ?`).get(TENANT).n;
  db.prepare(`INSERT INTO crm_orders (id, company_id, tenant, order_no, title, status, profit, notes, created_by) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
    .run(id, b.company_id, TENANT, next, (b.title || '').trim() || null, money2(b.profit), (b.notes || '').trim() || null, actor(req));
  replaceLines(id, b.lines);
  recomputeValue(id);
  res.json({ ok: true, order: project(db.prepare(`${SELECT} WHERE o.id = ?`).get(id), true) });
});

router.put('/:id', requireAccess('crm_orders'), (req, res) => {
  const row = db.prepare(`SELECT * FROM crm_orders WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!['draft', 'rejected'].includes(row.status)) return res.status(409).json({ error: 'Only draft or returned orders can be edited' });
  const b = req.body || {};
  const title = b.title !== undefined ? (String(b.title).trim() || null) : row.title;
  const profit = b.profit !== undefined ? money2(b.profit) : row.profit;
  const notes = b.notes !== undefined ? (String(b.notes).trim() || null) : row.notes;
  db.prepare(`UPDATE crm_orders SET title=?, profit=?, notes=?, updated_at=datetime('now') WHERE id=?`).run(title, profit, notes, row.id);
  if (b.lines !== undefined) replaceLines(row.id, b.lines);
  recomputeValue(row.id);
  res.json({ ok: true, order: project(db.prepare(`${SELECT} WHERE o.id = ?`).get(row.id), true) });
});

router.delete('/:id', requireAccess('crm_orders'), (req, res) => {
  const row = db.prepare(`SELECT id FROM crm_orders WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM crm_order_lines WHERE order_id = ?`).run(row.id);
  db.prepare(`DELETE FROM crm_orders WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

// Helper: a transition guarded by a current-status check + logging
function transition(req, res, { id, allowedFrom, toStatus, sets = {}, logKind = 'system', logMsg }) {
  const row = db.prepare(`SELECT * FROM crm_orders WHERE id = ? AND tenant = ?`).get(id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!allowedFrom.includes(row.status)) return res.status(409).json({ error: `Can't do that from "${STATUS_LABEL[row.status] || row.status}"` });
  const cols = ['status=?', 'updated_at=datetime(\'now\')']; const vals = [toStatus];
  for (const [k, v] of Object.entries(sets)) { cols.push(`${k}=?`); vals.push(v); }
  vals.push(id);
  db.prepare(`UPDATE crm_orders SET ${cols.join(', ')} WHERE id=?`).run(...vals);
  if (logMsg) logHistory(row.company_id, TENANT, logKind, logMsg(row), actor(req));
  res.json({ ok: true, order: project(db.prepare(`${SELECT} WHERE o.id = ?`).get(id), true) });
}
const ordNo = (row) => `Order #${row.order_no}`;

// ── Forward for approval (crm_orders) ─────────────────────────────────────────
router.post('/:id/forward', requireAccess('crm_orders'), (req, res) =>
  transition(req, res, { id: req.params.id, allowedFrom: ['draft', 'rejected'], toStatus: 'awaiting_approval',
    sets: { decision_comment: null }, logMsg: (r) => `${ordNo(r)} forwarded for approval` }));

// ── Approve / reject (ADMIN ONLY) ─────────────────────────────────────────────
router.post('/:id/approve', requireSuperAdmin, (req, res) => {
  const comment = (req.body && req.body.comment ? String(req.body.comment).trim() : '') || null;
  transition(req, res, { id: req.params.id, allowedFrom: ['awaiting_approval'], toStatus: 'approved',
    sets: { approver: actor(req), approved_at: db.prepare(`SELECT datetime('now') AS t`).get().t, decision_comment: comment },
    logMsg: (r) => `${ordNo(r)} approved${comment ? ' — ' + comment : ''}` });
});
router.post('/:id/reject', requireSuperAdmin, (req, res) => {
  const comment = (req.body && req.body.comment ? String(req.body.comment).trim() : '') || null;
  transition(req, res, { id: req.params.id, allowedFrom: ['awaiting_approval'], toStatus: 'rejected',
    sets: { approver: actor(req), approved_at: null, decision_comment: comment },
    logMsg: (r) => `${ordNo(r)} returned for changes${comment ? ' — ' + comment : ''}` });
});

// ── Send to purchasing (crm_orders / order owner) ─────────────────────────────
router.post('/:id/send-to-purchasing', requireAccess('crm_orders'), (req, res) =>
  transition(req, res, { id: req.params.id, allowedFrom: ['approved'], toStatus: 'purchasing',
    sets: { sent_to_purchasing_at: db.prepare(`SELECT datetime('now') AS t`).get().t },
    logMsg: (r) => `${ordNo(r)} sent to purchasing` }));

// ── Purchasing update + complete (crm_purchasing) ─────────────────────────────
router.put('/:id/purchasing', requireAccess('crm_purchasing'), (req, res) => {
  const row = db.prepare(`SELECT * FROM crm_orders WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'purchasing') return res.status(409).json({ error: 'Order is not in purchasing' });
  const b = req.body || {};
  const ps = b.purchasing_status !== undefined ? (String(b.purchasing_status).trim() || null) : row.purchasing_status;
  const pn = b.purchasing_notes !== undefined ? (String(b.purchasing_notes).trim() || null) : row.purchasing_notes;
  db.prepare(`UPDATE crm_orders SET purchasing_status=?, purchasing_notes=?, updated_at=datetime('now') WHERE id=?`).run(ps, pn, row.id);
  res.json({ ok: true, order: project(db.prepare(`${SELECT} WHERE o.id = ?`).get(row.id), true) });
});
router.post('/:id/complete', requireAccess('crm_purchasing'), (req, res) =>
  transition(req, res, { id: req.params.id, allowedFrom: ['purchasing'], toStatus: 'completed',
    sets: { completed_at: db.prepare(`SELECT datetime('now') AS t`).get().t },
    logMsg: (r) => `${ordNo(r)} completed` }));

export default router;
