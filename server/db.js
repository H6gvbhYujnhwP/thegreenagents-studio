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
try { db.exec('ALTER TABLE clients ADD COLUMN logo_url TEXT'); } catch (_) {}

// ── deployed_by column migration ──────────────────────────────────────────────
// Records which side of the platform deployed a finished campaign:
//   'admin'  — admin clicked the deploy-to-Supergrow button on the review screen
//   'portal' — customer clicked Approve all in their portal, posts auto-pushed
// Used by the admin campaign-card status pill so support can tell at a glance
// whether the operator finished the campaign or the customer self-served.
try { db.exec("ALTER TABLE campaigns ADD COLUMN deployed_by TEXT"); } catch (_) {}

// ── One-shot fix: collapse legacy 'deployed' stage into 'done' ────────────────
// During customer-portal chunk 3b, the approve-all flow set stage='deployed'.
// That value isn't recognised by the admin's CampaignProgress UI (which knows
// 'awaiting_approval' → 'deploying' → 'done'), so deployed campaigns showed up
// with a broken progress bar and re-rendered the post-edit grid as if the
// campaign were still mid-flight. The decision was to collapse 'deployed' into
// 'done' (the existing terminal stage) and use the new deployed_by column to
// distinguish the two paths instead. This UPDATE backfills any campaigns that
// were already approved via the portal during testing.
try {
  db.prepare(`
    UPDATE campaigns
       SET stage = 'done',
           status = 'completed',
           deployed_by = COALESCE(deployed_by, 'portal')
     WHERE stage = 'deployed'
  `).run();
} catch (_) {}

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

// ─────────────────────────────────────────────────────────────────────────────
// Customer portal — schema (Phase 5)
//
// A customer-facing portal lives at /c/<slug>. Each email_client gets a slug,
// optional link to a LinkedIn-side `clients` row, and a set of users who can
// sign in to review LinkedIn posts, read replies, and see campaign stats.
//
// All migrations below are ADDITIVE only — never DROP. Safe to re-run on every
// boot. Backfill of slugs for existing email_clients runs once.
// ─────────────────────────────────────────────────────────────────────────────

// ── 14a. email_clients.slug — URL-safe customer identifier ───────────────────
// Used in /c/<slug> portal URL. Generated from the client's name on insert
// (see routes/email.js POST /clients), unique. We migrate existing rows here
// once so portals work for clients that were created before this column existed.
{
  const cols = db.prepare('PRAGMA table_info(email_clients)').all().map(r => r.name);
  if (!cols.includes('slug')) {
    db.exec(`ALTER TABLE email_clients ADD COLUMN slug TEXT`);
    console.log('[db] migration: added slug to email_clients');
  }

  // Backfill slugs for any rows that don't have one yet. Slug rules:
  //   - lowercase, ASCII-only
  //   - whitespace and any non-[a-z0-9] runs collapsed to a single dash
  //   - leading/trailing dashes trimmed
  //   - on collision, append -2, -3, ...  (per Wez's locked-in pre-decision)
  const baseSlug = (name) => {
    return String(name || '')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^\x00-\x7f]/g, '')                       // drop remaining non-ASCII
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')                        // collapse runs to single dash
      .replace(/^-+|-+$/g, '');                           // trim ends
  };
  const uniqueSlug = (name, excludeId) => {
    let candidate = baseSlug(name) || 'client';  // fallback if name was all non-ASCII
    let n = 1;
    const stmt = db.prepare(
      `SELECT id FROM email_clients WHERE slug = ? AND id != ? LIMIT 1`
    );
    while (stmt.get(candidate, excludeId || '')) {
      n += 1;
      candidate = `${baseSlug(name) || 'client'}-${n}`;
    }
    return candidate;
  };
  // Export uniqueSlug so routes/email.js can use the same algorithm on insert.
  // (Attaching to the db object — slightly hacky but avoids a separate module.)
  db._portalUniqueSlug = uniqueSlug;

  const needSlug = db.prepare(
    `SELECT id, name FROM email_clients WHERE slug IS NULL OR slug = ''`
  ).all();
  if (needSlug.length > 0) {
    const update = db.prepare(`UPDATE email_clients SET slug = ? WHERE id = ?`);
    const tx = db.transaction(rows => {
      for (const r of rows) update.run(uniqueSlug(r.name, r.id), r.id);
    });
    tx(needSlug);
    console.log(`[db] migration: backfilled slug for ${needSlug.length} existing email_client(s)`);
  }

  // Unique index — partial so historic rows that somehow ended up with NULL
  // slug don't block this. After backfill above there shouldn't be any, but
  // belt and braces.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_clients_slug
      ON email_clients(slug) WHERE slug IS NOT NULL
  `);
}

// ── 14b. email_clients.linkedin_client_id — link to LinkedIn-side `clients` ──
// Nullable. When set, the customer portal's LinkedIn Posts tab pulls posts
// from that LinkedIn client's most recent campaign in stage='awaiting_approval'.
// When NULL, the portal's LinkedIn Posts tab shows "Not required — this
// service isn't part of your current plan."
//
// UNIQUE so the same LinkedIn account can't be linked to two email-side
// customers by mistake (which would cause customer A to see customer B's posts).
// Partial index — NULL allowed for the common email-only case.
{
  const cols = db.prepare('PRAGMA table_info(email_clients)').all().map(r => r.name);
  if (!cols.includes('linkedin_client_id')) {
    db.exec(`ALTER TABLE email_clients ADD COLUMN linkedin_client_id TEXT`);
    console.log('[db] migration: added linkedin_client_id to email_clients');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_clients_linkedin_client_id
      ON email_clients(linkedin_client_id) WHERE linkedin_client_id IS NOT NULL
  `);
}

// ── 14b-2. email_clients.service_email_enabled — explicit cold-email toggle ──
// Per-customer subscription flag for cold email. The portal's Inbox and
// Campaigns tabs check this: enabled → show real data; disabled → show
// "Not required" message.
//
// Set explicitly by admin via a dropdown in the customer-edit modal. Never
// inferred from data (e.g. "do they have campaigns?"). The portal trusts
// this flag rather than guessing from row counts.
//
// Default 1 (subscribed) — every existing customer uses cold email today,
// so existing rows are correctly defaulted. New customers Wez creates from
// scratch default to subscribed too. Admin toggles to 0 for LinkedIn-only
// customers later.
//
// Future services (Facebook Posts, Instagram, etc.) follow the same pattern:
// either a `<service>_id` column for "linked to specific account" services,
// or a `service_<name>_enabled` flag for "yes/no subscription" services.
// No generic services table — each service has its own column for what it
// actually needs to store.
{
  const cols = db.prepare('PRAGMA table_info(email_clients)').all().map(r => r.name);
  if (!cols.includes('service_email_enabled')) {
    db.exec(`ALTER TABLE email_clients ADD COLUMN service_email_enabled INTEGER NOT NULL DEFAULT 1`);
    console.log('[db] migration: added service_email_enabled to email_clients');
  }
}

// ── 14c. client_users — portal users scoped per email_client ─────────────────
// Two different email_clients can both have a user called "admin" — usernames
// are scoped per (email_client_id, username). Roles are 'admin' (can manage
// other portal users) or 'viewer'.
//
// password_hash is bcrypt with cost factor 12+ (set in routes/portal-auth.js).
// last_login_at is updated by the login route on every successful sign-in;
// used by the "Your password is temporary" banner — if NULL, show banner.
db.exec(`
  CREATE TABLE IF NOT EXISTS client_users (
    id TEXT PRIMARY KEY,
    email_client_id TEXT NOT NULL,
    username TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT,
    FOREIGN KEY (email_client_id) REFERENCES email_clients(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_client_users_client_username
    ON client_users(email_client_id, username);
  CREATE INDEX IF NOT EXISTS idx_client_users_email
    ON client_users(email_client_id, email);
`);

// ── 14d. client_sessions — SQLite-backed session storage ─────────────────────
// id IS the session token (random 32-byte base64url string set by login route).
// Survives Render restarts unlike an in-memory Map.
//
// Idle timeout 7 days, absolute timeout 30 days — both enforced at session-check
// time in the route layer:
//   - On every request, push expires_at forward to (now + 7 days), but never
//     past created_at + 30 days. When now > expires_at OR now > created_at+30d,
//     the session is dead.
//
// Cleanup of expired sessions happens lazily in the route layer (delete on
// check-failure) — no cron needed.
db.exec(`
  CREATE TABLE IF NOT EXISTS client_sessions (
    id TEXT PRIMARY KEY,
    client_user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_user_id) REFERENCES client_users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_client_sessions_user
    ON client_sessions(client_user_id);
  CREATE INDEX IF NOT EXISTS idx_client_sessions_expires
    ON client_sessions(expires_at);
`);

// ── 14e. password_resets — single-use reset tokens, 1h TTL ───────────────────
// id IS the reset token (random 32-byte base64url string). Email sent via SES
// includes /c/<slug>/reset?token=<id>. Mark used_at when redeemed so the same
// token can't be replayed.
//
// On successful reset: kill ALL sessions for the user (including any new one
// the reset flow itself creates) — per Wez's pre-decision, the user has to
// sign in fresh after reset.
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    client_user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_user_id) REFERENCES client_users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_password_resets_user
    ON password_resets(client_user_id);
`);

// ── 14f. client_login_attempts — brute-force lockout window ──────────────────
// Per Wez's locked-in default: 10 failed attempts within a 15-min window locks
// the username for 15 minutes. We track per (email_client_id, username) so
// customer A's attacker can't lock customer B's identical "admin" username.
//
// Each failed login appends a row with attempted_at=now. Lockout check on
// login: COUNT(*) WHERE attempted_at > now-15min — if >= 10, reject with
// generic "Too many attempts, try again in 15 minutes."
//
// On successful login we delete this user's rows so the counter resets.
// Old rows (> 15 min) are also pruned opportunistically on every login attempt.
db.exec(`
  CREATE TABLE IF NOT EXISTS client_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_client_id TEXT NOT NULL,
    username TEXT NOT NULL,
    attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_client_login_attempts_lookup
    ON client_login_attempts(email_client_id, username, attempted_at);
`);

// ── 14g. client_post_regens — daily soft cap on Gemini regen calls ───────────
// Per Wez's spec: 30 regens per customer (email_client) per day. Each successful
// /api/portal/posts/:id/regenerate call appends a row. The check on a new regen:
// COUNT(*) WHERE email_client_id=? AND created_at >= datetime('now','-1 day').
// Soft cap returns a 429 with a clear "you've used 30/30 today, try again
// tomorrow" message.
//
// Old rows (> 24h) are kept for now in case we want a daily-volume report
// later — they're tiny.
db.exec(`
  CREATE TABLE IF NOT EXISTS client_post_regens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_client_id TEXT NOT NULL,
    client_user_id TEXT,
    campaign_id TEXT,
    post_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_client_post_regens_client_created
    ON client_post_regens(email_client_id, created_at);
`);

// ── 14h. email_outbound — outbound replies sent from the portal ──────────────
// When a customer replies to an inbox message via the portal's compose form,
// the SES send is recorded here. Threading headers (In-Reply-To, References)
// are derived from the reply's message_id at send time.
//
// We don't reuse email_sends because that table is keyed by (campaign, subscriber)
// and these outbound messages aren't part of a campaign — they're free-form
// replies. Separate table keeps the schema honest.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_outbound (
    id TEXT PRIMARY KEY,
    email_client_id TEXT NOT NULL,
    in_reply_to_reply_id TEXT,         /* the email_replies row this is a reply to */
    client_user_id TEXT,                /* which portal user clicked Send */
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    cc_address TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    message_id TEXT,                    /* SES MessageId, for future threading */
    in_reply_to_header TEXT,            /* the In-Reply-To header value we sent */
    references_header TEXT,             /* the References header value we sent */
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    error TEXT,                         /* populated if SES send failed */
    FOREIGN KEY (email_client_id) REFERENCES email_clients(id),
    FOREIGN KEY (in_reply_to_reply_id) REFERENCES email_replies(id),
    FOREIGN KEY (client_user_id) REFERENCES client_users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_email_outbound_client_sent
    ON email_outbound(email_client_id, sent_at DESC);
  CREATE INDEX IF NOT EXISTS idx_email_outbound_reply
    ON email_outbound(in_reply_to_reply_id);
`);

// ── 14i. Per-post approval state (lives INSIDE campaigns.posts_json) ─────────
//
// IMPORTANT: There is no separate posts table. Posts live as a JSON array
// inside the LinkedIn `campaigns` table (column posts_json). Per Wez's
// pre-decision, customer-portal approval state goes in the SAME bundle as
// every other per-post field (linkedin_post_text, image_url, app_url, etc.),
// not in a sidecar table.
//
// The fields added to each post object inside posts_json:
//   - client_approved_at        : ISO timestamp when customer approved this post
//   - client_approved_by_user_id: which client_users row clicked approve
//
// No DB migration needed for this — the columns are inside JSON. Documented
// here so future readers know where to look. The portal route layer
// (routes/portal.js, next chat chunk) reads/writes these fields by parsing
// posts_json, mutating the relevant array entry, and writing back.
//
// On "Approve all" success and full Supergrow push, the LinkedIn campaign's
// stage flips from 'awaiting_approval' to 'done' (with deployed_by='portal'
// so the admin UI shows a 'Customer approved' status pill instead of the
// usual 'Deployed' one). The portal then hides the batch (next call to
// GET /api/portal/posts returns empty list because no awaiting_approval
// campaigns remain).
//
// PARTIAL FAILURE policy: if Supergrow accepts some queue_post calls but
// errors on a later one, the stage stays at 'awaiting_approval'. Posts that
// queued successfully are marked client_approved_at; the failed and remaining
// posts stay unapproved. The portal still shows the batch so the customer/Wez
// can retry the rest. The audit log captures the partial-failure state.

// ─────────────────────────────────────────────────────────────────────────────
// ── 14j-k. GENERIC SERVICES MODEL (Phase 5.5)
//
// Replaces the per-service columns on email_clients (service_email_enabled,
// linkedin_client_id, future facebook_page_id, etc.) with two general-purpose
// tables. Adding a new service in future becomes inserting a row in `services`
// — no schema change, no per-service column, no per-service code branch.
//
// The legacy columns (service_email_enabled, linkedin_client_id) are KEPT for
// now as a backwards-compat mirror — old code paths still work until they're
// migrated to read from customer_services. A future cleanup chat can drop them
// once nothing reads them.
//
// Two tables:
//
//   services            — catalogue of service types (one row per service we offer)
//                         e.g. ('email', 'Email Inbox + Campaigns', 'live', NULL)
//                              ('linkedin', 'LinkedIn Posts', 'live', 'clients')
//                              ('facebook', 'Facebook Posts', 'coming_soon', NULL)
//                              ('seo', 'SEO', 'live', NULL) — future
//
//   customer_services   — which customers subscribe to which services
//                         (email_client_id, service_key, linked_external_id)
//                         linked_external_id is nullable; used for services that
//                         have their own customer table (LinkedIn → clients.id).
// ─────────────────────────────────────────────────────────────────────────────

// 14j. services catalogue.
db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    service_key   TEXT PRIMARY KEY,        /* 'email', 'linkedin', 'facebook', 'seo', ... */
    display_name  TEXT NOT NULL,            /* 'LinkedIn Posts' — what the customer sees */
    description   TEXT,                     /* shown in admin UI under the dropdown */
    state         TEXT NOT NULL DEFAULT 'live', /* 'live' | 'coming_soon' | 'retired' */
    link_table    TEXT,                     /* SQL table name to pick external records from, NULL for plain on/off services */
    link_label    TEXT,                     /* dropdown label when picking from link_table, e.g. 'LinkedIn account' */
    sort_order    INTEGER NOT NULL DEFAULT 100,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 14k. customer_services — one row per (customer, service) subscription.
db.exec(`
  CREATE TABLE IF NOT EXISTS customer_services (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    email_client_id    TEXT NOT NULL,
    service_key        TEXT NOT NULL,
    linked_external_id TEXT,                /* nullable — id in service.link_table when applicable */
    enabled_at         TEXT NOT NULL DEFAULT (datetime('now')),
    enabled_by         TEXT,                /* admin actor identifier (e.g. 'admin') for audit */
    FOREIGN KEY (email_client_id) REFERENCES email_clients(id),
    FOREIGN KEY (service_key)     REFERENCES services(service_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_services_unique
    ON customer_services(email_client_id, service_key);
  CREATE INDEX IF NOT EXISTS idx_customer_services_service
    ON customer_services(service_key);
`);

// One-shot fix: an earlier version of this migration created
// idx_customer_services_external_unique that blocked self-links (rows where
// email_client_id = linked_external_id). Self-links are the natural default
// for "this email customer's portal uses its own data" — they shouldn't count
// toward the uniqueness check. Drop the old index if present, then recreate
// with the self-link exemption. Idempotent: safe to re-run forever.
db.exec(`
  DROP INDEX IF EXISTS idx_customer_services_external_unique;
  /* For services with linked_external_id, prevent the same external record
     being linked to TWO DIFFERENT portal customers. Self-links (email_client_id
     = linked_external_id) are exempt — they represent "use my own data" and
     can co-exist with another customer's link to the same record. */
  CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_services_external_unique
    ON customer_services(service_key, linked_external_id)
    WHERE linked_external_id IS NOT NULL
      AND email_client_id != linked_external_id;
`);

// 14l. Seed the services catalogue with the three services we know about today.
// INSERT OR IGNORE keeps it idempotent — re-running on every boot is safe and
// future Wez can edit display_name / description in the DB if needed without
// schema changes.
//
// Note on the Email service: link_table is 'email_clients' because some
// customers' portal name (e.g. "Cube6") differs from the email system record
// they're served from (e.g. "mail.engineersolutions.co.uk"). The picker lets
// the admin point each portal customer at the right underlying email record.
{
  const seedService = db.prepare(`
    INSERT OR IGNORE INTO services
      (service_key, display_name, description, state, link_table, link_label, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const seeds = [
    ['linkedin', 'LinkedIn Posts',
      'Customers see their LinkedIn posts pending approval, drawn from the linked LinkedIn account.',
      'live', 'clients', 'LinkedIn account', 10],
    ['facebook', 'Facebook Posts',
      'Coming soon — once Facebook posting is wired up, you\'ll be able to link a Facebook page here.',
      'coming_soon', null, null, 20],
    ['email', 'Email (Inbox + Campaigns)',
      'Inbox replies and email-campaign stats. Pick the underlying email system record — usually the domain you send their cold email from (e.g. mail.engineersolutions.co.uk for the "Cube6" portal customer).',
      'live', 'email_clients', 'Email system record', 30],
  ];
  for (const s of seeds) seedService.run(...s);

  // Idempotent upgrade: if a previous deploy seeded 'email' with link_table=NULL,
  // upgrade it now to point at email_clients. Other columns are left alone so
  // any future manual edit (e.g. wording tweak) survives.
  db.prepare(`
    UPDATE services
    SET link_table = 'email_clients',
        link_label = 'Email system record'
    WHERE service_key = 'email' AND link_table IS NULL
  `).run();
}

// 14m. Backfill customer_services from the legacy columns. Idempotent — uses
// INSERT OR IGNORE on the unique (email_client_id, service_key) index, so
// re-running on every boot doesn't double-up existing subscriptions.
//
// Important: we only backfill rows where the customer is currently considered
// SUBSCRIBED. For email, that's service_email_enabled=1. For linkedin, it's
// linkedin_client_id IS NOT NULL. Customers with the legacy "not subscribed"
// state get no row in customer_services at all — that's the new representation
// of "not_required" (absence of row, not a row with an off flag).
{
  // Email subscriptions. linked_external_id = the email_client's own id —
  // preserves existing behaviour (every email-enabled customer's portal sees
  // its own email data), while letting the admin re-point the link via the
  // Manage panel later if a portal customer (e.g. "Cube6") needs to point at
  // a differently-named email system record (e.g. "mail.engineersolutions.co.uk").
  //
  // For rows that already exist in customer_services from a prior deploy
  // with linked_external_id = NULL, also fill in the self-link so the schema
  // is consistent across all email subscriptions.
  const emailRows = db.prepare(`
    SELECT id FROM email_clients
    WHERE service_email_enabled = 1
      AND id NOT IN (SELECT email_client_id FROM customer_services WHERE service_key = 'email')
  `).all();
  if (emailRows.length > 0) {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO customer_services
        (email_client_id, service_key, linked_external_id, enabled_by)
      VALUES (?, 'email', ?, 'backfill')
    `);
    const tx = db.transaction(rows => { for (const r of rows) ins.run(r.id, r.id); });
    tx(emailRows);
    console.log(`[db] migration: backfilled customer_services email rows for ${emailRows.length} customer(s)`);
  }
  // Patch any pre-existing email rows that still have NULL linked_external_id
  // (would happen if a prior deploy used the on/off design before this upgrade).
  const patched = db.prepare(`
    UPDATE customer_services
    SET linked_external_id = email_client_id
    WHERE service_key = 'email' AND linked_external_id IS NULL
  `).run();
  if (patched.changes > 0) {
    console.log(`[db] migration: self-linked email service for ${patched.changes} pre-existing row(s)`);
  }

  // LinkedIn subscriptions — preserve the linked_external_id link.
  const linkedinRows = db.prepare(`
    SELECT id, linkedin_client_id FROM email_clients
    WHERE linkedin_client_id IS NOT NULL
      AND id NOT IN (SELECT email_client_id FROM customer_services WHERE service_key = 'linkedin')
  `).all();
  if (linkedinRows.length > 0) {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO customer_services
        (email_client_id, service_key, linked_external_id, enabled_by)
      VALUES (?, 'linkedin', ?, 'backfill')
    `);
    const tx = db.transaction(rows => { for (const r of rows) ins.run(r.id, r.linkedin_client_id); });
    tx(linkedinRows);
    console.log(`[db] migration: backfilled customer_services linkedin rows for ${linkedinRows.length} customer(s)`);
  }
}

// 14n. portal_enabled flag on email_clients — only customers explicitly
// enabled-for-portal show up on the Customer Portal admin page. This separates
// "I send cold email from this domain" from "this customer has a portal".
//
// Default 0 (not portal-enabled) so existing cold-email-only customers don't
// suddenly appear on the Customer Portal list. The admin must opt each one in
// via the new Manage panel toggle, OR create a brand-new portal customer via
// the new "+ New portal customer" button.
{
  const cols = db.prepare('PRAGMA table_info(email_clients)').all().map(r => r.name);
  if (!cols.includes('portal_enabled')) {
    db.exec(`ALTER TABLE email_clients ADD COLUMN portal_enabled INTEGER NOT NULL DEFAULT 0`);
    console.log('[db] migration: added portal_enabled to email_clients');
  }
  // Backfill: any email_client that already has at least one portal user
  // is implicitly portal-enabled. This covers the test users you've created
  // already so they don't disappear from the admin UI on next deploy.
  const auto = db.prepare(`
    UPDATE email_clients SET portal_enabled = 1
    WHERE portal_enabled = 0
      AND id IN (SELECT DISTINCT email_client_id FROM client_users)
  `).run();
  if (auto.changes > 0) {
    console.log(`[db] migration: portal_enabled=1 set for ${auto.changes} customer(s) with existing portal users`);
  }
}

// 14o. logo_url on email_clients — portal customers can have their own logo
// uploaded directly from the admin Manage panel. Synchronised with the
// LinkedIn-side `clients.logo_url` when a customer is linked to a LinkedIn
// account: uploading on either side propagates to the other so customer
// branding stays consistent across views.
{
  const cols = db.prepare('PRAGMA table_info(email_clients)').all().map(r => r.name);
  if (!cols.includes('logo_url')) {
    db.exec(`ALTER TABLE email_clients ADD COLUMN logo_url TEXT`);
    console.log('[db] migration: added logo_url to email_clients');
  }
  // Initial sync: copy LinkedIn logos to portal customers that are linked
  // to a LinkedIn account but don't yet have their own logo. One-shot — only
  // fills in NULLs, never overwrites a portal-uploaded logo. Uses the
  // customer_services link if available, else the legacy linkedin_client_id.
  const linkedRows = db.prepare(`
    SELECT
      ec.id AS portal_id,
      COALESCE(
        (SELECT linked_external_id FROM customer_services
          WHERE email_client_id = ec.id AND service_key = 'linkedin'),
        ec.linkedin_client_id
      ) AS linked_id
    FROM email_clients ec
    WHERE ec.logo_url IS NULL
  `).all();
  if (linkedRows.length > 0) {
    const get = db.prepare(`SELECT logo_url FROM clients WHERE id = ?`);
    const upd = db.prepare(`UPDATE email_clients SET logo_url = ? WHERE id = ?`);
    let copied = 0;
    db.transaction(rows => {
      for (const r of rows) {
        if (!r.linked_id) continue;
        const lc = get.get(r.linked_id);
        if (lc?.logo_url) { upd.run(lc.logo_url, r.portal_id); copied++; }
      }
    })(linkedRows);
    if (copied > 0) {
      console.log(`[db] migration: copied LinkedIn logo to ${copied} portal customer(s) on initial sync`);
    }
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
