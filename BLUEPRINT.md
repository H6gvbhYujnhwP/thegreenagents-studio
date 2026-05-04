# thegreenagents-studio — Cold Outreach Email System Blueprint

This document captures the complete architecture and current state of `studio.thegreenagents.com`'s email-campaign system as of the end of a long Claude conversation. The next chat should read this start-to-finish before making any code changes.

---

## What this app is

A cold-outreach email platform built on top of AWS SES, replacing Sendy. Sends campaigns from multiple verified domains (sweetbyte.co.uk, thegreenagents.com, etc.) to subscriber lists, tracks bounces/complaints via SNS, and (Phase 3) provides per-domain inbox monitoring with reply triage.

**Stack:** Node.js + Express backend, React frontend, better-sqlite3 database, deployed on Render at `studio.thegreenagents.com`. Code lives in a GitHub repo the user pushes to via GitHub Desktop on Windows.

**User context:**
- The user (Westley/Wez) is non-technical for code but very technical for ops (AWS, DNS, Google Workspace).
- Sends emails as cold outreach for B2B services across his portfolio of company brands.
- Was previously using Sendy on the same AWS account; familiar with that workflow.
- Prefers plain-text instructions, no tree diagrams, no markdown when answering simple questions.
- Pushes code by Claude generating files → Wez downloads → drops into GitHub Desktop repo on Windows desktop → Render auto-deploys.

---

## Architectural decisions you should not relitigate

1. **No SDK for SES sending** — we use raw HTTPS Signature V4 like Sendy does. The AWS SDK injects account-default config sets which we don't want. There's a Node-specific bug in the original signing chain (`digest('binary')` corrupts keys via UTF-16 round-trip) that's now fixed by keeping Buffers throughout.

2. **`X-SES-CONFIGURATION-SET: studio-no-tracking` header on every outbound** — env var `SES_CONFIGURATION_SET=studio-no-tracking` set in Render. This protects against future AWS account-level config-set defaults forcing tracking pixels.

3. **VDM Engagement Tracking is OFF** — manually disabled in AWS SES → Virtual Deliverability Manager → Settings. This was the actual cause of awstrack.me pixels. We discovered this after building two layers of "no-tracking" defences. Don't re-enable it.

4. **MIME body uses base64 encoding, not quoted-printable** — quoted-printable corrupts URLs containing `=` because `=XX` is interpreted as escaped bytes. Stick with base64.

5. **Cold outreach defaults: tracking off, no visible unsubscribe footer.** The List-Unsubscribe MIME header alone is sufficient for compliance + Gmail/Outlook native unsub button. See "Tracking Architecture" section.

6. **Auto-unsubscribe is aggressive and one-way for negatives.** No "snooze 90 days" fallback. User explicitly chose option (a): unsub all negatives, period.

7. **Inbox model is FULL inbox view, not campaign-replies-only** — see Phase 3.1.5 below. Initial implementation was forward-only campaign replies; that's been changed to show everything in the mailbox.

---

## Current state — what's deployed and working

### Phase 1: Core email sending (DONE, live)
- AWS SES via raw Signature V4
- Campaigns sent in batches with throttle
- Subscribers + lists (per email_client)
- CSV import
- Drip-send scheduler (per-day batches)

### Phase 2: Bounce/complaint via SNS (DONE, live, BUT subscriptions not yet added)
- Two SNS topics already exist on AWS account: `bounces` and `complaints` (subscribed to Sendy too — both apps run in parallel)
- Backend endpoints `/api/email/sns/bounces` and `/api/email/sns/complaints` ready to receive
- **TO-DO for user:** Add HTTPS subscriptions to those topics pointing at studio's endpoints. Click-by-click in conversation history. Sendy keeps its subscriptions; both apps coexist.

### Phase 2.5: Smart per-recipient tracking (DONE, live)
- Three modes per campaign: `off` / `smart` / `all`
- Smart mode evaluates each recipient's touch count vs threshold/window
- Per-list "always_warm" override
- Pre-send dialog shows recipient breakdown by 1st/2nd/3rd/4+ contact
- Cold campaigns default to `tracking_mode='off'`
- Schedule context shown in send dialog when overriding existing schedule
- Cancel button preserves stats (status='cancelled', not delete)
- Pause checks campaign status between every batch in `sendCampaign`

### Phase 3.1: Mailbox connection + IMAP polling (DONE, live)
- Per-domain Gmail/Workspace mailbox connection via app password
- AES-256-GCM encryption at rest with `MAILBOX_ENCRYPTION_KEY` env var
- 3-min polling interval, manual "Check now" button
- Stores incoming emails in `email_replies` table
- Three-strategy matching: In-Reply-To header → References header → sender email lookup
- Audit log table for every action
- Variant C UI: split layout with mailbox list left, focused inbox right

### Phase 3.1.5: Inbox model + polling fix (DONE, in this final turn)
- Changed from forward-only campaign replies to **full inbox view**
- 30-day backfill on first poll
- Subsequent polls use `uid > last_uid` filter
- Renamed "All replies" → "Inbox" in UI
- Check Now now shows result toast with fetched/scanned counts
- Better empty-state messaging

---

## What's NOT done (priorities for next chat)

### 1. Phase 3.2: Reply classification + auto-unsubscribe (NOT STARTED — the BIG missing piece)

The whole point of the Mailboxes feature is auto-triage. Currently every fetched email is `classification = NULL`. The "New prospects" and "Auto-unsubscribed" tabs are empty regardless of inbox content.

**Build this:**

a) **Classification service** — `server/services/classify-replies.js`. Three-pass classifier:
   - Pass 1 (regex): hard-negative keywords trigger immediate auto-unsubscribe. Tight scope: `\bunsubscribe\b`, `stop (sending|emailing|contacting)`, `(remove|delete) (me|my|us)`. Plus `not interested` if reply body <50 words.
   - Pass 2 (heuristic): out-of-office detection (`out of office`, `automatic reply`, `auto-reply` in subject), forwarding patterns
   - Pass 3 (Claude Haiku): everything else. Categorise as positive / soft_negative / neutral. Cost ~$0.001/reply, fine at 20 replies/day.

b) **Auto-unsubscribe action** — when classification is `hard_negative` OR `soft_negative` (user chose option (a) — both unsub):
   - Find all subscribers with this email across all lists belonging to this `email_client_id`
   - Mark them `status='unsubscribed', unsubscribed_at=now`
   - Set `email_replies.auto_unsubscribed=1`
   - Insert audit_log row with action='auto_unsubscribe'

c) **Run on a cron** — separate from the IMAP poller. Process unclassified rows every minute. Keep classification work isolated from fetch work.

d) **Show prospect badge in real-time** — already wired in the UI (`new_prospect_count` from `/mailboxes` route counts `classification='positive' AND handled_at IS NULL`). Just needs the classifier to actually set classifications.

### 2. Phase 3.3: Send + reply (USER REQUESTED, next session priority)

User asked for the ability to send and reply to emails from inside the studio inbox. Confirmed scope:
- Plain text v1 (rich text/HTML can come later)
- Use the email_client name as the from-name
- Compose new emails AND reply to existing threads

**Build this:**

a) **Add nodemailer dep** — `npm install nodemailer`
b) **New service** — `server/services/smtp-sender.js`:
   - `sendViaInbox({ inboxId, to, subject, body, inReplyTo, references })`
   - Uses `smtp.gmail.com:465` with the same app password as IMAP
   - Sets correct `In-Reply-To` and `References` headers for threading
c) **Save sent emails to Gmail Sent folder** via IMAP APPEND after sending. Otherwise the user's Gmail won't show their replies in Sent. Use ImapFlow's `append('[Gmail]/Sent Mail', message, ['\\Seen'])`.
d) **Don't reprocess our own sends as inbound** — the poller currently would store them as new emails. Track sent message-ids in a new column or table (e.g. `email_outbound_sends`) and check during poll dedupe.
e) **Compose UI** — new modal or expanded right-pane area with To/Subject/Body fields and Send button. Two entry points: "+ Compose" button in the inbox header, and "Reply" button on the email-detail modal (pre-fills To/Subject/References from the email being replied to).

### 3. Phase 3.4: SNS subscription wiring (USER ACTION ONLY, no code)

User just needs to do the AWS console clicks. Already documented in conversation history. Backend endpoints work. After this:
- Bounces → subscriber marked bounced, can't be emailed again
- Complaints → subscriber marked spam, can't be emailed again
- Studio is fully cold-outreach safe

### 4. Phase 3.5: Google Postmaster Tools + Microsoft SNDS (USER ACTION ONLY)

For domain reputation monitoring without open tracking. Direct user to set up:
- `postmaster.google.com` for Gmail reputation
- `sendersupport.olc.protection.outlook.com/snds/` for Outlook/Hotmail

These give better data than open rates for cold outreach health.

---

## Database schema (current)

Migrations run on every boot in `server/db.js`. Schema is in SQLite at `/var/data/studio.db` on Render.

### Core tables (Phase 1-2)
- `email_clients` — top-level grouping (one per domain). Has `test_email` field for default test send address.
- `email_brands` — branding (from name/email/reply-to) per email_client. UNUSED in current code paths but schema exists.
- `email_lists` — subscriber lists, scoped to email_client. Has `always_warm` boolean.
- `email_subscribers` — `(list_id, email)` unique. Status: subscribed/unsubscribed/bounced/spam.
- `email_campaigns` — drafts and sent campaigns. Includes tracking columns: `tracking_mode`, `tracking_threshold`, `tracking_window`, `track_opens`, `track_clicks`, `track_unsub`. Drip columns: `daily_limit`, `drip_start_at`, `drip_sent`, `send_order`, `queue_position`. Status: draft/scheduled/sending/paused/sent/cancelled/failed.
- `email_sends` — one row per send attempt. `message_id` from SES used to map SNS bounces back. `status`, `opened_at`, `clicked_at`, `bounced_at`, `open_count`, `click_count`.
- `email_link_clicks` — per-click rows for click tracking.
- `email_campaign_links` — hash → URL lookup for short tracking URLs.
- `email_sns_events` — raw SNS notifications log for debugging.

### Phase 3 tables
- `email_inboxes` — Gmail mailboxes connected for monitoring. `app_password_encrypted` is AES-256-GCM ciphertext. `last_uid` tracks IMAP poll progress.
- `email_replies` — every email fetched from inbox. `matched_subscriber_id`, `matched_campaign_id` may be null. `classification` is NULL until Phase 3.2 ships.
- `email_audit_log` — append-only log of consequential actions.

---

## Important env vars (Render)

| Var | Purpose | Value |
|---|---|---|
| `STUDIO_PASSWORD` | Bearer auth | (set) |
| `AWS_ACCESS_KEY_ID` | SES + SNS | (set, AKIA...XB) |
| `AWS_SECRET_ACCESS_KEY` | SES + SNS | (set) |
| `AWS_SES_REGION` | `eu-north-1` | (set) |
| `SES_CONFIGURATION_SET` | `studio-no-tracking` | (set) |
| `MAILBOX_ENCRYPTION_KEY` | 32-byte base64 for IMAP password encryption | (set, **never rotate without migration**) |
| `PUBLIC_URL` | base URL for tracking links | NOT SET (defaults to req.host) |
| `DB_PATH` | SQLite path | `/var/data/studio.db` |
| `ANTHROPIC_API_KEY` | for Phase 3.2 classifier | (already set) |

---

## File map

```
server/
  index.js                        — boots app, starts IMAP poller
  db.js                           — schema + migrations (run on every boot)
  middleware/auth.js              — Bearer token check
  routes/
    auth.js                       — login
    clients.js                    — Supergrow clients (NOT the email_clients table)
    campaigns.js                  — Supergrow campaigns (NOT email_campaigns)
    email.js                      — ALL email routes (campaigns, lists, mailboxes, replies, audit)
  services/
    ses.js                        — raw SES sender, sendCampaign with tracking decisions
    tracking.js                   — open/click/unsub injection (per-recipient)
    touch-count.js                — touch-count helpers for smart tracking
    crypto-vault.js               — AES-256-GCM for app passwords
    imap-poller.js                — polls all mailboxes every 3 min
    claude.js, openai.js, etc     — for Supergrow side, unrelated
src/
  App.jsx                         — auth + dashboard mount
  components/
    Sidebar.jsx                   — left nav, Mailboxes badge polls every 30s
    Dashboard.jsx                 — view router (Customers / Domain Health / Mailboxes / Supergrow)
    EmailSection.jsx              — THE BIG ONE. Everything email-related lives here.
                                    1900+ lines. Components within: ClientPanel, CampaignQueue,
                                    CampaignModal, TrackingControls, SendCampaignDialog,
                                    SubscriberView, CampaignReport, MailboxesSection,
                                    MailboxDetail, ReplyDetailModal, ConnectMailboxModal, etc.
```

---

## Things that have caused pain (lessons)

1. **JSX file editing** — EmailSection.jsx is huge. When making changes, ALWAYS run esbuild parse check before claiming success: `esbuild /tmp/test.jsx > /dev/null`. Tool chain available at `/home/claude/.npm-global/lib/node_modules/tsx/node_modules/.bin/esbuild`.

2. **Rendering without parse-check** — multiple times in this conversation I broke JSX with str_replace edits. Always parse before declaring done.

3. **MIME encoding bugs are subtle** — declaring quoted-printable but not actually QP-encoding the body looks fine for plain ASCII but corrupts URLs. Test with a URL containing `=` characters.

4. **The user pushes via GitHub Desktop on Windows** — can't run npm install themselves easily. If you add a dep to package.json, Render will auto-`npm install` on next deploy. Don't ask user to run commands.

5. **User communicates by screenshots** — Render logs, AWS console screenshots, error messages. Read carefully and engage with what's actually shown rather than guessing.

6. **The user values honest pushback over agreement.** When the user proposed something I disagreed with (e.g. removing the unsubscribe footer entirely was risky for compliance), pushing back with reasoning was welcome. Don't sugar-coat.

7. **Big design changes deserve mockups before code.** When user asks for new UI, build interactive HTML mockups first (visualize:show_widget tool). Confirm direction before writing React.

---

## What to do first in next chat

1. Read this whole blueprint
2. Ask the user what they want to tackle first: send/reply (Phase 3.3) or classification/auto-unsub (Phase 3.2)
3. If user is unclear, recommend Phase 3.3 (send/reply) since they explicitly asked for it
4. Before any code, ask the user to:
   - Confirm Phase 3.1.5 (Inbox view + polling fix) is deployed and working
   - Test Check Now and confirm it's now showing fetched/scanned counts
5. Then start Phase 3.3 with a design mockup if the implementation will be complex

---

## Final word

The user is patient, curious, and has been a great collaborator. They've put genuine effort into testing each phase. They want this to be a real product they could one day sell to other companies. Treat the project that way — quality matters more than speed. When in doubt, ask.

— Claude (end of long conversation handoff)
