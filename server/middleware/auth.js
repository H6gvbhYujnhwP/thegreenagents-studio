/**
 * auth.js — Admin authentication middleware
 *
 * Two kinds of valid token, both presented exactly the way the app always has:
 *   Authorization: Bearer <token>   (regular fetch)
 *   ?token=<token>                  (EventSource/SSE — can't set headers)
 *
 * 1) BREAK-GLASS SUPER-ADMIN (unchanged, stateless): token === STUDIO_PASSWORD.
 *    The original single login. Can never be locked out, always full access.
 *    Wez keeps signing in exactly as before.
 *
 * 2) NAMED STAFF SESSION: token matches a live row in admin_sessions → resolves
 *    to that admin_users row + its per-section access map. Idle expiry slides
 *    forward 7 days on each use; absolute cap 30 days from creation.
 *
 * On success req.adminUser is attached:
 *   { id, username, is_super, access }  where access is 'ALL' (super) or a
 *   { section_key: true } object.
 */
import db from '../db.js';

const IDLE_DAYS = 7;
const ABSOLUTE_DAYS = 30;

function tokenFrom(req) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const query  = (req.query?.token || '').trim();
  return bearer || query;
}

/**
 * Resolve a token to an adminUser, or null. Exported so the /check route and
 * any future consumer share ONE implementation. Slides session expiry on hit.
 */
export function resolveAdmin(token) {
  if (!token) return null;

  // 1) break-glass env super-admin
  if (process.env.STUDIO_PASSWORD && token === process.env.STUDIO_PASSWORD) {
    return {
      id: '__super__',
      username: process.env.STUDIO_USERNAME || 'greenagents',
      email: null,
      is_super: 1,
      access: 'ALL',
      synthetic: true,
    };
  }

  // 2) named staff session
  const sess = db.prepare(`
    SELECT id, admin_user_id,
           datetime('now') AS now,
           datetime(created_at, '+${ABSOLUTE_DAYS} days') AS hard_cap
    FROM admin_sessions
    WHERE id = ? AND expires_at > datetime('now')
  `).get(token);
  if (!sess) return null;
  if (sess.now > sess.hard_cap) {
    db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(token);
    return null;
  }

  const u = db.prepare(`
    SELECT id, username, email, is_super, access_json, disabled_at
    FROM admin_users WHERE id = ?
  `).get(sess.admin_user_id);
  if (!u || u.disabled_at) {
    db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(token);
    return null;
  }

  // slide idle expiry forward, never past the 30-day hard cap
  db.prepare(`
    UPDATE admin_sessions
    SET expires_at = MIN(datetime('now', '+${IDLE_DAYS} days'),
                         datetime(created_at, '+${ABSOLUTE_DAYS} days'))
    WHERE id = ?
  `).run(token);

  let access = {};
  if (u.is_super) access = 'ALL';
  else { try { access = JSON.parse(u.access_json || '{}'); } catch { access = {}; } }

  return { id: u.id, username: u.username, email: u.email, is_super: u.is_super, access };
}

export function requireAuth(req, res, next) {
  const admin = resolveAdmin(tokenFrom(req));
  if (!admin) return res.status(401).json({ error: 'Unauthorised' });
  req.adminUser = admin;
  next();
}

/** Only the break-glass super OR an is_super staff member may pass. */
export function requireSuperAdmin(req, res, next) {
  const admin = resolveAdmin(tokenFrom(req));
  if (!admin) return res.status(401).json({ error: 'Unauthorised' });
  if (!admin.is_super) return res.status(403).json({ error: 'Super-admin only' });
  req.adminUser = admin;
  next();
}

/**
 * Gate a route on a specific sidebar section key. Ready for per-section
 * backend enforcement on existing routes; super-admins always pass.
 * (Phase 1 uses this only for the staff-management routes via requireSuperAdmin;
 *  wiring it onto the older sections is a per-section follow-up.)
 */
export function requireAccess(sectionKey) {
  return function (req, res, next) {
    const admin = resolveAdmin(tokenFrom(req));
    if (!admin) return res.status(401).json({ error: 'Unauthorised' });
    if (admin.access !== 'ALL' && !(admin.access && admin.access[sectionKey])) {
      return res.status(403).json({ error: 'No access to this section' });
    }
    req.adminUser = admin;
    next();
  };
}
