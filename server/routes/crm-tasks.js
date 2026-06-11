/**
 * crm-tasks.js — Sales CRM tasks (Phase 5)
 *
 * Mounted at /api/crm/tasks. Gated by requireAccess('crm_tasks') — its own
 * access tick, separate from the company list, so a staff member can work
 * tasks without seeing every company. Scoped to tenant='tga'.
 *
 *   GET  /assignees           who a task can be assigned to (super + staff)
 *   GET  /?company_id=        one company's tasks (open first, then due date)
 *   GET  /?view=&assignee=    dashboard across all companies + counts
 *   POST /                    create
 *   PUT  /:id                 update; open→done stamps + auto-logs to History
 *   DELETE /:id               remove
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAccess } from '../middleware/auth.js';
import { logHistory } from './crm-history.js';

const router = Router();
router.use(requireAccess('crm_tasks'));

const TENANT = 'tga';
const PRIORITIES = ['low', 'normal', 'high'];
function superName() { return process.env.STUDIO_USERNAME || 'Admin'; }
function today() { return new Date().toISOString().slice(0, 10); }

function companyInTenant(id) {
  return db.prepare(`SELECT id, name FROM crm_companies WHERE id = ? AND tenant = ?`).get(id, TENANT);
}
function assigneeName(id, username) {
  if (id === '__super__') return superName();
  if (id && username) return username;
  return null;
}
function resolveAssignee(raw) {
  if (!raw) return null;
  if (raw === '__super__') return '__super__';
  return db.prepare(`SELECT id FROM admin_users WHERE id = ?`).get(raw) ? raw : null;
}

function project(r) {
  const td = today();
  return {
    id: r.id,
    company_id: r.company_id,
    company_name: r.company_name || null,
    title: r.title,
    assignee_id: r.assignee_id || null,
    assignee_name: assigneeName(r.assignee_id, r.assignee_username),
    due_date: r.due_date || null,
    priority: r.priority,
    status: r.status,
    completed_at: r.completed_at || null,
    overdue: r.status === 'open' && !!r.due_date && r.due_date < td,
  };
}

const SELECT = `
  SELECT t.*, au.username AS assignee_username, c.name AS company_name
  FROM crm_tasks t
  LEFT JOIN admin_users au ON au.id = t.assignee_id
  LEFT JOIN crm_companies c ON c.id = t.company_id
`;

router.get('/assignees', (_req, res) => {
  const staff = db.prepare(`SELECT id, username FROM admin_users WHERE disabled_at IS NULL ORDER BY LOWER(username)`).all();
  res.json({ assignees: [{ id: '__super__', name: superName() }, ...staff.map(s => ({ id: s.id, name: s.username }))] });
});

router.get('/', (req, res) => {
  // One company's tasks
  if (req.query.company_id) {
    if (!companyInTenant(req.query.company_id)) return res.status(404).json({ error: 'Company not found' });
    const rows = db.prepare(`${SELECT} WHERE t.tenant = ? AND t.company_id = ?
      ORDER BY (t.status='done') ASC, (t.due_date IS NULL) ASC, t.due_date ASC, t.created_at ASC`).all(TENANT, req.query.company_id);
    return res.json({ tasks: rows.map(project) });
  }

  // Dashboard across all companies
  const view = ['open', 'overdue', 'completed'].includes(req.query.view) ? req.query.view : 'open';
  const assignee = req.query.assignee && req.query.assignee !== 'all' ? req.query.assignee : null;
  const td = today();

  const where = ['t.tenant = ?']; const args = [TENANT];
  if (assignee) { where.push('t.assignee_id = ?'); args.push(assignee); }
  if (view === 'open') where.push(`t.status = 'open'`);
  else if (view === 'overdue') where.push(`t.status = 'open' AND t.due_date IS NOT NULL AND t.due_date < '${td}'`);
  else where.push(`t.status = 'done'`);

  const order = view === 'completed'
    ? 'ORDER BY t.completed_at DESC'
    : 'ORDER BY (t.due_date IS NULL) ASC, t.due_date ASC, t.created_at ASC';
  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ${order}`).all(...args);

  // counts (respect the assignee filter)
  const cArgs = [TENANT]; let aClause = '';
  if (assignee) { aClause = ' AND assignee_id = ?'; cArgs.push(assignee); }
  const open = db.prepare(`SELECT COUNT(*) n FROM crm_tasks WHERE tenant=? AND status='open'${aClause}`).get(...cArgs).n;
  const overdue = db.prepare(`SELECT COUNT(*) n FROM crm_tasks WHERE tenant=? AND status='open' AND due_date IS NOT NULL AND due_date < '${td}'${aClause}`).get(...cArgs).n;
  const completed = db.prepare(`SELECT COUNT(*) n FROM crm_tasks WHERE tenant=? AND status='done'${aClause}`).get(...cArgs).n;

  res.json({ tasks: rows.map(project), counts: { open, overdue, completed } });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  if (!companyInTenant(b.company_id)) return res.status(404).json({ error: 'Company not found' });
  const title = (b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Task title is required' });
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  const id = uuid();
  db.prepare(`INSERT INTO crm_tasks (id, company_id, tenant, title, assignee_id, due_date, priority) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, b.company_id, TENANT, title, resolveAssignee(b.assignee_id), (b.due_date || '').trim() || null, priority);
  res.json({ ok: true, task: project(db.prepare(`${SELECT} WHERE t.id = ?`).get(id)) });
});

router.put('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM crm_tasks WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const title = b.title != null ? String(b.title).trim() : row.title;
  if (!title) return res.status(400).json({ error: 'Task title is required' });
  const assignee_id = b.assignee_id !== undefined ? resolveAssignee(b.assignee_id) : row.assignee_id;
  const due_date = b.due_date !== undefined ? (String(b.due_date).trim() || null) : row.due_date;
  const priority = b.priority != null ? (PRIORITIES.includes(b.priority) ? b.priority : row.priority) : row.priority;
  const status = b.status != null ? (b.status === 'done' ? 'done' : 'open') : row.status;

  let completed_at = row.completed_at;
  const justCompleted = status === 'done' && row.status !== 'done';
  if (justCompleted) completed_at = db.prepare(`SELECT datetime('now') AS t`).get().t;
  if (status === 'open') completed_at = null;

  db.prepare(`UPDATE crm_tasks SET title=?, assignee_id=?, due_date=?, priority=?, status=?, completed_at=?, updated_at=datetime('now') WHERE id=?`)
    .run(title, assignee_id, due_date, priority, status, completed_at, row.id);

  if (justCompleted) {
    const who = req.adminUser ? req.adminUser.username : null;
    logHistory(row.company_id, TENANT, 'system', `Completed task: ${title}`, who);
  }
  res.json({ ok: true, task: project(db.prepare(`${SELECT} WHERE t.id = ?`).get(row.id)) });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare(`SELECT id FROM crm_tasks WHERE id = ? AND tenant = ?`).get(req.params.id, TENANT);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM crm_tasks WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

export default router;
