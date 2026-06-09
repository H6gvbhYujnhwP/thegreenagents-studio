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
import { requireAuth } from '../middleware/auth.js';
import { metaConfigured, testConnection, META } from '../services/meta-api.js';

const router = express.Router();
router.use(requireAuth);

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

export default router;
