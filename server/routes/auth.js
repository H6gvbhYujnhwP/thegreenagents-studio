/**
 * auth.js — Admin login / check / logout
 *
 * Backward-compatible: the original single env login (STUDIO_USERNAME +
 * STUDIO_PASSWORD) still works and returns token = STUDIO_PASSWORD, so Wez's
 * existing saved session keeps working untouched. That env login is the
 * permanent break-glass SUPER-ADMIN.
 *
 * Named staff (rows in admin_users) log in with their own username + bcrypt
 * password and receive a random session token backed by admin_sessions.
 *
 * POST /api/auth/login   { username, password } → { ok, token, user } or 401
 * GET  /api/auth/check   Bearer/?token=          → { authenticated, user? }
 * POST /api/auth/logout  Bearer/?token=          → { ok } (kills staff session)
 */
import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import db from '../db.js';
import { resolveAdmin } from '../middleware/auth.js';

const router = Router();
const IDLE_DAYS = 7;

function expectedUsername() { return process.env.STUDIO_USERNAME || 'greenagents'; }
function expectedPassword() { return process.env.STUDIO_PASSWORD || ''; }
function newToken() { return crypto.randomBytes(32).toString('base64url'); }

function projectAdmin(a) {
  return {
    username: a.username,
    email: a.email || null,
    is_super: a.is_super ? 1 : 0,
    access: a.access,            // 'ALL' or { key: true }
  };
}

router.post('/login', async (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';

  // 1) break-glass env super-admin (unchanged behaviour, unchanged token)
  if (username === expectedUsername() && expectedPassword() && password === expectedPassword()) {
    return res.json({
      ok: true,
      token: expectedPassword(),
      user: { username: expectedUsername(), email: null, is_super: 1, access: 'ALL' },
    });
  }

  // 2) named staff account
  const u = db.prepare(`SELECT * FROM admin_users WHERE LOWER(username) = LOWER(?)`).get(username);
  if (u && !u.disabled_at) {
    const ok = await bcrypt.compare(password, u.password_hash);
    if (ok) {
      const token = newToken();
      const expires = db.prepare(`SELECT datetime('now', '+${IDLE_DAYS} days') AS t`).get().t;
      db.prepare(`INSERT INTO admin_sessions (id, admin_user_id, expires_at) VALUES (?, ?, ?)`)
        .run(token, u.id, expires);
      db.prepare(`UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?`).run(u.id);
      let access = {};
      if (u.is_super) access = 'ALL';
      else { try { access = JSON.parse(u.access_json || '{}'); } catch { access = {}; } }
      return res.json({
        ok: true,
        token,
        user: { username: u.username, email: u.email || null, is_super: u.is_super, access },
      });
    }
  }

  console.warn(`[auth] Failed login — user: "${username}"`);
  res.status(401).json({ error: 'Incorrect username or password' });
});

router.post('/logout', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token = (header.startsWith('Bearer ') ? header.slice(7).trim() : '') || (req.body?.token || '');
  if (token && token !== expectedPassword()) {
    try { db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(token); } catch (_) {}
  }
  res.json({ ok: true });
});

router.get('/check', (req, res) => {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token = bearer || (req.query?.token || '').trim();
  const admin = resolveAdmin(token);
  if (!admin) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: projectAdmin(admin) });
});

export default router;
