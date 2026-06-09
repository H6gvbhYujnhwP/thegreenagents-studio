// ─────────────────────────────────────────────────────────────────────────────
// Facebook Ads (admin side) — Stage 1: connection foundation only.
//
// Mounted at /api/facebook-ads in server/index.js, behind the global
// requireAuth Bearer-token middleware (same as every other admin endpoint).
//
// Stage 1 ships ONE endpoint: GET /connection-status — so a future admin screen
// can show a green/red "Studio is connected to Facebook" indicator. It calls
// Facebook live (via services/meta-api.js) and reports the result.
//
// The per-customer CRUD (ad account, daily budget, monthly max, status) arrives
// in Stage 2, writing to the `facebook_ads` table that db.js creates now.
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { extractTextFromBuffer } from '../utils/extractText.js';
import { prepareLogoForStorage } from '../services/logo-prep.js';
import { uploadImageToR2 } from '../services/r2.js';
import { recompositeLogoFromUrl } from '../services/gemini.js';
import { metaConfigured, testConnection, getAdsOverview, META } from '../services/meta-api.js';
import { generateAdCreatives, regenerateAdCopy, regenerateAdImage } from '../services/facebook-ads-gen.js';
import { ALLOWED_CTAS, normalizeCta } from '../services/facebook-ads-playbook.js';

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Brand-panel allowed values (mirrors the LinkedIn Brand Panel, decision #64).
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const PANELS    = ['white', 'none'];
const SIZES     = ['small', 'medium', 'large'];

// Load a generation-ready customer: email_clients identity + the facebook_ads
// brand defaults. logo_url prefers the FB-side logo, falling back to the
// customer's existing brand logo. Used by generate / regenerate-image /
// recomposite so they all respect the saved Brand Panel.
function loadGenCustomer(id) {
  const ec = db.prepare('SELECT id, name, logo_url FROM email_clients WHERE id = ?').get(id);
  if (!ec) return null;
  const fa = db.prepare('SELECT logo_url, logo_position, logo_panel, logo_size FROM facebook_ads WHERE email_client_id = ?').get(id) || {};
  return {
    id: ec.id,
    name: ec.name,
    logo_url: fa.logo_url || ec.logo_url || null,
    logo_position: fa.logo_position || 'bottom-right',
    logo_panel: fa.logo_panel || 'white',
    logo_size: fa.logo_size || 'small',
  };
}

// ── CONNECTION STATUS ────────────────────────────────────────────────────────
// Reports whether Studio can reach Facebook with the saved credentials. Always
// returns 200 with a JSON verdict (never an error status) so the UI can render
// the result cleanly rather than handling a thrown request.
router.get('/connection-status', async (req, res) => {
  if (!metaConfigured()) {
    return res.json({
      configured: false,
      ok: false,
      message: 'Meta API is not configured — META_ACCESS_TOKEN is missing in the environment.',
    });
  }

  const result = await testConnection();
  res.json({
    configured: true,
    ok: result.ok,
    account: result.ok ? result.account : null,
    error: result.ok ? null : result.error,
    api_version: META.apiVersion,
    ad_account_id: `act_${META.adAccountId}`,
  });
});

// ── ADS + STATS (Stage 2: read) ──────────────────────────────────────────────
// Returns the configured account, window totals, and a card per ad with its
// own stats — everything the admin Facebook Ads screen renders. The window is
// chosen via ?window=7d|30d|lifetime (defaults to 30d). Always 200: a Meta
// failure comes back as { ok:false, error } so the screen shows a clean message
// rather than a thrown request.
router.get('/ads', async (req, res) => {
  if (!metaConfigured()) {
    return res.json({ ok: false, configured: false, error: 'Meta API is not configured.' });
  }
  const window = req.query.window || '30d';
  const overview = await getAdsOverview({ window });
  res.json({ configured: true, ...overview });
});

// ── CUSTOMERS (Facebook Ads roster) ──────────────────────────────────────────
// Customers that have a Facebook Ads record (a RAG upload creates one). Drives
// the Creatives-tab picker.
router.get('/customers', (req, res) => {
  const rows = db.prepare(`
    SELECT fa.email_client_id AS id, ec.name,
           fa.rag_filename, fa.status,
           fa.logo_url, fa.logo_position, fa.logo_panel, fa.logo_size,
           (fa.rag_content IS NOT NULL AND fa.rag_content != '') AS has_rag,
           (fa.logo_url IS NOT NULL AND fa.logo_url != '') AS has_logo
    FROM facebook_ads fa
    JOIN email_clients ec ON ec.id = fa.email_client_id
    ORDER BY ec.name COLLATE NOCASE ASC
  `).all();
  res.json(rows.map(r => ({
    ...r,
    has_rag: !!r.has_rag,
    has_logo: !!r.has_logo,
    logo_position: r.logo_position || 'bottom-right',
    logo_panel: r.logo_panel || 'white',
    logo_size: r.logo_size || 'small',
  })));
});

// ── AVAILABLE CUSTOMERS (for adding one) ─────────────────────────────────────
// Non-hidden customers not already a Facebook Ads customer, excluding portal
// anchor rows that are linked to another customer (same exclusion the Meta
// Pixels add-dropdown uses — keeps Cube6-style linked + Manson-style self-links
// behaving correctly).
router.get('/available-customers', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name
    FROM email_clients
    WHERE (hidden_at IS NULL)
      AND id NOT IN (SELECT email_client_id FROM facebook_ads)
      AND id NOT IN (
        SELECT linked_external_id FROM customer_services
        WHERE linked_external_id IS NOT NULL AND email_client_id != linked_external_id
      )
    ORDER BY name COLLATE NOCASE ASC
  `).all();
  res.json(rows);
});

// ── RAG UPLOAD (per customer) ────────────────────────────────────────────────
// Upload the customer's RAG doc (pdf/md/txt/csv). Text is extracted and stored
// on the facebook_ads row, creating that row if it doesn't exist yet. Mirrors
// the LinkedIn-side per-client RAG upload exactly.
router.post('/:emailClientId/rag', upload.single('rag'), async (req, res) => {
  const id = req.params.emailClientId;
  const customer = db.prepare('SELECT id, name FROM email_clients WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!req.file) return res.status(400).json({ error: 'No RAG file uploaded' });

  let ragContent, ragFilename;
  try {
    ragFilename = req.file.originalname;
    ragContent = await extractTextFromBuffer(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ error: `Could not read that file: ${err.message}` });
  }
  if (!ragContent || !ragContent.trim()) {
    return res.status(400).json({ error: 'No text could be extracted from that file. Try a .txt or .md.' });
  }

  const existing = db.prepare('SELECT id FROM facebook_ads WHERE email_client_id = ?').get(id);
  if (existing) {
    db.prepare(`UPDATE facebook_ads SET rag_filename = ?, rag_content = ?, updated_at = datetime('now') WHERE email_client_id = ?`)
      .run(ragFilename, ragContent, id);
  } else {
    db.prepare(`INSERT INTO facebook_ads (id, email_client_id, status, rag_filename, rag_content) VALUES (?, ?, 'not_connected', ?, ?)`)
      .run(uuid(), id, ragFilename, ragContent);
    // record the subscription so the customer's portal recognises the service later
    db.prepare(`INSERT OR IGNORE INTO customer_services (email_client_id, service_key, linked_external_id, enabled_by) VALUES (?, 'facebook_ads', NULL, 'admin')`).run(id);
  }
  res.json({ ok: true, rag_filename: ragFilename, chars: ragContent.length });
});

// ── GENERATE CREATIVES ───────────────────────────────────────────────────────
// Generate `count` (1–5, default 3) ad variations for a customer from their RAG.
// Persists each as a draft row under one batch_id and returns them. Nothing is
// sent to Facebook.
router.post('/:emailClientId/generate', async (req, res) => {
  const id = req.params.emailClientId;
  const customer = loadGenCustomer(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const fa = db.prepare('SELECT rag_content FROM facebook_ads WHERE email_client_id = ?').get(id);
  if (!fa || !fa.rag_content || !fa.rag_content.trim()) {
    return res.status(400).json({ error: 'Upload a RAG document for this customer first.' });
  }

  let count = parseInt(req.body && req.body.count, 10);
  if (!Number.isFinite(count)) count = 3;
  count = Math.max(1, Math.min(5, count));

  try {
    const creatives = await generateAdCreatives(customer, fa.rag_content, { count });
    const batchId = uuid();
    const insert = db.prepare(`
      INSERT INTO facebook_ad_creatives
        (id, email_client_id, batch_id, hook_label, primary_text, headline, cta, image_url, pre_logo_image_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `);
    const rows = [];
    for (const c of creatives) {
      const cid = uuid();
      insert.run(cid, id, batchId, c.hook_label, c.primary_text, c.headline, c.cta, c.image_url, c.pre_logo_image_url);
      rows.push(db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(cid));
    }
    res.json({ ok: true, batch_id: batchId, creatives: rows });
  } catch (err) {
    console.error('[facebook-ads] generate failed:', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Generation failed' });
  }
});

// ── LIST CREATIVES (per customer) ────────────────────────────────────────────
router.get('/:emailClientId/creatives', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM facebook_ad_creatives
    WHERE email_client_id = ?
    ORDER BY created_at DESC, rowid DESC
  `).all(req.params.emailClientId);
  res.json(rows);
});

// ── EDIT one creative's copy ─────────────────────────────────────────────────
router.put('/creatives/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.primary_text !== undefined) { sets.push('primary_text = ?'); vals.push(String(b.primary_text)); }
  if (b.headline !== undefined)     { sets.push('headline = ?');     vals.push(String(b.headline)); }
  if (b.cta !== undefined)          { sets.push('cta = ?');          vals.push(normalizeCta(b.cta)); }
  if (sets.length === 0) return res.json(existing);
  sets.push("updated_at = datetime('now')");
  vals.push(req.params.id);
  db.prepare(`UPDATE facebook_ad_creatives SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json(db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id));
});

// ── REWRITE copy (Claude) ────────────────────────────────────────────────────
router.post('/creatives/:id/regenerate-text', async (req, res) => {
  const c = db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const fa = db.prepare('SELECT rag_content FROM facebook_ads WHERE email_client_id = ?').get(c.email_client_id);
  if (!fa || !fa.rag_content) return res.status(400).json({ error: 'No RAG document for this customer' });
  try {
    const v = await regenerateAdCopy(fa.rag_content, c);
    db.prepare(`UPDATE facebook_ad_creatives SET hook_label=?, primary_text=?, headline=?, cta=?, updated_at=datetime('now') WHERE id=?`)
      .run(v.hook_label, v.primary_text, v.headline, v.cta, req.params.id);
    res.json(db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : 'Rewrite failed' });
  }
});

// ── NEW image (Gemini) ───────────────────────────────────────────────────────
router.post('/creatives/:id/regenerate-image', async (req, res) => {
  const c = db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const customer = loadGenCustomer(c.email_client_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  try {
    const img = await regenerateAdImage(customer, c);
    db.prepare(`UPDATE facebook_ad_creatives SET image_url=?, pre_logo_image_url=?, updated_at=datetime('now') WHERE id=?`)
      .run(img.image_url, img.pre_logo_image_url, req.params.id);
    res.json(db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : 'Image generation failed' });
  }
});

// ── APPROVE / UNAPPROVE ──────────────────────────────────────────────────────
router.post('/creatives/:id/approve', (req, res) => {
  const c = db.prepare('SELECT id FROM facebook_ad_creatives WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE facebook_ad_creatives SET status='approved', updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.json(db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id));
});
router.post('/creatives/:id/unapprove', (req, res) => {
  const c = db.prepare('SELECT id FROM facebook_ad_creatives WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE facebook_ad_creatives SET status='draft', updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.json(db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id));
});

// ── DELETE one creative ──────────────────────────────────────────────────────
router.delete('/creatives/:id', (req, res) => {
  db.prepare('DELETE FROM facebook_ad_creatives WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── BRAND LOGO UPLOAD (per customer) ─────────────────────────────────────────
// Upload the customer's brand logo. Trimmed at upload (same pipeline as the
// LinkedIn logo) and stored on facebook_ads.logo_url. Creates the facebook_ads
// row if it doesn't exist yet.
router.post('/:emailClientId/logo', upload.single('logo'), async (req, res) => {
  const id = req.params.emailClientId;
  const customer = db.prepare('SELECT id FROM email_clients WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!req.file) return res.status(400).json({ error: 'No logo file uploaded' });
  const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'];
  if (!allowed.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Logo must be PNG, JPG, SVG, or WebP' });
  }
  try {
    const prepped = await prepareLogoForStorage(req.file.buffer, req.file.mimetype);
    const logoUrl = await uploadImageToR2(prepped.buffer.toString('base64'), prepped.mimetype, id, 'fblogo');
    const existing = db.prepare('SELECT id FROM facebook_ads WHERE email_client_id = ?').get(id);
    if (existing) {
      db.prepare(`UPDATE facebook_ads SET logo_url = ?, updated_at = datetime('now') WHERE email_client_id = ?`).run(logoUrl, id);
    } else {
      db.prepare(`INSERT INTO facebook_ads (id, email_client_id, status, logo_url) VALUES (?, ?, 'not_connected', ?)`).run(uuid(), id, logoUrl);
      db.prepare(`INSERT OR IGNORE INTO customer_services (email_client_id, service_key, linked_external_id, enabled_by) VALUES (?, 'facebook_ads', NULL, 'admin')`).run(id);
    }
    res.json({ ok: true, logo_url: logoUrl });
  } catch (err) {
    console.error('[facebook-ads] logo upload failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: `Logo upload failed: ${err.message}` });
  }
});

// ── BRAND PANEL DEFAULTS (per customer) ──────────────────────────────────────
// Save the customer's default logo position / background / size. Auto-saved
// from the dropdowns, same as the LinkedIn Brand Panel.
router.put('/:emailClientId/brand', (req, res) => {
  const id = req.params.emailClientId;
  const customer = db.prepare('SELECT id FROM email_clients WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const b = req.body || {};
  if (b.logo_position !== undefined && !POSITIONS.includes(b.logo_position)) return res.status(400).json({ error: 'Invalid position' });
  if (b.logo_panel !== undefined && !PANELS.includes(b.logo_panel)) return res.status(400).json({ error: 'Invalid background' });
  if (b.logo_size !== undefined && !SIZES.includes(b.logo_size)) return res.status(400).json({ error: 'Invalid size' });

  const existing = db.prepare('SELECT id FROM facebook_ads WHERE email_client_id = ?').get(id);
  if (!existing) {
    db.prepare(`INSERT INTO facebook_ads (id, email_client_id, status, logo_position, logo_panel, logo_size) VALUES (?, ?, 'not_connected', ?, ?, ?)`)
      .run(uuid(), id, b.logo_position || 'bottom-right', b.logo_panel || 'white', b.logo_size || 'small');
  } else {
    const sets = [], vals = [];
    for (const col of ['logo_position', 'logo_panel', 'logo_size']) {
      if (b[col] !== undefined) { sets.push(`${col} = ?`); vals.push(b[col]); }
    }
    if (sets.length) {
      sets.push("updated_at = datetime('now')"); vals.push(id);
      db.prepare(`UPDATE facebook_ads SET ${sets.join(', ')} WHERE email_client_id = ?`).run(...vals);
    }
  }
  const row = db.prepare('SELECT logo_position, logo_panel, logo_size FROM facebook_ads WHERE email_client_id = ?').get(id);
  res.json({ ok: true, ...row });
});

// ── RECOMPOSITE LOGO on one creative (instant, no AI) ────────────────────────
// Re-places the logo on the stored pre-logo image with new position/size/
// background — no Gemini call (decision #73 pattern). Stores the override on the
// creative so it persists. 400 if there's no pre-logo image or no logo uploaded.
router.post('/creatives/:id/recomposite-logo', async (req, res) => {
  const c = db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!c.pre_logo_image_url) return res.status(400).json({ error: 'Generate a new image for this ad first, then adjust the logo.' });

  const customer = loadGenCustomer(c.email_client_id);
  if (!customer || !customer.logo_url) return res.status(400).json({ error: 'Upload a brand logo for this customer first.' });

  const b = req.body || {};
  const position = POSITIONS.includes(b.logo_position) ? b.logo_position : (c.logo_position || customer.logo_position);
  const panel    = PANELS.includes(b.logo_panel)       ? b.logo_panel    : (c.logo_panel    || customer.logo_panel);
  const size     = SIZES.includes(b.logo_size)         ? b.logo_size     : (c.logo_size     || customer.logo_size);

  try {
    const out = await recompositeLogoFromUrl(c.pre_logo_image_url, customer, {
      logo_position: position, logo_panel: panel, logo_size: size,
    });
    const imageUrl = await uploadImageToR2(out.data, out.mimeType, c.email_client_id, 'fbad');
    db.prepare(`UPDATE facebook_ad_creatives SET image_url=?, logo_position=?, logo_panel=?, logo_size=?, updated_at=datetime('now') WHERE id=?`)
      .run(imageUrl, position, panel, size, req.params.id);
    res.json(db.prepare('SELECT * FROM facebook_ad_creatives WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : 'Recomposite failed' });
  }
});

export default router;
