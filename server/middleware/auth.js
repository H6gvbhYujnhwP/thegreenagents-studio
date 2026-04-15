// AUTH TEMPORARILY DISABLED FOR TESTING
// To re-enable: restore the commented block below and remove the passthrough
export function requireAuth(req, res, next) {
  return next(); // passthrough — no auth required

  // ── Restore this to re-enable auth ──────────────────────────────────────
  // if (req.session && req.session.authenticated) return next();
  // res.status(401).json({ error: 'Unauthorised' });
}
