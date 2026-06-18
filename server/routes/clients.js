import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { listWorkspaces } from '../services/supergrow.js';
import { extractTextFromBuffer } from '../utils/extractText.js';
import { prepareLogoForStorage } from '../services/logo-prep.js';
import { extractBrandFromRag } from '../services/brand-extract.js';
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

  // Auto-extract the visual-brand block from the freshly uploaded RAG so the
  // image engines follow the brand from the very first campaign. Best-effort:
  // a failed extraction never blocks creating the client (the operator can hit
  // "Pull brand from RAG" later, or fill the fields by hand).
  if (rag_content) {
    try {
      const brand = await extractBrandFromRag(rag_content);
      db.prepare(`
        UPDATE clients SET
          brand_colors     = COALESCE(?, brand_colors),
          logo_description = COALESCE(?, logo_description),
          type_style       = COALESCE(?, type_style),
          visual_style     = COALESCE(?, visual_style),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(brand.brand_colors, brand.logo_description, brand.type_style, brand.visual_style, id);
    } catch (err) {
      console.warn('[clients] Brand auto-extract on create failed (non-fatal):', err.message);
    }
  }

  res.json({ id });
});

router.put('/:id', requireAuth, upload.single('rag'), async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });

  const { name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode,
    logo_position, logo_panel, logo_size,
    brand_colors, logo_description, type_style, visual_style, image_engine } = req.body;

  // Whitelist the three brand panel fields. If a value comes through that
  // isn't in the allowed set, fall back to the existing stored value rather
  // than failing the whole save — the rest of the form is more important
  // than a typo'd dropdown value.
  const ALLOWED_POSITIONS = ['bottom-right', 'top-right', 'bottom-left', 'top-left'];
  const ALLOWED_PANELS    = ['white', 'none'];
  const ALLOWED_SIZES     = ['small', 'medium', 'large'];
  const ALLOWED_ENGINES   = ['gemini', 'gpt_image'];

  const safePosition = logo_position !== undefined
    ? (ALLOWED_POSITIONS.includes(logo_position) ? logo_position : client.logo_position)
    : client.logo_position;
  const safePanel = logo_panel !== undefined
    ? (ALLOWED_PANELS.includes(logo_panel) ? logo_panel : client.logo_panel)
    : client.logo_panel;
  const safeSize = logo_size !== undefined
    ? (ALLOWED_SIZES.includes(logo_size) ? logo_size : client.logo_size)
    : client.logo_size;

  // Brand-kit fields (gpt-image-2 designed-ad pilot). Free-text fields take the
  // submitted value as-is (including blank, to allow clearing); when omitted
  // they keep the stored value. image_engine is whitelisted like the dropdowns.
  const safeBrandColors = brand_colors    !== undefined ? brand_colors    : client.brand_colors;
  const safeLogoDesc    = logo_description !== undefined ? logo_description : client.logo_description;
  const safeTypeStyle   = type_style       !== undefined ? type_style       : client.type_style;
  const safeVisualStyle = visual_style     !== undefined ? visual_style     : client.visual_style;
  const safeEngine = image_engine !== undefined
    ? (ALLOWED_ENGINES.includes(image_engine) ? image_engine : client.image_engine)
    : client.image_engine;

  let rag_content = client.rag_content;
  let rag_filename = client.rag_filename;

  // Brand fields that will actually be written. Default to the safe (form or
  // existing) values; if a NEW RAG file is uploaded below, auto-extraction
  // overrides them so a re-upload re-pulls the brand. A plain panel save (no
  // file) leaves the operator's typed values untouched.
  let finalBrandColors = safeBrandColors;
  let finalLogoDesc    = safeLogoDesc;
  let finalTypeStyle   = safeTypeStyle;
  let finalVisualStyle = safeVisualStyle;

  if (req.file) {
    rag_filename = req.file.originalname;
    try {
      rag_content = await extractTextFromBuffer(req.file.buffer, req.file.originalname);
    } catch (extractErr) {
      return res.status(400).json({ error: extractErr.message });
    }

    // Auto re-pull the brand block from the new RAG. Extraction returns null
    // for anything it can't find — keep the prior value in that case rather
    // than wiping a field the new document happens to be silent on.
    try {
      const extracted = await extractBrandFromRag(rag_content);
      finalBrandColors = extracted.brand_colors     ?? finalBrandColors;
      finalLogoDesc    = extracted.logo_description  ?? finalLogoDesc;
      finalTypeStyle   = extracted.type_style        ?? finalTypeStyle;
      finalVisualStyle = extracted.visual_style      ?? finalVisualStyle;
    } catch (err) {
      console.warn('[clients] Brand auto-extract on RAG re-upload failed (non-fatal):', err.message);
    }
  }

  db.prepare(`
    UPDATE clients SET name=?, brand=?, website=?, supergrow_workspace_name=?, supergrow_workspace_id=?,
      supergrow_api_key=?, timezone=?, cadence=?, posting_identity=?, approval_mode=?,
      rag_filename=?, rag_content=?,
      logo_position=?, logo_panel=?, logo_size=?,
      brand_colors=?, logo_description=?, type_style=?, visual_style=?, image_engine=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode,
    rag_filename, rag_content,
    safePosition, safePanel, safeSize,
    finalBrandColors, finalLogoDesc, finalTypeStyle, finalVisualStyle, safeEngine,
    req.params.id);

  res.json({ ok: true });
});

// ─── Manual "Pull brand from RAG" ─────────────────────────────────────────────
// Re-runs brand extraction against the client's STORED rag_content and writes
// the four brand fields. This is the button on the Brand kit panel — used when
// the operator edits the RAG wording in place, or wants to re-pull after
// clearing a field. Overwrites the four fields with whatever the RAG yields
// (null fields are left unchanged so a silent RAG can't wipe a good value).
router.post('/:id/extract-brand', requireAuth, async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (!client.rag_content) {
    return res.status(400).json({ error: 'No RAG document uploaded for this client yet.' });
  }

  try {
    const brand = await extractBrandFromRag(client.rag_content);
    const found = Object.values(brand).filter(Boolean).length;
    if (found === 0) {
      return res.json({ ok: true, found: 0, message: 'No visual branding found in the RAG document.', client: { ...client } });
    }

    db.prepare(`
      UPDATE clients SET
        brand_colors     = COALESCE(?, brand_colors),
        logo_description = COALESCE(?, logo_description),
        type_style       = COALESCE(?, type_style),
        visual_style     = COALESCE(?, visual_style),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(brand.brand_colors, brand.logo_description, brand.type_style, brand.visual_style, req.params.id);

    const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    res.json({ ok: true, found, client: updated });
  } catch (err) {
    console.error('[clients] Manual brand extract failed:', err.message);
    res.status(500).json({ error: `Brand extraction failed: ${err.message}` });
  }
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
    // Trim the logo once, here at upload time, before it lands in R2. This
    // is the canonical pre-processing step — every regen later just fetches
    // the already-trimmed file and skips the trim. Eliminates regen-to-regen
    // panel size variance that came from Sharp's data-dependent trim
    // producing slightly different output on repeated calls. See
    // services/logo-prep.js for full reasoning.
    const prepped = await prepareLogoForStorage(req.file.buffer, req.file.mimetype);
    const key = `logos/${req.params.id}/logo-${uuid()}.${prepped.ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: prepped.buffer,
      ContentType: prepped.mimetype
    }));

    const logoUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    db.prepare(`UPDATE clients SET logo_url = ?, logo_processed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(logoUrl, req.params.id);

    // Cross-sync: if any portal customer is linked to this LinkedIn client
    // (via customer_services or the legacy linkedin_client_id column), copy
    // the new logo across so the customer's portal header stays consistent.
    // Inline rather than imported helper to keep the change minimal — the
    // mirror logic lives properly in portal-admin.js. Also stamps
    // logo_processed_at on the email_clients side so the boot-time migration
    // skips these rows next time it runs.
    db.prepare(`
      UPDATE email_clients
      SET logo_url = ?, logo_processed_at = datetime('now')
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
