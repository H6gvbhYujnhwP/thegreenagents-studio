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
import { metaConfigured, testConnection, getAdsOverview, META } from '../services/meta-api.js';
import { generateAdCreatives, regenerateAdCopy, regenerateAdImage } from '../services/facebook-ads-gen.js';
import { ALLOWED_CTAS, normalizeCta } from '../services/facebook-ads-playbook.js';

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
           (fa.rag_content IS NOT NULL AND fa.rag_content != '') AS has_rag
    FROM facebook_ads fa
    JOIN email_clients ec ON ec.id = fa.email_client_id
    ORDER BY ec.name COLLATE NOCASE ASC
  `).all();
  res.json(rows.map(r => ({ ...r, has_rag: !!r.has_rag })));
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
  const customer = db.prepare('SELECT id, name, logo_url FROM email_clients WHERE id = ?').get(id);
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
  const customer = db.prepare('SELECT id, name, logo_url FROM email_clients WHERE id = ?').get(c.email_client_id);
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

export default router;
