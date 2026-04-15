/**
 * auth.js — Login / check routes
 *
 * POST /api/auth/login   { password } → { ok: true, token } or 401
 * GET  /api/auth/check   Authorization: Bearer <token> → { authenticated: bool }
 * POST /api/auth/logout  (no-op — client just deletes localStorage token)
 */
import { Router } from 'express';
const router = Router();

router.post('/login', (req, res) => {
  const { password } = req.body;
  const expected = process.env.STUDIO_PASSWORD || '';

  if (password && password === expected) {
    return res.json({ ok: true, token: password });
  }

  const got = (password || '').length;
  const exp = expected.length;
  console.warn(`[auth] Failed login — got ${got} chars, expected ${exp} chars`);
  res.status(401).json({ error: 'Incorrect password' });
});

router.post('/logout', (req, res) => {
  // Stateless — client clears its own localStorage token
  res.json({ ok: true });
});

router.get('/check', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  res.json({ authenticated: !!(token && token === process.env.STUDIO_PASSWORD) });
});

export default router;
