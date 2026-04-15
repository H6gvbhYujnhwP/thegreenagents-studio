/**
 * auth.js — Stateless Bearer token auth
 *
 * Every protected request must include:
 *   Authorization: Bearer <STUDIO_PASSWORD>
 *
 * No sessions, no cookies, no server state.
 * Token is stored in the browser's localStorage by the frontend.
 */
export function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (token && token === process.env.STUDIO_PASSWORD) {
    return next();
  }

  res.status(401).json({ error: 'Unauthorised' });
}
