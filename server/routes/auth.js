/**
 * auth.js — Login / check routes
 *
 * Credentials:
 *   username → STUDIO_USERNAME env var (default: "greenagents")
 *   password → STUDIO_PASSWORD env var
 *
 * POST /api/auth/login   { username, password } → { ok, token } or 401
 * GET  /api/auth/check   Authorization: Bearer <token> → { authenticated }
 * POST /api/auth/logout  (client clears localStorage)
 */
import { Router } from 'express';
const router = Router();

function expectedUsername() {
  return process.env.STUDIO_USERNAME || 'greenagents';
}

function expectedPassword() {
  return process.env.STUDIO_PASSWORD || '';
}

router.post('/login', (req, res) => {
  const { username = '', password = '' } = req.body;

  const userOk = username.trim() === expectedUsername();
  const passOk = password        === expectedPassword();

  if (userOk && passOk) {
    return res.json({ ok: true, token: password });
  }

  console.warn(
    `[auth] Failed login — user: "${username}" (${userOk ? '✓' : '✗'}), ` +
    `pass: ${password.length} chars (${passOk ? '✓' : '✗'})`
  );
  res.status(401).json({ error: 'Incorrect username or password' });
});

router.post('/logout', (_req, res) => {
  res.json({ ok: true });
});

router.get('/check', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  res.json({ authenticated: !!(token && token === expectedPassword()) });
});

export default router;
