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
// email_clients is completely separate from the LinkedIn 'clients' table
db.exec(`
  CREATE TABLE IF NOT EXISTS email_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#1D9E75',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_brands (
    id TEXT PRIMARY KEY,
    email_client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_email TEXT NOT NULL,
    reply_to TEXT NOT NULL,
    color TEXT DEFAULT '#1D9E75',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (email_client_id) REFERENCES email_clients(id)
  );

  CREATE TABLE IF NOT EXISTS email_lists (
    id TEXT PRIMARY KEY,
    email_client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_email TEXT NOT NULL,
    reply_to TEXT NOT NULL,
    subscriber_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (email_client_id) REFERENCES email_clients(id)
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
    email_client_id TEXT NOT NULL,
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
    FOREIGN KEY (email_client_id) REFERENCES email_clients(id),
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

// ── Migrations — safe to run on every startup ─────────────────────────────────
// These handle upgrading an existing database that has the old schema.

// 1. Create email_clients table if it doesn't exist yet
db.exec(`
  CREATE TABLE IF NOT EXISTS email_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#1D9E75',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// 2. For each email table, add email_client_id column if it's missing
//    (SQLite doesn't support ALTER TABLE DROP COLUMN before 3.35, so we just ADD)
const migrations = [
  { table: 'email_brands',    col: 'email_client_id', def: "TEXT NOT NULL DEFAULT ''" },
  { table: 'email_lists',     col: 'email_client_id', def: "TEXT NOT NULL DEFAULT ''" },
  { table: 'email_campaigns', col: 'email_client_id', def: "TEXT NOT NULL DEFAULT ''" },
];

for (const { table, col, def } of migrations) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`[db] migration: added ${col} to ${table}`);
  }
}

// 3. Fix email_lists — old table has client_id as NOT NULL which blocks inserts.
//    Recreate it without that constraint if client_id column still exists.
{
  const listCols = db.prepare('PRAGMA table_info(email_lists)').all().map(r => r.name);
  if (listCols.includes('client_id')) {
    console.log('[db] migration: rebuilding email_lists to remove old client_id constraint');
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_lists_new (
        id TEXT PRIMARY KEY,
        email_client_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        from_name TEXT NOT NULL,
        from_email TEXT NOT NULL,
        reply_to TEXT NOT NULL,
        subscriber_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO email_lists_new (id, email_client_id, name, from_name, from_email, reply_to, subscriber_count, created_at)
        SELECT id, COALESCE(email_client_id,''), name, from_name, from_email, reply_to, subscriber_count, created_at
        FROM email_lists;
      DROP TABLE email_lists;
      ALTER TABLE email_lists_new RENAME TO email_lists;
    `);
    console.log('[db] migration: email_lists rebuilt successfully');
  }
}

// 5. Fix email_campaigns — same old client_id constraint issue
{
  const campCols = db.prepare('PRAGMA table_info(email_campaigns)').all().map(r => r.name);
  if (campCols.includes('client_id')) {
    console.log('[db] migration: rebuilding email_campaigns to remove old client_id constraint');
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_campaigns_new (
        id TEXT PRIMARY KEY,
        email_client_id TEXT NOT NULL DEFAULT '',
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
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO email_campaigns_new
        SELECT id, COALESCE(email_client_id,''), list_id, title, subject, from_name, from_email, reply_to, html_body, plain_body, status, scheduled_at, sent_at, sent_count, open_count, click_count, bounce_count, unsubscribe_count, created_at
        FROM email_campaigns;
      DROP TABLE email_campaigns;
      ALTER TABLE email_campaigns_new RENAME TO email_campaigns;
    `);
    console.log('[db] migration: email_campaigns rebuilt successfully');
  }
}

// 7. Add drip/queue columns to email_campaigns
{
  const campCols = db.prepare('PRAGMA table_info(email_campaigns)').all().map(r => r.name);
  const toAdd = [
    { col:'daily_limit',    def:'INTEGER DEFAULT 0' },
    { col:'queue_position', def:'INTEGER DEFAULT 0' },
    { col:'drip_start_at',  def:'TEXT' },
    { col:'drip_sent',      def:'INTEGER DEFAULT 0' },
    { col:'send_order',     def:"TEXT DEFAULT 'top'" },
    { col:'spam_count',     def:'INTEGER DEFAULT 0' },
  ];
  for (const { col, def } of toAdd) {
    if (!campCols.includes(col)) {
      db.exec(`ALTER TABLE email_campaigns ADD COLUMN ${col} ${def}`);
      console.log(`[db] migration: added ${col} to email_campaigns`);
    }
  }
}

// 8. Create email_link_clicks table for tracking per-link stats
db.exec(`
  CREATE TABLE IF NOT EXISTS email_link_clicks (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    url TEXT NOT NULL,
    clicked_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES email_campaigns(id),
    FOREIGN KEY (subscriber_id) REFERENCES email_subscribers(id)
  );
`);
{
  const subCols = db.prepare('PRAGMA table_info(email_subscribers)').all().map(r => r.name);
  if (!subCols.includes('spam_at')) {
    db.exec(`ALTER TABLE email_subscribers ADD COLUMN spam_at TEXT`);
    console.log('[db] migration: added spam_at to email_subscribers');
  }
}

// 9. Add test_email to email_clients for per-client test send persistence
{
  const cols = db.prepare('PRAGMA table_info(email_clients)').all().map(r => r.name);
  if (!cols.includes('test_email')) {
    db.exec(`ALTER TABLE email_clients ADD COLUMN test_email TEXT`);
    console.log('[db] migration: added test_email to email_clients');
  }
}

export default db;
