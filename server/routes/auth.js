import { Router } from 'express';
const router = Router();

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.STUDIO_PASSWORD) {
    req.session.authenticated = true;
    // Explicitly save session to SQLite BEFORE responding,
    // so the very next request from the client is authenticated.
    req.session.save(err => {
      if (err) {
        console.error('[auth] Session save error:', err);
        return res.status(500).json({ error: 'Session error' });
      }
      res.json({ ok: true });
    });
  } else {
    console.warn('[auth] Failed login attempt');
    res.status(401).json({ error: 'Invalid password' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

export default router;
