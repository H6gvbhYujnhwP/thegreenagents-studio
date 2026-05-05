# thegreenagents-studio — Cold Outreach Email System Blueprint

This document captures the complete architecture and current state of `studio.thegreenagents.com`'s email-campaign system as of the end of a long Claude conversation that built Phases 3.1.5 → 3.4. The next chat should read this start-to-finish before making any code changes.

---

## What this app is

A cold-outreach email platform built on top of AWS SES, replacing Sendy. Sends campaigns from multiple verified domains (sweetbyte.co.uk, thegreenagents.com, clearerpaths.co.uk, etc.) to subscriber lists, tracks bounces/complaints via SNS, and provides per-domain inbox monitoring with reply triage, AI classification, auto-unsubscribe, scheduled drip sends, and per-recipient personalisation.

**Stack:** Node.js + Express backend, React frontend, better-sqlite3 database, deployed on Render at `studio.thegreenagents.com`. Code lives in a GitHub repo the user pushes to via GitHub Desktop on Windows.

**User context:**
- The user (Westley/Wez) is non-technical for code but very technical for ops (AWS, DNS, Google Workspace).
- Sends emails as cold outreach for B2B services across his portfolio of company brands.
- Was previously using Sendy on the same AWS account; familiar with that workflow.
- Prefers plain-text instructions, no tree diagrams, no markdown when answering simple questions.
- Pushes code by Claude generating files → Wez downloads → drops into GitHub Desktop repo on Windows desktop → Render auto-deploys.
- Communicates by screenshots — Render logs, AWS console screenshots, error messages. Read carefully and engage with what's actually shown rather than guessing.
- Values honest pushback over agreement. Don't sugar-coat. When the user proposes something risky (e.g. removing the unsubscribe footer entirely), pushing back with reasoning is welcome.

---

## Architectural decisions you should not relitigate

1. **No SDK for SES sending** — we use raw HTTPS Signature V4 like Sendy does. The AWS SDK injects account-default config sets which we don't want. There's a Node-specific bug in the original signing chain (`digest('binary')` corrupts keys via UTF-16 round-trip) that's now fixed by keeping Buffers throughout.

2. **`X-SES-CONFIGURATION-SET: studio-no-tracking` header on every outbound** — env var `SES_CONFIGURATION_SET=studio-no-tracking` set in Render. This protects against future AWS account-level config-set defaults forcing tracking pixels.

3. **VDM Engagement Tracking is OFF** — manually disabled in AWS SES → Virtual Deliverability Manager → Settings. This was the actual cause of awstrack.me pixels. We discovered this after building two layers of "no-tracking" defences. Don't re-enable it.

4. **MIME body uses base64 encoding, not quoted-printable** — quoted-printable corrupts URLs containing `=` because `=XX` is interpreted as escaped bytes. Stick with base64.

5. **Cold outreach defaults: tracking off, no visible unsubscribe footer.** The List-Unsubscribe MIME header alone is sufficient for compliance + Gmail/Outlook native unsub button.

6. **Auto-unsubscribe is aggressive and one-way for negatives.** No "snooze 90 days" fallback. User explicitly chose: unsub all negatives (both `hard_negative` AND `soft_negative`), period.

7. **Inbox model is FULL inbox view, not campaign-replies-only** — Phase 3.1.5 changed this. We fetch every email in the mailbox INBOX folder. Classification (Phase 3.2) surfaces which ones are prospects.

8. **Drip ticker uses `Intl.DateTimeFormat` for timezone math, not a zone library** — works in Node 18+ with no external deps. DST handles itself. Tested across BST/GMT/EDT and the spring-forward boundary.

9. **First-name parsing is rule-first with AI fallback, not always-AI** — keeps cost ~$0.01 per 500-name list instead of $0.15. Rule covers ~95% of clean names; AI handles the messy 5% (all-caps, joint names, role accounts).

10. **Reply classifier uses three passes, fastest-first** — regex catches the obvious opt-outs for free, heuristic catches out-of-office, only the genuinely-ambiguous replies hit Haiku. Cost ~$0.001 per AI-classified reply.

---

## Current state — what's deployed and working

### Phase 1: Core email sending (DONE, live)
- AWS SES via raw Signature V4
- Campaigns sent in batches with throttle (10/batch, 800ms gap)
- Subscribers + lists (per email_client)
- CSV import
- One-shot send via `Send now`

### Phase 2: Bounce/complaint via SNS (DONE in code, **subscriptions still not added on AWS**)
- Two SNS topics already exist on AWS account: `bounces` and `complaints` (subscribed to Sendy too — both apps run in parallel)
- Backend endpoints `/api/email/sns/bounces` and `/api/email/sns/complaints` ready to receive
- **TO-DO for user:** Add HTTPS subscriptions to those topics pointing at studio's endpoints. Sendy keeps its subscriptions; both apps coexist.

### Phase 2.5: Smart per-recipient tracking (DONE, live)
- Three modes per campaign: `off` / `smart` / `all`
- Smart mode evaluates each recipient's touch count vs threshold/window
- Per-list "always_warm" override
- Pre-send dialog shows recipient breakdown by 1st/2nd/3rd/4+ contact
- Cold campaigns default to `tracking_mode='off'`
- Schedule context shown in send dialog when overriding existing schedule
- Cancel button preserves stats (status='cancelled', not delete)
- Pause checks campaign status between every batch in `sendCampaign`

### Phase 3.1 + 3.1.5: Mailbox connection + IMAP polling + full-inbox view (DONE, live)
- Per-domain Gmail/Workspace mailbox connection via app password
- AES-256-GCM encryption at rest with `MAILBOX_ENCRYPTION_KEY` env var
- 3-min polling interval, manual "Check now" button
- 30-day backfill on first poll for any newly-connected mailbox; subsequent polls use `uid > last_uid` filter
- Manual `Resync` link in mailbox header — resets `last_uid` to 0 to force a fresh 30-day backfill (use when an inbox connected pre-3.1.5 looks empty)
- "Check now" returns `{ok, fetched, scanned, error}` and shows a toast: *"Fetched 23 new emails"* / *"Up to date — scanned 142 emails, nothing new"*
- Stores incoming emails in `email_replies` table with three-strategy matching: In-Reply-To header → References header → sender email lookup
- Audit log table for every action
- Variant C UI: split layout with mailbox list left, focused inbox right
- **Timestamp display fix**: SQLite's `datetime('now')` returns `"YYYY-MM-DD HH:MM:SS"` (UTC, space-separated, no timezone marker). Chrome/Edge parses that as LOCAL time, making timestamps appear off by the user's TZ offset (1h behind in BST). `relTime()` in EmailSection.jsx now detects that format and force-treats it as UTC.
- **Diagnostic logging** on every poll — connection state, INBOX message count, search results, final outcome. Look for `[poller] john@clearerpaths.co.uk:` lines in Render logs.

### Phase 3.2: Reply classification + auto-unsubscribe (DONE, live)
- New file `server/services/classify-replies.js` — three-pass classifier
- Cron runs every 60 seconds processing up to 25 unclassified replies per tick
- **Pass 1 (regex):** hard-negative phrases (`unsubscribe`, `stop emailing`, `remove me`, `cease and desist`, `not interested` when reply is short). 19 unit tests pass including tricky cases (long "not interested" → AI; "outsource" doesn't trip OOO; quoted "unsubscribe" inside a positive reply gets stripped).
- **Pass 2 (heuristic):** out-of-office detection (subject prefix, body markers like `I am currently on annual leave`), forwarding (`Fwd:`).
- **Pass 3 (Claude Haiku):** everything else gets categorised as positive | soft_negative | hard_negative | neutral. Concurrency-capped at 3 parallel calls. Configurable model via `CLASSIFIER_MODEL` env var (default `claude-haiku-4-5-20251001`).
- The classifier strips quoted/forwarded content (`On Mon, ... wrote:`, `>` markers, `From:` blocks) before running so it doesn't trip on the original campaign's words being quoted back.
- **Auto-unsubscribe** fires on `hard_negative` AND `soft_negative` (per user confirmation). Finds every subscriber matching the reply's sender email across all lists belonging to that `email_client`, marks them `unsubscribed`, updates list subscriber counts, sets `email_replies.auto_unsubscribed=1`, writes audit log rows.
- New buttons: **"Classify pending"** in mailbox detail header (kicks the cron immediately, shows breakdown toast). **"Classify with AI"** in reply detail modal (forces single-row reclassify).

### Phase 3.3: Per-recipient personalisation (DONE, live)
- New file `server/services/name-parser.js` — rule-first + Haiku fallback
- DB columns added to `email_subscribers`: `first_name`, `first_name_source` (`rule|ai|manual|skip`), `first_name_reason`
- Parses on CSV import (rule pass only, instant) and on single-add subscribers. AI fallback runs on demand via Preview's "Parse N names" button.
- 16 unit tests pass for the rule parser including: clean names, hyphenated names, all-caps, honorifics (Mr/Mrs/Dr/Prof/Sir), joint names (Mr & Mrs), role accounts (Reception Team), email-style names (jane.doe), single-letter initials.
- New `{{first_name}}` placeholder in subject and body. Legacy `[Name]` still supported. Backend `templateUsesFirstName()` detects either form.
- **Preview Campaign modal** — arrow through all subscribers, see exactly what each would receive, click Edit to manually override a parsed name. Skip count surfaced in pre-send dialog with link-through to a "Skipped subscribers" list with per-row Set-name button.
- New campaigns auto-prefill body with `Hi {{first_name}},` so the user doesn't have to think about the placeholder. The `{{first_name}}` chip in the modal copies to clipboard for pasting elsewhere.
- **Auto-rule-parse on send-preview / send / preview-recipients**: any subscriber on the campaign's list with `first_name_source IS NULL` gets the rule pass run inline before the skip count is computed. Means existing subs (e.g. John Wicks, John, Wez on Test List 1) don't show as "will be skipped" just because they were imported pre-parser.
- At send time, anyone without a parsed first_name is filtered out **only when the template uses the placeholder**. Templates without `{{first_name}}` send to everyone as before.

### Phase 3.4: Drip ticker (scheduled multi-day sends) (DONE, live)
- New file `server/services/drip-ticker.js` — runs every 60 seconds
- DB columns added to `email_campaigns`: `drip_send_days` (e.g. `"1,2,3,4,5"` Mon-Fri), `drip_window_start` (HH:MM), `drip_window_end` (HH:MM), `drip_timezone` (IANA, default `Europe/London`), `drip_today_date` (YYYY-MM-DD), `drip_today_sent` (counter, resets at midnight in the campaign's tz), `drip_last_tick_at` (diagnostic).
- For each `scheduled` campaign with `daily_limit > 0`: checks start date, active days, window. Resets the per-day counter when calendar date rolls over in the campaign's timezone. Sends today's batch paced across remaining window time with **±30% random jitter** ("Option B" — looks more human than a metronome).
- Re-checks campaign status before every single send so Pause/Cancel takes effect within seconds. Render restart mid-burst is safe — uses `email_sends` row existence to know who's already received.
- Marks campaign `sent` when last subscriber gets the email.
- 14 unit tests pass for time helpers (BST/GMT/UTC, round-trip, spring-forward DST).
- **New ScheduleControls UI** between body editor and TrackingControls in the campaign modal:
  - Toggle "Drip over multiple days" on/off — when off, behaves like a normal one-shot send.
  - Daily limit (default 50) and start date.
  - Window start / end times in `Europe/London`.
  - Day-of-week pills (Mon-Fri ticked by default for cold outreach).
  - Send order: top first / random.
  - Live estimate: *"Sending 50/day between 09:00 and 11:00 on Mon, Tue, Wed, Thu, Fri. 535 subscribers → completes in 11 send-days, finishing around 21 May 2026."*
  - Tight-pacing warning when window is too short for daily volume.
- **Campaign queue** shows drip progress for scheduled campaigns: `125 / 535 · 23 today` with a blue progress bar; `Est. finish` column estimates the date.

### Phase 3.5: Drip progress reporting + recipients view (DONE, live)
- Existing `CampaignReport` extended to work for both sent campaigns AND in-flight drips. Header adapts to "— Progress" vs "— Report". Status badge added.
- New `View progress` button in the queue for scheduled-drip and in-flight `sending`/`paused` campaigns (in addition to the existing `View report` for sent ones).
- New `CampaignRecipientsPanel` at the bottom of every report — lists every subscriber on the campaign's list with status badge: Queued | Sent | Opened | Bounced | Failed.
- Filter pills (All / Sent / Queued / Opened / Not opened / Clicked / Bounced) with live counts. Search box for name or email. First 500 inline; bigger lists prompt CSV export.
- Two new CSV exports: `recipients` (everyone sent so far) and `queued` (everyone still to come).
- New endpoint `GET /api/email/campaigns/:id/recipients` with optional `?status=` filter; returns summary counts plus per-row send/open/click/bounce status.

### Phase 4 helpers added in this chat
- **Default sender per client** (DB columns `email_clients.default_from_email`, `default_from_name`). Set once in the client edit modal; auto-fills From/Reply-To on every new campaign and list for that client.
- **Line-spacing fix** in outgoing emails. Backend `wrapBodyWithEmailCss()` in ses.js wraps every body fragment with a tiny CSS reset before SES base64 encoding. Resolves the "I added one blank line but the recipient sees three" bug caused by browser default `<p>` margins (1em top + 1em bottom = stacked vertical space). Empty `<p><br></p>` placeholders that contentEditable produces are hidden via `p:has(> br:only-child) { display: none }`.

---

## What's NOT done (priorities for next chat)

### 1. Phase 4: Multi-step follow-up sequences (USER ASKED, NOT STARTED)

The biggest remaining feature. User wants to add 2nd / 3rd / 4th / 5th+ email steps to a single campaign with configurable delays (e.g. "+3 days after step 1, +5 days after step 2"). This is a real architectural change, not a small feature.

**Design pre-decisions I proposed and the user has NOT confirmed yet — start the next chat by asking:**

- **Stop conditions:** my recommendation is any classified reply (`positive`, `soft_negative`, `hard_negative`) halts the sequence for that recipient. `auto_reply` (out of office) does NOT halt — wait for them to be back. `forwarding` doesn't halt either. Manual unsubscribe always halts. **Confirm with user.**
- **Schedule inheritance:** follow-ups use the same drip schedule (days/window/timezone) as the original campaign. So if Step 1 is Mon-Fri 09:00-11:00, the +3-day Step 2 to recipient X also fires in the next 09:00-11:00 window on a Mon-Fri after 3 days have passed since their Step 1 send. **Confirm.**
- **Per-step body:** each step has its own subject and body. Step 2 typically references the original ("Just following up on my email last week..."). **Confirm a sequence editor with stacked step blocks is the right UI.**
- **Reporting:** the existing recipient table needs a "Last step" column showing which step number each recipient is on. Sent / Queued / Replied buckets work per-step.

**Build plan:**

a) **Schema:**
- New table `email_campaign_steps` with `(id, campaign_id, step_number, subject, html_body, delay_days, delay_after_step, created_at)`. Step 1 is the existing campaign body — auto-migrated into a step row on first deploy. Steps 2+ live only in this table.
- Add `step_number INTEGER DEFAULT 1` to `email_sends` so we can tell which step each row was generated by.
- Index on `email_sends(campaign_id, subscriber_id, step_number)` for fast "what's the latest step this person got?" lookups.

b) **Frontend:**
- Build an interactive HTML mockup BEFORE writing React (per the lessons learned section). Show stacked step blocks, each with collapsible body editor, delay-days field, and a "Remove step" button. Plus a "+ Add step" button at the bottom. Maximum 10 steps to keep the UI sensible.
- Fields to add to the campaign modal: step list (replaces the single body field). Step 1 keeps the existing body slot.
- Sequence preview per recipient — the existing PreviewCampaignModal needs to also let you flip between steps for each subscriber.

c) **Backend logic:**
- `drip-ticker.js` extended: when picking subscribers for today's batch, also check who's due for a follow-up step. A "due" subscriber is one whose latest `email_sends` row was step N, the time since that row exceeds `delay_days`, AND no reply has come in that should halt the sequence.
- Reply-blocked filter: query `email_replies` for any row from this subscriber's email matching this `email_client_id` with `classification IN ('positive', 'soft_negative', 'hard_negative')`. Skip if any.
- Audit log row per step send so the user can debug why someone did/didn't get step N.

d) **Reporting:**
- Recipients panel gets a "Step" column showing the latest step each recipient is on.
- Per-step stats: how many got step 1, step 2, etc. Reply rate per step (which step gets the most replies tells you when prospects engage).

**Estimated effort:** 1-2 turns. Mockup first, then schema + backend + UI in one go after sign-off.

### 2. Phase 2 SNS subscription wiring (USER ACTION ONLY, no code)

Endpoint code is done; user just needs to do the AWS console clicks. Already documented in earlier conversation history. After this:
- Bounces → subscriber marked bounced, can't be emailed again
- Complaints → subscriber marked spam, can't be emailed again
- Studio is fully cold-outreach safe

### 3. Phase 5: Send & reply from inside the studio inbox (USER ASKED EARLIER, NOT STARTED)

Originally the previous chat's recommended next step before Phase 3.2 took priority. Still pending. Confirmed scope:
- Plain text v1 (rich text/HTML can come later)
- Use the email_client name as the from-name
- Compose new emails AND reply to existing threads

**Build:**

a) **Add nodemailer dep** — `npm install nodemailer`
b) **New service** — `server/services/smtp-sender.js`:
   - `sendViaInbox({ inboxId, to, subject, body, inReplyTo, references })`
   - Uses `smtp.gmail.com:465` with the same app password as IMAP
   - Sets correct `In-Reply-To` and `References` headers for threading
c) **Save sent emails to Gmail Sent folder** via IMAP APPEND after sending. Otherwise the user's Gmail won't show their replies in Sent. Use ImapFlow's `append('[Gmail]/Sent Mail', message, ['\\Seen'])`.
d) **Don't reprocess our own sends as inbound** — the poller currently would store them as new emails. Track sent message-ids in a new column or table (e.g. `email_outbound_sends`) and check during poll dedupe.
e) **Compose UI** — new modal or expanded right-pane area with To/Subject/Body fields and Send button. Two entry points: "+ Compose" button in the inbox header, and "Reply" button on the email-detail modal (pre-fills To/Subject/References from the email being replied to).

### 4. Phase 6: Google Postmaster Tools + Microsoft SNDS (USER ACTION ONLY)

For domain reputation monitoring without open tracking. Direct user to set up:
- `postmaster.google.com` for Gmail reputation
- `sendersupport.olc.protection.outlook.com/snds/` for Outlook/Hotmail

These give better data than open rates for cold outreach health.

### 5. Smaller backlog items

- **Drip starts immediately when scheduled:** if user creates a new drip campaign with start date "today" but the current time is already past the window end, the first batch waits until tomorrow. Sensible behaviour but could be confusing — add a "fires next at..." line to the campaign queue row.
- **Reply matching for self-tests is broken** by design — when you send a campaign to `westley@sweetbyte.co.uk` and reply from there, Gmail rewrites threading headers between Workspace accounts. The third-strategy fallback (match by sender email to a list subscriber) doesn't fire if the sender isn't on the campaign's list. Won't happen with real prospects but is confusing during testing. Consider a "test inbox" where matching is loosened.
- **Drip ticker stuck-burst recovery:** if Render restarts mid-burst, the in-memory `activeBursts` map is lost but the next minute's tick picks up where it left off via `email_sends` row existence. Tested logically but never under real failure. Worth a one-pager doc on the recovery flow.
- **Audit-log viewer**: there's an endpoint (`GET /api/email/audit-log`) but no UI. Worth a small "System log" panel under the Mailboxes section, useful for "why did this person get unsubscribed?" lookups.
- **Bug: `export default router` is in the middle of routes/email.js** (around line 1173, with more route declarations after it). It works because JS exports the binding rather than a snapshot, so subsequent `router.post()` calls mutate the same object Express imported. Confusing pattern; would be cleaner with all routes before the export. Not blocking anything.
- **Drip reset on edit:** if user edits a scheduled campaign and changes daily_limit / window / days, `drip_today_sent` should arguably reset to 0 to apply the new daily limit immediately. Currently it doesn't — the change takes effect tomorrow. Probably fine, but worth a confirmation dialog when editing a live drip.

---

## Database schema (current — Phase 4 ready)

Migrations run on every boot in `server/db.js`. Schema is in SQLite at `/var/data/studio.db` on Render. Schema rev as of end-of-chat:

### Core tables (Phase 1-2)
- `email_clients` — top-level grouping (one per domain). Has `test_email`, `default_from_email`, `default_from_name`.
- `email_brands` — branding (from name/email/reply-to) per email_client. UNUSED in current code paths but schema exists.
- `email_lists` — subscriber lists, scoped to email_client. Has `always_warm` boolean.
- `email_subscribers` — `(list_id, email)` unique. Status: subscribed/unsubscribed/bounced/spam. Has `first_name`, `first_name_source`, `first_name_reason`, `spam_at`.
- `email_campaigns` — drafts, scheduled drips, sent campaigns. Tracking columns (`tracking_mode`, `tracking_threshold`, `tracking_window`, `track_opens`, `track_clicks`, `track_unsub`). Drip columns (`daily_limit`, `drip_start_at`, `drip_sent`, `send_order`, `queue_position`, `drip_send_days`, `drip_window_start`, `drip_window_end`, `drip_timezone`, `drip_today_date`, `drip_today_sent`, `drip_last_tick_at`). Status: draft/scheduled/sending/paused/sent/cancelled/failed.
- `email_sends` — one row per send attempt. `message_id` from SES used to map SNS bounces back. `status`, `opened_at`, `clicked_at`, `bounced_at`, `open_count`, `click_count`. **Future Phase 4: needs `step_number` column.**
- `email_link_clicks` — per-click rows for click tracking.
- `email_campaign_links` — hash → URL lookup for short tracking URLs.
- `email_sns_events` — raw SNS notifications log for debugging.

### Phase 3 tables
- `email_inboxes` — Gmail mailboxes connected for monitoring. `app_password_encrypted` is AES-256-GCM ciphertext. `last_uid` tracks IMAP poll progress.
- `email_replies` — every email fetched from inbox. `matched_subscriber_id`, `matched_campaign_id` may be null. `classification`, `classification_confidence`, `classification_reason`, `auto_unsubscribed`, `handled_at`, `handled_by`.
- `email_audit_log` — append-only log of consequential actions. Action types: `connect_mailbox`, `disconnect_mailbox`, `resync_mailbox`, `classify`, `auto_unsubscribe`, `auto_unsubscribe_no_match`, `manual_unsubscribe`, `mark_handled`, `reclassify`.

### Phase 4 (planned, not yet)
- `email_campaign_steps` — `(id, campaign_id, step_number, subject, html_body, delay_days, created_at)`.

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
| `ANTHROPIC_API_KEY` | for Haiku fallback (name parser, reply classifier) | (set) |
| `NAME_PARSER_MODEL` | override Haiku model id for name parsing | unset (defaults to `claude-haiku-4-5-20251001`) |
| `CLASSIFIER_MODEL` | override Haiku model id for reply classifier | unset (defaults to `claude-haiku-4-5-20251001`) |

If you ever see `[name-parser] AI fallback failed: ...model not found...` in Render logs, set `NAME_PARSER_MODEL` to whatever the current Haiku string is (check `https://docs.claude.com`). Same for `CLASSIFIER_MODEL` if classifier errors with the same.

---

## File map (current)

```
server/
  index.js                        — boots app, starts IMAP poller, classifier, drip ticker
  db.js                           — schema + migrations (run on every boot)
  middleware/auth.js              — Bearer token check
  routes/
    auth.js                       — login
    clients.js                    — Supergrow clients (NOT the email_clients table)
    campaigns.js                  — Supergrow campaigns (NOT email_campaigns)
    email.js                      — ALL email routes (campaigns, lists, mailboxes, replies, audit, parse-names, recipients, classify-now)
                                    1700+ lines. NB: export default router appears mid-file (line ~1173) with
                                    routes after it. This works (export-binding semantics) but is confusing.
  services/
    ses.js                        — raw SES sender, sendCampaign with tracking decisions, wrapBodyWithEmailCss
    tracking.js                   — open/click/unsub injection (per-recipient)
    touch-count.js                — touch-count helpers for smart tracking
    crypto-vault.js               — AES-256-GCM for app passwords
    imap-poller.js                — polls all mailboxes every 3 min, with manual /poll and /resync triggers
    classify-replies.js           — Phase 3.2 — three-pass reply classifier + auto-unsub. Cron every 60s.
    name-parser.js                — Phase 3.3 — rule + Haiku first-name extractor with caching
    drip-ticker.js                — Phase 3.4 — scheduled drip executor, paced sends with jitter
    claude.js, openai.js, etc     — for Supergrow side, unrelated
src/
  App.jsx                         — auth + dashboard mount
  components/
    Sidebar.jsx                   — left nav, Mailboxes badge polls every 30s
    Dashboard.jsx                 — view router (Customers / Domain Health / Mailboxes / Supergrow)
    EmailSection.jsx              — THE BIG ONE. Everything email-related lives here.
                                    2600+ lines. Components within: ClientPanel, CampaignQueue,
                                    CampaignModal, ScheduleControls, TrackingControls, SendCampaignDialog,
                                    SubscriberView, CampaignReport, CampaignRecipientsPanel,
                                    PreviewCampaignModal, SkippedListModal,
                                    MailboxesSection, MailboxDetail, ReplyDetailModal,
                                    ReclassifyDropdown, ConnectMailboxModal, DripModal,
                                    ClientModal, ListModal, ImportModal, etc.
    RichTextEditor.jsx            — contentEditable wrapper. Has lineHeight 1.6 and produces
                                    <p>...</p>/<p><br></p>/<br> mix that requires the wrapBodyWithEmailCss
                                    fix in ses.js to look right at the recipient end.
```

---

## Things that have caused pain (lessons)

1. **JSX file editing** — EmailSection.jsx is huge (now 2600+ lines). When making changes, ALWAYS run esbuild parse check before claiming success. Path: `/home/claude/.npm-global/lib/node_modules/tsx/node_modules/.bin/esbuild --loader:.jsx=jsx --log-level=warning <file> > /dev/null && echo OK`. **At one point I deleted a `function TrackingControls(...){` line by accident in a str_replace — caught it by the parse check, restored it. Always parse-check.**

2. **str_replace + similar code blocks**: when several functions in the file have the same shape (e.g. several modals all start `const [saving,setSaving]=useState(false)`), str_replace will refuse with "found multiple times". Add 2-3 lines of unique surrounding context to disambiguate.

3. **Rendering without parse-check** — multiple times in the previous chat I broke JSX with str_replace edits. Always parse before declaring done.

4. **MIME encoding bugs are subtle** — declaring quoted-printable but not actually QP-encoding the body looks fine for plain ASCII but corrupts URLs. Test with a URL containing `=` characters. Stick with base64.

5. **The user pushes via GitHub Desktop on Windows** — can't run npm install themselves easily. If you add a dep to package.json, Render will auto-`npm install` on next deploy. Don't ask user to run commands.

6. **The user values honest pushback over agreement.** When the user proposed something I disagreed with (e.g. removing the unsubscribe footer entirely was risky for compliance, or "AI for every name" when rule+AI is 10x cheaper), pushing back with reasoning was welcome. Don't sugar-coat.

7. **Big design changes deserve mockups before code.** When user asks for new UI, build interactive HTML mockups first (`visualize:show_widget` tool). Confirm direction before writing React. The Preview modal and the Schedule block were both validated this way.

8. **Browser editor visual ≠ recipient visual.** RichTextEditor uses lineHeight 1.6 and `<p>` blocks. Recipients see Outlook's default `<p>` margins on top of that. `wrapBodyWithEmailCss` in ses.js compensates server-side.

9. **SQLite timestamps need timezone treatment.** `datetime('now')` returns a UTC string with a space and no Z. Browsers parse that as local time. Fix: detect the format and append `Z` before constructing a Date. Real-world bug — timestamps were "1h ago" within a minute of clicking Check Now, in BST.

10. **Tool reminders / the "yellow toast"** in claude.ai sometimes fires after long tool calls. Conversation usually still completes correctly. Tell the user to refresh if they see it; not worth debugging unless it blocks something.

11. **Phantom `last_uid`**: when a mailbox connected pre-3.1.5 had its `last_uid` set to the latest UID at connection time under the old "forward-only" logic. Phase 3.1.5 added 30-day backfill but skipped it on these grandfathered mailboxes. Resync button (`POST /api/email/mailboxes/:id/resync`) sets `last_uid=0` to force a fresh backfill. **Document this for users running into "my inbox is empty after upgrading".**

---

## What to do first in next chat

1. Read this whole blueprint.
2. Confirm with the user that all the Phase 3.2/3.3/3.4/3.5 work from this chat is deployed and behaving correctly:
   - Inbox shows AI-classified replies (not "Unclassified" everywhere). New prospect badge lights up.
   - Sending a "please remove me" reply auto-unsubs the sender.
   - Creating a new campaign auto-prefills `Hi {{first_name}},` and shows the Schedule block.
   - Scheduling a drip and waiting through a window actually fires emails (logs: `[drip] {id}: bursting N email(s)`).
   - "View progress" button on a scheduled drip opens the report and shows queued/sent breakdown.
   - Default sender on a client auto-fills new campaigns and lists.
   - Replies don't have triple-spaced paragraphs.
3. If user is happy, recommend Phase 4 (multi-step sequences). Build a mockup first using `visualize:show_widget` before any code. Get the four design pre-decisions confirmed (stop conditions, schedule inheritance, per-step body editor, reporting per-step).
4. If user has bugs to surface from the recent deploys, fix those first.

---

## Final word

The user is patient, curious, and a great collaborator. They put genuine effort into testing each phase and report back with screenshots + Render logs. They want this to be a real product they could one day sell to other companies. Treat the project that way — quality matters more than speed. When in doubt, ask.

— Claude (end of long-conversation handoff, post-Phase-3.5 + helpers)
