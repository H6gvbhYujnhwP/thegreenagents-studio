// ─────────────────────────────────────────────────────────────────────────────
// Facebook Ads (admin) — READ-ONLY reporting (decision #107).
//
// Studio does NOT create or manage ads — Manus AI makes the posts/images and
// builds the campaigns. Studio is a read-only window onto Facebook: it shows
// each customer's live ads + performance. One ad account per customer.
//
// Routes:
//   GET  /connection-status            — is Studio reaching Facebook?
//   GET  /ads?customer=&window=         — a customer's account + ads + stats
//   GET  /customers                     — Facebook Ads roster (+ their account id)
//   GET  /available-customers           — customers you can add
//   POST /:emailClientId/account        — set/clear a customer's ad account id
//
// Mounted at /api/facebook-ads, behind requireAuth.
// ─────────────────────────────────────────────────────────────────────────────
import express from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { metaConfigured, testConnection, getAdsOverview, META } from '../services/meta-api.js';

const router = express.Router();
router.use(requireAuth);

// ── CONNECTION STATUS ────────────────────────────────────────────────────────
router.get('/connection-status', async (req, res) => {
  if (!metaConfigured()) {
    return res.json({ configured: false, ok: false, message: 'Meta API is not configured — META_ACCESS_TOKEN is missing.' });
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

// ── ADS + STATS (read-only) ──────────────────────────────────────────────────
// Scoped to one customer's ad account when ?customer=<email_client_id> is given.
// Without a customer it falls back to the default configured account (handy for
// a quick check). Always 200; a Meta failure comes back as { ok:false, error }.
router.get('/ads', async (req, res) => {
  if (!metaConfigured()) {
    return res.json({ ok: false, configured: false, error: 'Meta API is not configured.' });
  }
  const window = req.query.window || '30d';
  let adAccountId = null;
  if (req.query.customer) {
    const fa = db.prepare('SELECT ad_account_id FROM facebook_ads WHERE email_client_id = ?').get(req.query.customer);
    if (!fa || !fa.ad_account_id) {
      return res.json({ ok: false, configured: true, no_account: true, error: 'No ad account is set for this customer yet.' });
    }
    adAccountId = fa.ad_account_id;
  }
  const overview = await getAdsOverview({ window, adAccountId });
  res.json({ configured: true, ...overview });
});

// ── CUSTOMERS (Facebook Ads roster) ──────────────────────────────────────────
router.get('/customers', (req, res) => {
  const rows = db.prepare(`
    SELECT fa.email_client_id AS id, ec.name, fa.ad_account_id, fa.status
    FROM facebook_ads fa
    JOIN email_clients ec ON ec.id = fa.email_client_id
    ORDER BY ec.name COLLATE NOCASE ASC
  `).all();
  res.json(rows.map(r => ({ ...r, has_account: !!r.ad_account_id })));
});

// ── AVAILABLE CUSTOMERS (to add) ─────────────────────────────────────────────
// Non-hidden customers not already on Facebook Ads, excluding portal anchor rows
// linked to another customer (handles Cube6-style links + Manson-style self-links).
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

// ── SET / CLEAR a customer's ad account id ───────────────────────────────────
// Creates the Facebook Ads record for the customer if needed. Accepts the id
// with or without the 'act_' prefix; stores the bare digits.
router.post('/:emailClientId/account', (req, res) => {
  const id = req.params.emailClientId;
  const ec = db.prepare('SELECT id FROM email_clients WHERE id = ?').get(id);
  if (!ec) return res.status(404).json({ error: 'Customer not found' });

  const raw = (req.body && req.body.ad_account_id !== undefined) ? String(req.body.ad_account_id) : '';
  const acct = raw.trim().replace(/^act_/i, '').replace(/\D/g, '');
  if (!acct) return res.status(400).json({ error: 'Enter the numeric ad account ID (digits, with or without the act_ prefix).' });

  const existing = db.prepare('SELECT id FROM facebook_ads WHERE email_client_id = ?').get(id);
  if (existing) {
    db.prepare(`UPDATE facebook_ads SET ad_account_id = ?, updated_at = datetime('now') WHERE email_client_id = ?`).run(acct, id);
  } else {
    db.prepare(`INSERT INTO facebook_ads (id, email_client_id, status, ad_account_id) VALUES (?, ?, 'not_connected', ?)`).run(uuid(), id, acct);
    db.prepare(`INSERT OR IGNORE INTO customer_services (email_client_id, service_key, linked_external_id, enabled_by) VALUES (?, 'facebook_ads', NULL, 'admin')`).run(id);
  }
  res.json({ ok: true, ad_account_id: acct });
});

export default router;
