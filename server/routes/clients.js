import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { listWorkspaces } from '../services/supergrow.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── Improvement 1: fetch workspaces for a given API key ─────────────────────
// NOTE: this route MUST come before /:id to avoid "workspaces" matching as an id

router.get('/workspaces', requireAuth, async (req, res) => {
  const { api_key } = req.query;
  if (!api_key) return res.status(400).json({ error: 'api_key query param required' });

  try {
    const workspaces = await listWorkspaces(api_key);
    res.json({ workspaces });
  } catch (err) {
    console.error('list_workspaces error:', err.message);
    res.status(502).json({ error: `Failed to fetch workspaces: ${err.message}` });
  }
});

// ─── Auto-sync: add new Supergrow workspaces to the DB automatically ──────────
// Uses the master api_key embedded in SUPERGROW_MCP_URL env var.
// Safe to call on every dashboard load — existing clients are never modified.

router.post('/sync', requireAuth, async (req, res) => {
  const mcpUrl = process.env.SUPERGROW_MCP_URL;
  if (!mcpUrl) return res.json({ added: 0, skipped: 0 });

  let masterApiKey;
  try {
    masterApiKey = new URL(mcpUrl).searchParams.get('api_key');
  } catch (_) {
    return res.json({ added: 0, skipped: 0 });
  }
  if (!masterApiKey) return res.json({ added: 0, skipped: 0 });

  try {
    const workspaces = await listWorkspaces(masterApiKey);
    console.log(`[sync] list_workspaces returned ${workspaces.length} workspace(s):`, workspaces.map(w => w.name || w.id));
    let added = 0;
    let skipped = 0;

    for (const ws of workspaces) {
      const wsId = ws.id || ws.workspace_id;
      const wsName = ws.name || ws.workspace_name || wsId;
      if (!wsId) continue;

      const exists = db.prepare('SELECT id FROM clients WHERE supergrow_workspace_id = ?').get(wsId);
      if (exists) { skipped++; continue; }

      db.prepare(`
        INSERT INTO clients
          (id, name, brand, supergrow_workspace_name, supergrow_workspace_id,
           supergrow_api_key, timezone, cadence, posting_identity, approval_mode)
        VALUES (?, ?, ?, ?, ?, ?, 'Europe/London', 'Daily', 'personal', 'auto')
      `).run(uuid(), wsName, wsName, wsName, wsId, masterApiKey);
      added++;
    }

    console.log(`[sync] done — added: ${added}, skipped: ${skipped}`);
    res.json({ added, skipped });
  } catch (err) {
    console.error('[sync] Supergrow sync error:', err.message);
    res.json({ added: 0, skipped: 0, error: err.message });
  }
});

// ─── Standard CRUD ────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const clients = db.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM campaigns WHERE client_id = c.id) as campaign_count,
      (SELECT status FROM campaigns WHERE client_id = c.id ORDER BY created_at DESC LIMIT 1) as last_status,
      (SELECT created_at FROM campaigns WHERE client_id = c.id ORDER BY created_at DESC LIMIT 1) as last_run
    FROM clients c ORDER BY c.created_at DESC
  `).all();
  res.json(clients);
});

router.get('/:id', requireAuth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const campaigns = db.prepare('SELECT * FROM campaigns WHERE client_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ ...client, campaigns });
});

router.post('/', requireAuth, upload.single('rag'), (req, res) => {
  const id = uuid();
  const { name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode } = req.body;

  let rag_content = null;
  let rag_filename = null;

  if (req.file) {
    rag_filename = req.file.originalname;
    rag_content = req.file.buffer.toString('utf-8');
  }

  db.prepare(`
    INSERT INTO clients (id, name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
      supergrow_api_key, timezone, cadence, posting_identity, approval_mode, rag_filename, rag_content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode, rag_filename, rag_content);

  res.json({ id });
});

router.put('/:id', requireAuth, upload.single('rag'), (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });

  const { name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode } = req.body;

  let rag_content = client.rag_content;
  let rag_filename = client.rag_filename;

  if (req.file) {
    rag_filename = req.file.originalname;
    rag_content = req.file.buffer.toString('utf-8');
  }

  db.prepare(`
    UPDATE clients SET name=?, brand=?, website=?, supergrow_workspace_name=?, supergrow_workspace_id=?,
      supergrow_api_key=?, timezone=?, cadence=?, posting_identity=?, approval_mode=?,
      rag_filename=?, rag_content=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode,
    rag_filename, rag_content, req.params.id);

  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM campaigns WHERE client_id = ?').run(req.params.id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
