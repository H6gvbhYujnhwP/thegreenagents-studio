import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, '../data/studio.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT NOT NULL,
    website TEXT,
    supergrow_workspace_name TEXT,
    supergrow_workspace_id TEXT NOT NULL,
    supergrow_api_key TEXT NOT NULL,
    timezone TEXT DEFAULT 'Europe/London',
    cadence TEXT DEFAULT 'Daily',
    posting_identity TEXT DEFAULT 'personal',
    approval_mode TEXT DEFAULT 'auto',
    rag_filename TEXT,
    rag_content TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    stage TEXT DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    total_posts INTEGER DEFAULT 96,
    posts_generated INTEGER DEFAULT 0,
    images_generated INTEGER DEFAULT 0,
    posts_deployed INTEGER DEFAULT 0,
    posts_json TEXT,
    error_log TEXT,
    files_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );
`);

// ── Email module tables ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS email_lists (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_email TEXT NOT NULL,
    reply_to TEXT NOT NULL,
    subscriber_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS email_subscribers (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    status TEXT DEFAULT 'subscribed',
    created_at TEXT DEFAULT (datetime('now')),
    unsubscribed_at TEXT,
    bounced_at TEXT,
    FOREIGN KEY (list_id) REFERENCES email_lists(id),
    UNIQUE(list_id, email)
  );

  CREATE TABLE IF NOT EXISTS email_campaigns (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    list_id TEXT NOT NULL,
    title TEXT NOT NULL,
    subject TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_email TEXT NOT NULL,
    reply_to TEXT NOT NULL,
    html_body TEXT NOT NULL,
    plain_body TEXT,
    status TEXT DEFAULT 'draft',
    scheduled_at TEXT,
    sent_at TEXT,
    sent_count INTEGER DEFAULT 0,
    open_count INTEGER DEFAULT 0,
    click_count INTEGER DEFAULT 0,
    bounce_count INTEGER DEFAULT 0,
    unsubscribe_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id),
    FOREIGN KEY (list_id) REFERENCES email_lists(id)
  );

  CREATE TABLE IF NOT EXISTS email_sends (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    status TEXT DEFAULT 'sent',
    opened_at TEXT,
    clicked_at TEXT,
    bounced_at TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES email_campaigns(id),
    FOREIGN KEY (subscriber_id) REFERENCES email_subscribers(id)
  );
`);

export default db;
