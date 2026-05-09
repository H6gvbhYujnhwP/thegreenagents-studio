/**
 * idyq-bridge.js — Mints short-lived bridge tickets for the IDYQ admin embed.
 *
 * Mounted at /api/idyq-bridge in server/index.js. The frontend
 * (src/components/apps/IDYQAdmin.jsx) calls GET /url after the user is admin-
 * authed in Studio. We sign a 60-second HMAC ticket with IDYQ_BRIDGE_SECRET
 * and return a full URL pointing at idoyourquotes.com/admin-bridge?ticket=…
 * which the iframe loads.
 *
 * The IDYQ server has a matching /admin-bridge endpoint that verifies the
 * ticket with the same shared secret, mints an IDYQ session cookie for the
 * bridge admin user, and redirects to /manage-7k9x2m4q8r. End result: iframe
 * lands on IDYQ's admin panel already signed in, no login screen.
 *
 * Ticket format:  <expiry-unix-seconds>.<random-nonce>.<HMAC-SHA256-hex>
 * where the HMAC is computed over "<expiry>.<nonce>" using the shared secret.
 *
 * Env vars:
 *   IDYQ_BRIDGE_SECRET  (required) — long random hex, must match
 *                                    STUDIO_BRIDGE_SECRET on IDYQ's Render env
 *   IDYQ_BASE_URL       (optional) — defaults to https://idoyourquotes.com
 *                                    Override for staging/dev environments
 */
import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// 60-second TTL is short enough that a leaked URL replay window is tiny but
// long enough that slow networks don't expire the ticket between mint and use.
const TICKET_TTL_SECONDS = 60;

router.get('/url', (req, res) => {
  const secret = process.env.IDYQ_BRIDGE_SECRET;
  if (!secret) {
    return res.status(500).json({
      error: 'IDYQ_BRIDGE_SECRET env var not set on Studio',
    });
  }
  const baseUrl = (process.env.IDYQ_BASE_URL || 'https://idoyourquotes.com').replace(/\/+$/, '');

  const expiry = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const nonce  = crypto.randomBytes(16).toString('hex');
  const payload   = `${expiry}.${nonce}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const ticket    = `${payload}.${signature}`;

  const url = `${baseUrl}/admin-bridge?ticket=${encodeURIComponent(ticket)}`;
  res.json({ url });
});

export default router;
