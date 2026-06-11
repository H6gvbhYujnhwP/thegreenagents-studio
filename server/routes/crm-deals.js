/**
 * crm-deals.js — Sales CRM deals / forecast (Phase 6)
 *
 * Mounted at /api/crm/deals. Gated by requireAccess('crm_deals'). Scoped to
 * tenant='tga'. Every deal carries a one-off value AND a monthly recurring
 * value; profit is entered manually; likelihood is 0–100%.
 *
 * Forecast (open deals only):
 *   weighted one-off  = Σ one_off_value × likelihood/100
 *   monthly recurring = Σ monthly_value
 *   forecast profit   = Σ profit × likelihood/100
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAccess } from '../middleware/auth.js';
import { logHistory } from './crm-history.js';

const router = Router();
router.use(requireAccess('crm_deals'));

const TENANT = 'tga';
const STATUSES = ['open', 'won', 'lost'];
function superName() { return process.env.STUDIO_USERNAME || 'Admin'; }
function companyInTenant(id) { return db.prepare(`SELECT id FROM crm_companies WHERE id = ? AND tenant = ?`).get(id, TENANT); }
function ownerName(id, username) { if (id === '__super__') return superName(); if (id && username) return username; return null; }
function resolveOwner(raw) { if (!raw) return null; if (raw === '__super__') return '__super__'; return db.prepare(`SELECT id FROM admin_users WHERE id = ?`).get(raw) ? raw : null; }
function num(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function clampPct(v) { const n = Math.round(num(v, 0)); return Math.max(0, Math.min(100, n)); }
function money2(n) { return Math.round(num(n) * 100) / 100; }

function project(r) {
  return {
    id: r.id, company_id: r.company_id, company_name: r.company_name || null,
    title: r.title, one_off_value: r.one_off_value, monthly_value: r.monthly_value,
    profit: r.profit, likelihood: r.likelihood, expected_close: r.expected_close || null,
    owner_id: r.owner_id || null, owner_name: ownerName(r.owner_id, r.owner_username),
    status: r.status, closed_at: r.closed_at || null,
  };
}

const SELECT = `
  SELECT d.*, au.username AS owner_username, c.name AS company_name
  FROM crm_deals d
  LEFT JOIN admin_users au ON au.id = d.owner_id
  LEFT JOIN crm_companies c ON c.id = d.company_id
`;

router.get('/assignees', (_req, res) => {
  const staff = db.prepare(`SELECT id, username FROM admin_users WHERE disabled_at IS NULL ORDER BY LOWER(username)`).all();
  res.json({ assignees: [{ id: '__super__', name: superName() }, ...staff.map(s => ({ id: s.id, name: s.username }))] });
});

function summary() {
  const r = db.prepare(`
    SELECT
      COUNT(*) AS open_count,
      COALESCE(SUM(one_off_value * likelihood / 100.0), 0) AS weighted_one_off,
      COALESCE(SUM(monthly_value), 0) AS monthly_recurring,
      COALESCE(SUM(profit * likelihood / 100.0), 0) AS forecast_profit
    FROM crm_deals WHERE tenant = ? AND status = 'open'
  `).get(TENANT);
  return {
    open_count: r.open_count,
    weighted_one_off: money2(r.weighted_one_off),
    monthly_recurring: money2(r.monthly_recurring),
    forecast_profit: money2(r.forecast_profit),
  };
}

router.get('/', (req, res) => {
  // one company's deals
  if (req.query.company_id) {
    if (!companyInTenant(req.query.company_id)) return res.status(404).json({ error: 'Company not found' });
    const rows = db.prepare(`${SELECT} WHERE d.tenant = ? AND d.company_id = ?
      ORDER BY (d.status!='open') ASC, (d.expected_close IS NULL) ASC, d.expected_close ASC, d.created_at DESC`).all(TENANT, req.query.company_id);
    return res.json({ deals: rows.map(project) });
  }
  // dashboard
  const status = STATUSES.includes(req.query.status) ? req.query.status : null; // null = open default below; 'all' handled
  const filter = req.query.status === 'all' ? 'all' : (status || 'open');
  const where = ['d.tenant = ?']; const args = [TENANT];
  if (filter !== 'all') { where.push('d.status = ?'); args.push(filter); }
  const order = filter === 'open'
    ? 'ORDER BY (d.expected_close IS NULL) ASC, d.expected_close ASC'
    : 'ORDER BY d.updated_at DESC';
  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ${order}`).all(...args);
  res.json({ deals: rows.map(project), summary: summary() });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  if (!companyInTenant(b.company_id)) return res.status(404).json({ error: 'Company not found' });
  const title = (b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Deal name is required' });
  const status = STATUSES.includes(b.status) ? b.status : 'open';
  const id = uuid();
  db.prepare(`
    INSERT INTO crm_deals (id, company_id, tenant, title, one_off_value, monthly_value, profit, likelihood, expected_close, owner_id, status, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, b.company_id, TENANT, title, money2(b.one_off_value), money2(b.monthly_value), money2(b.profit),
    clampPct(b.likelihood), (b.expected_close || '').trim() || null, resolveOwner(b.owner_id), status,
    status === 'open' ? null : db.prepare(`SELECT datetime('now') AS t`).get().t);
  res.json({ ok: true, deal: project(db.prepare(`${SELECT} WHERE d.id = ?`).get(id)) });
});

router.put('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM crm_deals WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const title = b.title != null ? String(b.title).trim() : row.title;
  if (!title) return res.status(400).json({ error: 'Deal name is required' });
  const one_off = b.one_off_value !== undefined ? money2(b.one_off_value) : row.one_off_value;
  const monthly = b.monthly_value !== undefined ? money2(b.monthly_value) : row.monthly_value;
  const profit = b.profit !== undefined ? money2(b.profit) : row.profit;
  const likelihood = b.likelihood !== undefined ? clampPct(b.likelihood) : row.likelihood;
  const expected_close = b.expected_close !== undefined ? (String(b.expected_close).trim() || null) : row.expected_close;
  const owner_id = b.owner_id !== undefined ? resolveOwner(b.owner_id) : row.owner_id;
  const status = b.status != null ? (STATUSES.includes(b.status) ? b.status : row.status) : row.status;

  const wasOpen = row.status === 'open';
  const nowClosed = status !== 'open';
  let closed_at = row.closed_at;
  if (wasOpen && nowClosed) closed_at = db.prepare(`SELECT datetime('now') AS t`).get().t;
  if (status === 'open') closed_at = null;

  db.prepare(`
    UPDATE crm_deals SET title=?, one_off_value=?, monthly_value=?, profit=?, likelihood=?, expected_close=?, owner_id=?, status=?, closed_at=?, updated_at=datetime('now')
    WHERE id=?
  `).run(title, one_off, monthly, profit, likelihood, expected_close, owner_id, status, closed_at, row.id);

  if (wasOpen && nowClosed) {
    const who = req.adminUser ? req.adminUser.username : null;
    const amount = one_off || monthly ? ` (£${Math.round(one_off).toLocaleString('en-GB')}${monthly ? ' + £' + Math.round(monthly).toLocaleString('en-GB') + '/mo' : ''})` : '';
    logHistory(row.company_id, TENANT, 'system', `Deal ${status}: ${title}${amount}`, who);
  }
  res.json({ ok: true, deal: project(db.prepare(`${SELECT} WHERE d.id = ?`).get(row.id)) });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare(`SELECT id FROM crm_deals WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM crm_deals WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

export default router;
