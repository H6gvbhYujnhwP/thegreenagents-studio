import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { listWorkspaces } from '../services/supergrow.js';
import { extractTextFromBuffer } from '../utils/extractText.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// TEMP TEST ENDPOINT — remove after confirming Supergrow MCP works
router.get('/test-supergrow', requireAuth, async (req, res) => {
  const mcpUrl = process.env.SUPERGROW_MCP_URL;
  if (!mcpUrl) return res.json({ error: 'SUPERGROW_MCP_URL not set' });
  const masterApiKey = new URL(mcpUrl).searchParams.get('api_key');
  try {
    const workspaces = await listWorkspaces(masterApiKey);
    res.json({ ok: true, count: workspaces.length, workspaces });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

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
  if (!mcpUrl) {
    console.warn('[sync] SUPERGROW_MCP_URL is not set — skipping sync');
    return res.json({ added: 0, skipped: 0 });
  }

  let masterApiKey;
  try {
    masterApiKey = new URL(mcpUrl).searchParams.get('api_key');
  } catch (_) {
    console.warn('[sync] SUPERGROW_MCP_URL is not a valid URL — skipping sync');
    return res.json({ added: 0, skipped: 0 });
  }
  if (!masterApiKey) {
    console.warn('[sync] No api_key param found in SUPERGROW_MCP_URL — skipping sync');
    return res.json({ added: 0, skipped: 0 });
  }

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

router.post('/', requireAuth, upload.single('rag'), async (req, res) => {
  const id = uuid();
  const { name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode } = req.body;

  let rag_content = null;
  let rag_filename = null;

  if (req.file) {
    rag_filename = req.file.originalname;
    try {
      rag_content = await extractTextFromBuffer(req.file.buffer, req.file.originalname);
    } catch (extractErr) {
      return res.status(400).json({ error: extractErr.message });
    }
  }

  db.prepare(`
    INSERT INTO clients (id, name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
      supergrow_api_key, timezone, cadence, posting_identity, approval_mode, rag_filename, rag_content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode, rag_filename, rag_content);

  res.json({ id });
});

router.put('/:id', requireAuth, upload.single('rag'), async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });

  const { name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode } = req.body;

  let rag_content = client.rag_content;
  let rag_filename = client.rag_filename;

  if (req.file) {
    rag_filename = req.file.originalname;
    try {
      rag_content = await extractTextFromBuffer(req.file.buffer, req.file.originalname);
    } catch (extractErr) {
      return res.status(400).json({ error: extractErr.message });
    }
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

// ─── Upload logo for a client ─────────────────────────────────────────────────
router.post('/:id/logo', requireAuth, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No logo file uploaded' });

  const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'];
  if (!allowed.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Logo must be PNG, JPG, SVG, or WebP' });
  }

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  try {
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const key = `logos/${req.params.id}/logo-${uuid()}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    }));

    const logoUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    db.prepare('UPDATE clients SET logo_url = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(logoUrl, req.params.id);

    // Cross-sync: if any portal customer is linked to this LinkedIn client
    // (via customer_services or the legacy linkedin_client_id column), copy
    // the new logo across so the customer's portal header stays consistent.
    // Inline rather than imported helper to keep the change minimal — the
    // mirror logic lives properly in portal-admin.js.
    db.prepare(`
      UPDATE email_clients
      SET logo_url = ?
      WHERE id IN (
        SELECT email_client_id FROM customer_services
        WHERE service_key = 'linkedin' AND linked_external_id = ?
        UNION
        SELECT id FROM email_clients WHERE linkedin_client_id = ?
      )
    `).run(logoUrl, req.params.id, req.params.id);

    res.json({ ok: true, logo_url: logoUrl });
  } catch (err) {
    console.error('[clients] Logo upload failed:', err.message);
    res.status(500).json({ error: `Logo upload failed: ${err.message}` });
  }
});

export default router;
