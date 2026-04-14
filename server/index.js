import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import campaignRoutes from './routes/campaigns.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// ── Minimal SQLite session store — no extra package, uses the existing db ───
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id      TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  )
`);

// Purge expired sessions once an hour
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
}, 60 * 60 * 1000);

class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE id = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;
      db.prepare('INSERT OR REPLACE INTO sessions (id, data, expires) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new SqliteStore(),
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
  }
}));

app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/campaigns', campaignRoutes);

const distPath = join(__dirname, '../dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Green Agents Studio running on port ${PORT}`);
  console.log(`[env] SUPERGROW_MCP_URL: ${process.env.SUPERGROW_MCP_URL ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] DB_PATH: ${process.env.DB_PATH || '(default)'}`);
});
