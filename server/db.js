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

// ── Logo column migration (added for logo overlay feature) ──────────────────
db.exec(`ALTER TABLE clients ADD COLUMN logo_url TEXT`);

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
    // Phase 4 drip-schedule columns ─────────────────────────────────────────
    // drip_send_days: comma-separated list of weekdays the ticker may send on.
    //   Format: "0,1,2,3,4,5,6" with 0=Sun, 1=Mon, ..., 6=Sat (matches JS Date.getDay()).
    //   Default Mon-Fri so cold outreach defaults to business days.
    { col:'drip_send_days',     def:"TEXT DEFAULT '1,2,3,4,5'" },
    // drip_window_start / drip_window_end: HH:MM strings in the campaign's timezone.
    // The ticker sends randomly-jittered emails between these times each active day.
    { col:'drip_window_start',  def:"TEXT DEFAULT '09:00'" },
    { col:'drip_window_end',    def:"TEXT DEFAULT '11:00'" },
    // drip_timezone: IANA zone, e.g. 'Europe/London'. Used so DST handles itself.
    { col:'drip_timezone',      def:"TEXT DEFAULT 'Europe/London'" },
    // drip_today_date / drip_today_sent: per-day quota counter. drip_today_date is
    // the calendar date (YYYY-MM-DD in the campaign's tz) that drip_today_sent applies
    // to. The ticker resets drip_today_sent to 0 when it first sees a new date.
    { col:'drip_today_date',    def:'TEXT' },
    { col:'drip_today_sent',    def:'INTEGER DEFAULT 0' },
    // drip_last_tick_at: diagnostic — last time the ticker considered this campaign.
    { col:'drip_last_tick_at',  def:'TEXT' },
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
  // Phase 4 — first_name caching for {{first_name}} placeholder personalisation.
  // first_name = the parsed Christian name; NULL means we couldn't parse it and
  //   the subscriber will be skipped from any campaign that uses {{first_name}}.
  // first_name_source = 'rule' | 'ai' | 'skip' | 'manual' — provenance.
  // first_name_reason = human-readable explanation (for the preview UI).
  if (!subCols.includes('first_name')) {
    db.exec(`ALTER TABLE email_subscribers ADD COLUMN first_name TEXT`);
    console.log('[db] migration: added first_name to email_subscribers');
  }
  if (!subCols.includes('first_name_source')) {
    db.exec(`ALTER TABLE email_subscribers ADD COLUMN first_name_source TEXT`);
    console.log('[db] migration: added first_name_source to email_subscribers');
  }
  if (!subCols.includes('first_name_reason')) {
    db.exec(`ALTER TABLE email_subscribers ADD COLUMN first_name_reason TEXT`);
    console.log('[db] migration: added first_name_reason to email_subscribers');
  }
}

// 9. Add test_email to email_clients for per-client test send persistence
{
  const cols = db.prepare('PRAGMA table_info(email_clients)').all().map(r => r.name);
  if (!cols.includes('test_email')) {
    db.exec(`ALTER TABLE email_clients ADD COLUMN test_email TEXT`);
    console.log('[db] migration: added test_email to email_clients');
  }
  // default_from_email: the address every campaign on this client defaults to using
  // for both From and Reply-To. Saves typing and prevents typos. Per request 1 the
  // user only sends from one address per domain identity, so this is the natural
  // place to remember it once.
  if (!cols.includes('default_from_email')) {
    db.exec(`ALTER TABLE email_clients ADD COLUMN default_from_email TEXT`);
    console.log('[db] migration: added default_from_email to email_clients');
  }
  // default_from_name: paired with default_from_email so the From line renders as
  // "John Wicks <john@clearerpaths.co.uk>" without re-typing both halves.
  if (!cols.includes('default_from_name')) {
    db.exec(`ALTER TABLE email_clients ADD COLUMN default_from_name TEXT`);
    console.log('[db] migration: added default_from_name to email_clients');
  }
}

// ── 10. TRACKING (open/click/bounce/spam) ─────────────────────────────────────
// New tables + columns for own-domain tracking, mirroring Sendy's approach.

// 10a. email_sends.message_id — SES MessageId, used to map SNS bounce/complaint
//     notifications back to the right subscriber. Nothing else uses it.
{
  const sendCols = db.prepare('PRAGMA table_info(email_sends)').all().map(r => r.name);
  if (!sendCols.includes('message_id')) {
    db.exec(`ALTER TABLE email_sends ADD COLUMN message_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_email_sends_message_id ON email_sends(message_id)`);
    console.log('[db] migration: added message_id to email_sends');
  }
  // Useful for the "did we already record this open" check on the open pixel
  if (!sendCols.includes('open_count')) {
    db.exec(`ALTER TABLE email_sends ADD COLUMN open_count INTEGER DEFAULT 0`);
    console.log('[db] migration: added open_count to email_sends');
  }
  if (!sendCols.includes('click_count')) {
    db.exec(`ALTER TABLE email_sends ADD COLUMN click_count INTEGER DEFAULT 0`);
    console.log('[db] migration: added click_count to email_sends');
  }
}

// 10b. email_campaign_links — hash → original URL, per campaign.
//     Lets click links stay short in emails; we look up the destination on click.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_campaign_links (
    hash TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (campaign_id, hash)
  );
`);

// 10c. email_sns_events — raw log of every SNS notification we receive.
//     Append-only, used for debugging when a bounce/complaint didn't take effect.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_sns_events (
    id TEXT PRIMARY KEY,
    type TEXT,
    message_id TEXT,
    payload TEXT,
    received_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_sns_events_message_id ON email_sns_events(message_id);
`);

// ── 11. PER-CAMPAIGN TRACKING RULES ──────────────────────────────────────────
// Adds the four tracking-control columns to email_campaigns:
//   - tracking_mode       : 'off' | 'smart' | 'all'  (default 'off' — safest)
//   - tracking_threshold  : INT — minimum touch count for tracking in 'smart' mode
//   - tracking_window     : INT — months to look back when counting touches (0 = all time)
//   - track_opens / track_clicks / track_unsub : individual fine-grained toggles
// When tracking_mode='off' the three boolean toggles are ignored (no tracking).
// When 'smart' or 'all' they decide which signals to inject for eligible recipients.
{
  const cols = db.prepare('PRAGMA table_info(email_campaigns)').all().map(r => r.name);
  const toAdd = [
    { col: 'tracking_mode',      def: "TEXT DEFAULT 'off'" },
    { col: 'tracking_threshold', def: 'INTEGER DEFAULT 3' },
    { col: 'tracking_window',    def: 'INTEGER DEFAULT 6' },
    { col: 'track_opens',        def: 'INTEGER DEFAULT 0' },
    { col: 'track_clicks',       def: 'INTEGER DEFAULT 0' },
    { col: 'track_unsub',        def: 'INTEGER DEFAULT 0' },
  ];
  for (const { col, def } of toAdd) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE email_campaigns ADD COLUMN ${col} ${def}`);
      console.log(`[db] migration: added ${col} to email_campaigns`);
    }
  }
}

// ── 12. PER-LIST "ALWAYS WARM" OVERRIDE ──────────────────────────────────────
// When set on a list, every subscriber on that list is treated as warm regardless
// of their actual touch count. Used for e.g. "existing customers" or "newsletter
// subscribers" lists where everyone has an established relationship with us.
{
  const cols = db.prepare('PRAGMA table_info(email_lists)').all().map(r => r.name);
  if (!cols.includes('always_warm')) {
    db.exec(`ALTER TABLE email_lists ADD COLUMN always_warm INTEGER DEFAULT 0`);
    console.log('[db] migration: added always_warm to email_lists');
  }
}

// Index on email_sends(subscriber_id, status, sent_at) for efficient touch-count lookups
db.exec(`CREATE INDEX IF NOT EXISTS idx_email_sends_subscriber_status_sent_at
         ON email_sends(subscriber_id, status, sent_at)`);

// ── 13. INBOX MONITORING TABLES (replies, prospects, auto-unsubscribe) ───────
// One row per connected Gmail/Workspace mailbox. The app password is encrypted
// at rest with a master key from MAILBOX_ENCRYPTION_KEY env var.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_inboxes (
    id TEXT PRIMARY KEY,
    email_client_id TEXT NOT NULL,
    email_address TEXT NOT NULL UNIQUE,
    app_password_encrypted TEXT NOT NULL,
    imap_host TEXT NOT NULL DEFAULT 'imap.gmail.com',
    imap_port INTEGER NOT NULL DEFAULT 993,
    enabled INTEGER NOT NULL DEFAULT 1,
    connected_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_polled_at TEXT,
    last_error TEXT,
    last_uid INTEGER DEFAULT 0,
    FOREIGN KEY (email_client_id) REFERENCES email_clients(id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_inboxes_enabled ON email_inboxes(enabled);
`);

// One row per reply received. The reply is matched to a subscriber/campaign
// via the In-Reply-To and References headers, when possible. Some replies
// (e.g. from someone forwarded to) won't match — they're still stored.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_replies (
    id TEXT PRIMARY KEY,
    inbox_id TEXT NOT NULL,
    email_client_id TEXT NOT NULL,
    message_id TEXT,
    in_reply_to TEXT,
    references_header TEXT,
    from_address TEXT NOT NULL,
    from_name TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    received_at TEXT NOT NULL,
    matched_subscriber_id TEXT,
    matched_campaign_id TEXT,
    classification TEXT,         /* 'positive' | 'hard_negative' | 'soft_negative' | 'auto_reply' | 'forwarding' | 'neutral' | NULL */
    classification_confidence REAL,
    classification_reason TEXT,
    auto_unsubscribed INTEGER NOT NULL DEFAULT 0,
    handled_at TEXT,
    handled_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id),
    FOREIGN KEY (email_client_id) REFERENCES email_clients(id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_replies_inbox_received ON email_replies(inbox_id, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_email_replies_unhandled ON email_replies(email_client_id, classification, handled_at);
  CREATE INDEX IF NOT EXISTS idx_email_replies_message_id ON email_replies(message_id);
`);

// Append-only audit log. Records every consequential action: auto-unsubscribes,
// manual reclassifications, manual unsubscribes, mailbox connect/disconnect.
// Used so you can answer "why did this person get unsubscribed?" months later.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_audit_log (
    id TEXT PRIMARY KEY,
    actor TEXT,                  /* 'system' for auto, or user identifier for manual */
    action TEXT NOT NULL,        /* 'auto_unsubscribe' | 'manual_unsubscribe' | 'mark_handled' | 'reclassify' | 'connect_mailbox' | etc. */
    target_type TEXT,            /* 'subscriber' | 'reply' | 'mailbox' */
    target_id TEXT,
    reply_id TEXT,
    metadata TEXT,               /* JSON blob for extra context */
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_audit_log_target ON email_audit_log(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_email_audit_log_created ON email_audit_log(created_at DESC);
`);

// ── Phase 4: multi-step follow-up sequences ─────────────────────────────────
//
// Each campaign can now have N steps (1st contact, 2nd contact, etc.). Step 1
// is auto-migrated from the existing email_campaigns.html_body so existing
// campaigns keep working unchanged. Steps 2+ live only in this table.
//
// delay_days: how many days after the previous step's send to fire this step.
//   Step 1 has delay_days=0 (it's the start).
//   The drip ticker reads this column to decide when each recipient is due.
//
// We don't store subject/from per step — those are campaign-wide (user's call).
// Threading headers (In-Reply-To, References) make follow-ups display as
// "Re: <campaign subject>" in Gmail/Outlook automatically.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_campaign_steps (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    html_body TEXT NOT NULL,
    delay_days INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES email_campaigns(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_email_campaign_steps_lookup ON email_campaign_steps(campaign_id, step_number);
`);

// step_number on email_sends so we can tell which step each row was generated by.
// Defaults to 1 for backwards compat with all pre-Phase-4 sends.
{
  const sendCols = db.prepare('PRAGMA table_info(email_sends)').all().map(r => r.name);
  if (!sendCols.includes('step_number')) {
    db.exec(`ALTER TABLE email_sends ADD COLUMN step_number INTEGER NOT NULL DEFAULT 1`);
    console.log('[db] migration: added step_number to email_sends');
  }
  // Index for fast "what's the latest step this person got on this campaign?" lookups.
  // Used by the drip ticker on every tick to figure out who's due for a follow-up.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_email_sends_campaign_subscriber_step ON email_sends(campaign_id, subscriber_id, step_number)`);
}

// Backfill: any existing campaign without a step row gets one auto-created from
// its existing html_body. Idempotent — re-runs are safe because of the UNIQUE
// index on (campaign_id, step_number). Runs every boot but only writes once
// per campaign on the first boot after this migration ships.
{
  const campaignsNeedingStep1 = db.prepare(`
    SELECT c.id, c.html_body
    FROM email_campaigns c
    LEFT JOIN email_campaign_steps s ON s.campaign_id = c.id AND s.step_number = 1
    WHERE s.id IS NULL
  `).all();
  if (campaignsNeedingStep1.length > 0) {
    const insertStep = db.prepare(`
      INSERT INTO email_campaign_steps (id, campaign_id, step_number, html_body, delay_days)
      VALUES (?, ?, 1, ?, 0)
    `);
    const tx = db.transaction((rows) => {
      for (const row of rows) {
        const stepId = `step_${row.id}_1_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        insertStep.run(stepId, row.id, row.html_body || '');
      }
    });
    tx(campaignsNeedingStep1);
    console.log(`[db] migration: backfilled step 1 for ${campaignsNeedingStep1.length} existing campaign(s)`);
  }
}

// Reset any stuck algorithm analysis runs on startup
// Also clear any partial/garbage brief (valid brief starts with # LinkedIn Algorithm)
db.prepare("UPDATE linkedin_settings SET brief_running = 0 WHERE id = 1").run();
{
  const row = db.prepare("SELECT algorithm_brief FROM linkedin_settings WHERE id = 1").get();
  if (row?.algorithm_brief && !row.algorithm_brief.trim().startsWith('#')) {
    db.prepare("UPDATE linkedin_settings SET algorithm_brief = NULL, brief_updated_at = NULL WHERE id = 1").run();
    console.log('[db] Cleared invalid algorithm brief (did not start with #)');
  }
}

export default db;

// ── LinkedIn Algorithm Brief ──────────────────────────────────────────────────
// Single-row settings table that stores the latest algorithm brief from
// the Marketing Analyst Agent. Injected into every Claude campaign call.
db.exec(`
  CREATE TABLE IF NOT EXISTS linkedin_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    algorithm_brief TEXT,
    brief_updated_at TEXT,
    brief_running INTEGER DEFAULT 0
  );
  INSERT OR IGNORE INTO linkedin_settings (id) VALUES (1);
`);
