/**
 * auth.js — Stateless Bearer token auth
 *
 * Accepts token via:
 *   1. Authorization: Bearer <token>  header  (all regular fetch calls)
 *   2. ?token=<token>                 query param  (EventSource/SSE — browser API cannot set headers)
 */
export function requireAuth(req, res, next) {
  const header  = req.headers['authorization'] || '';
  const bearer  = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const query   = (req.query?.token || '').trim();
  const token   = bearer || query;

  if (token && token === process.env.STUDIO_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorised' });
}
