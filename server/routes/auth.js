import { Router } from 'express';
const router = Router();

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.STUDIO_PASSWORD) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    // Log length mismatch to help diagnose env var vs typed password issues
    const expected = (process.env.STUDIO_PASSWORD || '').length;
    const received = (password || '').length;
    console.warn(`[auth] Failed login attempt — received ${received} chars, expected ${expected} chars`);
    res.status(401).json({ error: 'Invalid password' });
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

export default router;
