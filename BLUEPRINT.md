# thegreenagents-studio — Blueprint

This document captures the complete architecture and current state of `studio.thegreenagents.com`. The next chat should read this start-to-finish before making any code changes.

---

## What this app is

A two-product platform for The Green Agents:

1. **Cold-outreach email** — multi-domain SES sending with per-domain inbox monitoring, reply triage, AI classification, auto-unsubscribe, scheduled drips, per-recipient personalisation.
2. **LinkedIn post generation** — Supergrow-integrated post generation with image creation. Posts go through a customer-approval flow, then push to Supergrow as live `queue_post`.

Both products share a database (better-sqlite3), an admin UI, and a per-customer portal at `/c/<slug>`.

**Stack:** Node.js + Express backend, React frontend, better-sqlite3 database, deployed on Render at `studio.thegreenagents.com`. Code lives in a GitHub repo the user pushes to via GitHub Desktop on Windows.

**User context:**
- The user (Westley/Wez) is non-technical for code but very technical for ops (AWS, DNS, Google Workspace).
- Sends emails as cold outreach for B2B services across his portfolio of company brands.
- Was previously using Sendy on the same AWS account; familiar with that workflow.
- Prefers plain-text instructions, no tree diagrams, no markdown when answering simple questions.
- Pushes code by Claude generating files → Wez downloads → drops into GitHub Desktop repo on Windows desktop → Render auto-deploys.
- Communicates by screenshots — Render logs, AWS console screenshots, error messages. Read carefully and engage with what's actually shown rather than guessing.
- **Values honest pushback over agreement.** When Wez proposes something risky or a pre-decision turns out wrong once code is in motion, surface it early. Don't sugar-coat. Don't silently work around bad assumptions.

---

## Architectural decisions you should not relitigate

1. **No SDK for SES sending** — we use raw HTTPS Signature V4 like Sendy does. The AWS SDK injects account-default config sets which we don't want. There's a Node-specific bug in the original signing chain (`digest('binary')` corrupts keys via UTF-16 round-trip) that's now fixed by keeping Buffers throughout.

2. **`X-SES-CONFIGURATION-SET: studio-no-tracking` header on every outbound** — env var `SES_CONFIGURATION_SET=studio-no-tracking` set in Render. Protects against future AWS account-level config-set defaults forcing tracking pixels.

3. **VDM Engagement Tracking is OFF** — manually disabled in AWS SES → Virtual Deliverability Manager → Settings. Don't re-enable it.

4. **MIME body uses base64 encoding, not quoted-printable** — quoted-printable corrupts URLs containing `=`. Stick with base64.

5. **Cold outreach defaults: tracking off, no visible unsubscribe footer.** The List-Unsubscribe MIME header alone is sufficient for compliance + Gmail/Outlook native unsub button.

6. **Auto-unsubscribe is aggressive and one-way for negatives.** No "snooze" fallback. Wez explicitly chose: unsub all negatives (both `hard_negative` AND `soft_negative`), period.

7. **Inbox model is FULL inbox view, not campaign-replies-only.** Phase 3.1.5 changed this. Classification (Phase 3.2) surfaces which ones are prospects.

8. **Drip ticker uses `Intl.DateTimeFormat` for timezone math, not a zone library** — works in Node 18+ with no external deps. DST handles itself.

9. **First-name parsing is rule-first with AI fallback, not always-AI** — keeps cost ~$0.01 per 500-name list instead of $0.15.

10. **Reply classifier uses three passes, fastest-first** — regex → heuristic → Haiku. Cost ~$0.001 per AI-classified reply.

### Customer-portal architecture (locked in this chat)

11. **Two parallel "client" tables exist by design** — `clients` (LinkedIn-side, Supergrow workspaces) and `email_clients` (email-side, send domains). They were built independently and DO NOT share IDs. The customer portal links them via `customer_services.linked_external_id`. **Don't try to merge them** — too much code reads from each, and the portal layer handles the join cleanly.

12. **Generic services model, not per-service columns.** Adding a new service (Facebook, SEO, Google Ads, anything) is `INSERT INTO services` — no schema change, no React changes, no service-specific code. Two tables drive the whole thing: `services` (catalogue) and `customer_services` (subscriptions). See "Customer portal — generic services design" below for full detail.

13. **`portal_enabled` flag separates "I have a portal" from "I'm a cold-email customer".** A customer like `mail.engineersolutions.co.uk` can be a cold-email customer (in `email_clients`) without having a portal. A customer like `Cube6` can have a portal without being a cold-email customer. They can also be both. The Customer Portal admin page filters by `portal_enabled = 1`.

14. **Self-links in `customer_services` are exempt from the cross-customer UNIQUE constraint.** The partial UNIQUE index has `WHERE linked_external_id IS NOT NULL AND email_client_id != linked_external_id`. Self-links represent "this customer's portal uses its own data" — they're a default state, not a cross-customer claim. Important: the original migration WITHOUT this exemption was deployed, and a fix was shipped that drops + recreates the index on every boot. Don't go back to the unconditional unique.

15. **Logo cross-sync is "option Z" — last write wins on both sides.** Uploading a logo on either the LinkedIn admin side OR the customer-portal admin side propagates to the other if a link exists. R2 keys differ (`logos/<id>/...` vs `logos/portal/<id>/...`) but both `logo_url` columns end up with the same URL.

16. **Slug auto-versioning on collision** — `tower-leasing` first, then `tower-leasing-2`, `-3`. Wez accepted that customer-facing URLs may end up looking versioned. **Don't try to "improve" this without re-asking.**

17. **Sessions are SQLite-backed, idle 7d / absolute 30d.** No in-memory Map (would die on Render restart).

18. **Customer "Approve all" → Supergrow uses live `queue_post`, NOT `create_post`/draft.** The customer's approval IS the green light. Differs from admin-side `deployToDrafts`.

19. **Admin sets initial portal passwords; portal shows "your password is temporary" banner on first sign-in.** No invite-link flow. Reset emails work the normal way for forgotten passwords later.

### Customer-portal final-mile decisions (locked in this chat)

20. **The customer portal mirrors the admin post-card layout exactly — image at natural aspect (no cropping), full body text with "Read full post" expand, content_pillar · format meta line, "📅 Day Time" schedule, four action buttons (Edit text / Rewrite post / New image / Approve).** The customer reviews exactly what'll be posted to LinkedIn — no truncated previews. Spinner overlays cover the card during text regen and sit over the image during image regen, with a "Please wait while your image/text is being regenerated" helper message.

21. **Regenerate is split into two backend routes — `/regenerate-text` (Anthropic only) and `/regenerate-image` (Gemini + R2 only).** Mirrors admin's "Rewrite post" / "New image" buttons. Combined 30/customer/day cap shared with the legacy combined `/regenerate` route — any text or image regen counts toward the same 30. The legacy combined route is kept in place but no longer wired to a UI.

22. **"View in Supergrow" link is hidden from customers everywhere.** Customers see the portal as a Green Agents product; they don't see the underlying Supergrow tool. Applies to both the live review grid and the read-only past-campaign history.

23. **Past campaigns history: ANY deployed campaign for this customer's linked LinkedIn client.** Specifically `stage IN ('deployed', 'done')` — meaning anything customer-approved via approve-all (`deployed`) AND anything admin pushed direct to Supergrow drafts before the portal existed (`done`). Read-only: same `PostCard` component as the live grid but with `readOnly` prop hiding the action row. Lives below the current-batch grid on the same LinkedIn Posts page (no separate "history" nav item).

24. **Customer portal sidebar uses identical colour to admin sidebar (`#0F6E56`).** TGA logo + tile + "The Green Agents / Studio" wordmark are visually identical at the top-left across both. Logo lives at `public/tga-logo.png` (Vite-bundled static asset, served from URL root).

25. **`generatePosts` runs without web search.** The web_search tool was the root cause of the 2026-05-07 Cube6 failure ("I need to conduct the required research before generating the posts" — Claude returned that as text and never produced JSON). The LinkedIn algorithm context now comes from the stored `algorithm_brief` (set by the admin "LinkedIn Algorithm" button). If the brief is null or older than 14 days, the campaign log shows a non-blocking warning. Both `generatePosts` and `regenerateSinglePost` also got an automatic JSON-parse retry — up to 2 attempts, with the second using an aggressive "JSON ONLY" override system message.

26. **Customer-portal reply send uses the mailbox the original arrived on.** Decision locked in chunk 3b-ii. The `email_inboxes.email_address` becomes the `From:` of the outbound. Maintains threading because (a) the recipient sees the same address that originally received them, (b) that mailbox is already SES-verified, (c) `In-Reply-To` and `References` headers wire the new message into the existing thread in Gmail/Outlook.

---

## Current state — what's deployed and working

### Phase 1: Core email sending (DONE, live)
- AWS SES via raw Signature V4
- Campaigns sent in batches with throttle (10/batch, 800ms gap)
- Subscribers + lists (per email_client)
- CSV import; one-shot send via `Send now`

### Phase 2: Bounce/complaint via SNS (DONE in code, **subscriptions still not added on AWS**)
- SNS topics `bounces` and `complaints` already exist (subscribed to Sendy too — both apps run in parallel)
- Backend endpoints `/api/email/sns/bounces` and `/api/email/sns/complaints` ready
- **TO-DO for user:** add HTTPS subscriptions on AWS pointing at studio's endpoints

### Phase 2.5: Smart per-recipient tracking (DONE, live)
- Three modes per campaign: `off` / `smart` / `all`
- Per-list "always_warm" override; pre-send dialog shows recipient breakdown
- Cold campaigns default to `tracking_mode='off'`

### Phase 3.1 + 3.1.5: Mailbox connection + IMAP polling + full-inbox view (DONE, live)
- Per-domain Gmail/Workspace mailbox via app password, AES-256-GCM at rest
- 3-min poll, manual "Check now"
- 30-day backfill on first poll; subsequent polls use `uid > last_uid`
- Manual `Resync` (non-destructive: reset `last_uid=0`) and **destructive Resync** (also wipes `email_replies` for that inbox)
- Three-strategy reply matching: `In-Reply-To` → `References` → sender lookup
- **Timestamp display fix**: SQLite's `datetime('now')` returns no Z; `relTime()` in EmailSection.jsx detects and force-treats as UTC

### Phase 3.2: Reply classification + auto-unsubscribe (DONE, live)
- Three-pass classifier in `services/classify-replies.js`: regex → heuristic OOO → Haiku for the rest
- Cron every 60s, up to 25 unclassified per tick, max 3 parallel Haiku calls
- Strips quoted/forwarded content before running
- Auto-unsubscribe fires on `hard_negative` AND `soft_negative`
- Buttons: **"Classify pending"** (mailbox header), **"Classify with AI"** (reply detail)

### Phase 3.3: Per-recipient personalisation (DONE, live)
- `services/name-parser.js` rule + Haiku fallback
- Columns on `email_subscribers`: `first_name`, `first_name_source`, `first_name_reason`
- 16 unit tests pass for rule parser
- `{{first_name}}` placeholder + legacy `[Name]`
- **Preview Campaign modal** — flip through subscribers, edit parsed name, skip count surfaced

### Phase 3.4: Drip ticker (DONE, live)
- `services/drip-ticker.js` runs every 60s
- Drip columns on `email_campaigns`: `drip_send_days`, `drip_window_start/end`, `drip_timezone`, `drip_today_date`, `drip_today_sent`, `drip_last_tick_at`
- ±30% jitter ("Option B")
- Re-checks status before every send → Pause/Cancel takes effect within seconds
- Render restart mid-burst is safe (uses `email_sends` row existence)
- ScheduleControls UI in CampaignModal with live finish-date estimate
- Campaign queue shows drip progress

### Phase 3.5: Drip progress reporting + recipients view (DONE, live)
- `CampaignReport` works for in-flight drips and sent campaigns
- New `View progress` button for scheduled / sending / paused
- `CampaignRecipientsPanel` with filter pills, search, CSV exports

### Phase 4 helpers (DONE, live)
- **Default sender per client** — `email_clients.default_from_email`/`default_from_name`
- **Line-spacing fix Option A** — `wrapBodyWithEmailCss()` in ses.js wraps every body with a CSS reset before SES base64. Outlook default `<p>` margins are normalised; empty `<p><br></p>` placeholders hidden.

### Phase 4 multi-step sequences (SCHEMA ONLY — runtime + UI not yet built)

DB layer is in. Runtime + sequence editor are not.

**What landed:**
- `email_campaign_steps(id, campaign_id, step_number, html_body, delay_days, created_at)` + unique on `(campaign_id, step_number)`
- `email_sends.step_number INTEGER NOT NULL DEFAULT 1` + `idx_email_sends_campaign_subscriber_step`
- Backfill: every existing campaign auto-gets a step_1 row from its `html_body` on first boot
- `sendCampaign()` accepts `stepNumber` and `bodyOverride` parameters

**Still missing:**
- Drip-ticker extension to pick up due follow-up sends
- Stop-condition filter (skip step N+1 if `email_replies` has a halting classification)
- Sequence editor UI in CampaignModal (mockup-first per lessons learned)
- Per-step reporting in `CampaignRecipientsPanel`

---

### Customer Portal (FULLY BUILT, LIVE)

A per-customer portal at `/c/<slug>` where each portal customer's contact (e.g. Rob at Cube6) signs in to review LinkedIn posts, see email-campaign stats, read replies, manage their portal users.

**Architecture is split across two sides — admin-side management and customer-facing portal.** Each runs through its own routes and has its own UI section.

#### Admin side — Customer Portal management

**Sidebar location:** `Sidebar.jsx` has a new section "**CUSTOMER PORTAL**" at the bottom with one item: **Portal Customers**. Mounted by `Dashboard.jsx` when `view === 'portal-customers'`.

**File:** `src/components/PortalAdmin.jsx`. Self-contained, ~1200 lines.

**Pages:**
- **Customers list** — table of every `email_clients` row where `portal_enabled = 1`. Columns: name, slug, portal users count, then one column per service (LinkedIn, Facebook, Email, …). Each cell shows "✓ <name>" / "Not required" / "Coming soon". Two header buttons: "**+ New portal customer**" (creates a fresh row) and "**Enable existing customer**" (turns an existing email_client into a portal customer).
- **Manage panel** (per customer) — five sections, top to bottom: Services, Logo, Portal users, Portal URL, Hide-from-list (danger zone).

**Services section** — fully data-driven from the `services` catalogue table. One dropdown per service. For services with `link_table` set (e.g. LinkedIn → `clients`, Email → `email_clients`), the dropdown lists picker options from that table. For plain services (no `link_table`), the dropdown is just Enabled / Not required. For `state = 'coming_soon'` services, the dropdown is greyed out.

**Logo section** — file upload, image preview, replace + remove buttons. Uses `multer` + R2 (same setup as LinkedIn-side `clients.js`). Cross-syncs to the linked LinkedIn `clients` row's `logo_url` if any.

**Portal users section** — table with username, email, role, last sign-in, reset-password + remove buttons. "+ Add user" button opens a modal that creates a `client_users` row and shows a one-time temporary password (Wez copies it and gives to the customer out-of-band). Reset-password also shows the new temp password once.

**Portal URL section** — copy-to-clipboard button for `https://studio.thegreenagents.com/c/<slug>`.

**Backend file:** `server/routes/portal-admin.js`, mounted at `/api/portal-admin`. Goes through the existing admin Bearer-token middleware. **Endpoints:**
- `GET /services` — services catalogue
- `GET /service-options/:service_key` — picker rows for a service's `link_table` (with already-linked-elsewhere flag)
- `GET /customers` — portal customers list (filtered to `portal_enabled = 1`)
- `POST /customers` — create new portal customer; auto-slug; defaults email service off
- `GET /customers/:id` — single customer + users
- `PUT /customers/:id` — toggle `portal_enabled`
- `PUT /customers/:id/services` — body `{ services: { <key>: { subscribed, linked_external_id? } } }`. Validates against catalogue, transactionally upserts, syncs legacy columns
- `GET /customers/:id/users` — list portal users
- `POST /customers/:id/users` — create user, returns temp password ONCE
- `DELETE /users/:id` — remove user (cascades sessions, resets, login attempts)
- `POST /users/:id/reset-password` — admin reset, returns new temp password ONCE, kills sessions, resets `last_login_at = NULL` so the temporary-password banner reappears
- `GET /eligible-customers` — email_clients NOT yet portal-enabled (drives "Enable existing customer" picker)
- `POST /customers/:id/logo` — upload logo, cross-syncs to LinkedIn `clients.logo_url` if linked
- `DELETE /customers/:id/logo` — clear logo, cross-clears LinkedIn

**Cross-sync from LinkedIn side:** `server/routes/clients.js` `POST /:id/logo` was extended — after uploading to R2 and updating `clients.logo_url`, it also `UPDATE email_clients SET logo_url = ?` for any portal customer linked to this LinkedIn client (via `customer_services` OR the legacy `linkedin_client_id` column).

#### Customer side — the portal itself

**Frontend file:** `src/components/customer-portal/PortalApp.jsx`. Self-contained. Mounted by `App.jsx` based on URL pattern `/c/<slug>`. The fetch interceptor in App.jsx **deliberately excludes `/api/portal/*` from the admin Bearer token** — portal calls use their own session cookie.

**Pages (all in PortalApp.jsx):**
- **Login** — username + password form. Subtitle pulls customer name from `GET /api/portal/by-slug/:slug`. "Forgot password?" link opens a modal that posts to `/auth/forgot-password` (always returns 200 — never leaks whether email is registered).
- **Reset password** — mounted when URL has `?reset=<token>`. Two password fields → POST to `/auth/reset-password`.
- **Portal chrome** (after login) — sidebar with three sections (**Social posts** / **Email** / **Account**), workspace area on the right. Sidebar headings are bold uppercase with bright colour for clear visual hierarchy.
- **LinkedIn Posts** — full review grid mirroring admin layout exactly. Image at natural aspect, full body with "Read full post" expand, four buttons (Edit text / Rewrite post / New image / Approve), spinner overlays during regen. Below the live grid: "Past campaigns" section with read-only history of every `deployed` or `done` campaign for this client.
- **Inbox** — real `/api/portal/inbox` data. Click a row to open full reply detail (HTML body when present, text fallback) in an email-client-style modal. Reply button opens compose modal that sends via SES from the mailbox the original arrived on, with `In-Reply-To` and `References` for threading.
- **Campaigns** — real `/api/portal/campaigns` read-only list with sent/opens/clicks/replies counts. Aggregate stats strip at top. `tracking_off` campaigns show "—" for opens/clicks with explanatory note.
- **Settings** — change own password (real, working), organisation users (deliberately shows the signed-in user only with a "managed by The Green Agents" note — Wez's call, not a TODO).

**Header logo:** 44×44 box. Renders `client.logo_url` when set, falls back to initials on the brand colour. Logo arrives via `/api/portal/auth/check`.

**ServiceGate** — wraps each tab page. Reads `services.<key>` (one of `'enabled'` / `'not_required'` / `'coming_soon'`) and renders either the real tab contents OR a "Not required" / "Coming soon" panel. So a customer subscribed only to LinkedIn still sees the Inbox + Campaigns nav items but each shows a calm "Not required" panel instead of empty data.

**Auth backend file:** `server/routes/portal-auth.js`, mounted at `/api/portal`. Endpoints:
- `GET /by-slug/:slug` — public; returns `{ client_name, slug }`
- `POST /auth/login` — generic 401 on failure; lockout: 10 fails / 15 min per `(email_client_id, username)` triggers a 15-min cooldown
- `POST /auth/logout` — kills CURRENT session only
- `GET /auth/check` — validates cookie, bumps idle expiry, returns `{ user, client, services }`
- `POST /auth/change-password` — kills all OTHER sessions, keeps current; clears any pending reset tokens
- `POST /auth/forgot-password` — always returns 200; sends SES email from `studio@thegreenagents.com` if user exists; reset URL is `/c/<slug>?reset=<token>`
- `POST /auth/reset-password` — kills ALL sessions including current; user has to sign in fresh

**Data backend file:** `server/routes/portal.js`, also mounted at `/api/portal` (Express cascades through routers at the same prefix). All routes go through `requirePortalSession` middleware applied via `router.use()` at the top — the customer is always resolved from the cookie.

**Endpoints currently shipped (full chunk 3b complete):**

Posts (3a + 3b-i):
- `GET /posts` — most-recent `awaiting_approval` campaign for the linked LinkedIn client. Returns `{ posts, campaign, not_subscribed }`. Posts projected from `campaigns.posts_json` to portal-friendly fields including `topic`, `content_pillar`, `format`, `suggested_day`, `suggested_time` so the customer card mirrors the admin layout.
- `PUT /posts/:id` body `{ title, body }` — saves edits AND marks approved (single-click for the common "tweak then accept" flow).
- `POST /posts/:id/approve` — approve without editing.
- `POST /posts/:id/regenerate` — combined regen (text + image). Kept for safety but no longer wired to a UI.
- `POST /posts/:id/regenerate-text` — text-only regen via `regenerateSinglePost` (Anthropic). Drops approval, counts against 30/day cap.
- `POST /posts/:id/regenerate-image` — image-only regen via Gemini + R2 upload. Drops approval, counts against 30/day cap.
- `POST /campaigns/:id/posts/approve-all` — bulk approve. On full success: pushes posts sequentially to Supergrow as live `queue_post` calls in `posts_json` order, then flips campaign stage to `deployed`. On partial failure: stops at the first failure (no out-of-order queue), keeps stage at `awaiting_approval`, marks only the successful ones with `client_approved_at`, audits the partial state. Returns 207 with details.

History (3b-i):
- `GET /campaigns-history` — all campaigns where `stage IN ('deployed', 'done')` for the linked LinkedIn client. Returns full projected posts arrays so the frontend can expand a card without a second fetch.

Inbox (3b-ii):
- `GET /inbox` — last 100 replies for the customer's mailboxes (resolved via `customer_services` email link). Returns rows with `from_address`, `from_name`, snippet, classification, received_at, matched_campaign_title.
- `GET /replies/:id` — full reply detail including `body_html` and `body_text`. 404 (not 403) on cross-tenant lookups.
- `POST /replies/:id/send` body `{ cc, body }` — send via SES. From-address is the mailbox the original arrived on. Sets `In-Reply-To` and `References` headers (built from the inbound reply's `message_id` + `references_header`). Stores an `email_outbound` row regardless of SES outcome — `message_id` populated on success or `error` populated on failure.

Campaigns (3b-iii):
- `GET /campaigns` — read-only list of every email campaign for the linked email_client, newest first, with sent/opens/clicks/bounces/unsubs/replies counts. Reply count computed from `email_replies.matched_campaign_id` (no stored count column on email_campaigns). `tracking_off: true` on campaigns where both `track_opens` and `track_clicks` are false. Status normalised to four customer-friendly values: `scheduled` / `sending` / `sent` / `failed`.

**Critical security rule:** every portal route MUST resolve `email_client_id` from the session cookie via `req.portalClient.id`, then resolve linked-services ids via `resolveEmailClientId(...)` or `resolveLinkedinClientId(...)`. Never trust an `email_client_id`, `slug`, or `linked_external_id` passed in URL params or request body. Return **404** (not 403) for resources that exist but don't belong to the caller.

**Frontend state:** `PortalApp.jsx` is now fully wired — no `// TODO(backend chunk 3b)` markers remain. The mock data constants (`mockReplies`, `mockCampaigns`) are still declared at the top of the file but no longer referenced anywhere in the active render paths; left in place to avoid noise in the diff and can be cleaned up in a future polish chat.

#### Customer portal — generic services design

**Two tables drive the entire services system.** Adding a new service in future is a DB insert, not a code change.

**`services` table** — catalogue:
```
service_key   TEXT PRIMARY KEY
display_name  TEXT NOT NULL
description   TEXT
state         TEXT NOT NULL DEFAULT 'live'   -- 'live' | 'coming_soon' | 'retired'
link_table    TEXT                            -- SQL table for picker options, NULL for plain on/off
link_label    TEXT                            -- friendly label for the picker
sort_order    INTEGER NOT NULL DEFAULT 100
created_at    TEXT NOT NULL DEFAULT (datetime('now'))
```

Currently seeded with three rows:
- `linkedin` → `link_table = 'clients'`, sort 10
- `facebook` → `state = 'coming_soon'`, sort 20
- `email`    → `link_table = 'email_clients'`, sort 30

**To add SEO** in the future:
```sql
INSERT INTO services (service_key, display_name, description, state, sort_order)
VALUES ('seo', 'SEO', 'Search engine optimisation reports.', 'live', 40);
```
The admin UI immediately shows an SEO dropdown. The customer portal frontend would need a new `<NavItem>` for it — that's the only React change.

**To add Google Ads with picker:**
```sql
INSERT INTO services (service_key, display_name, ..., link_table, link_label, sort_order)
VALUES ('google_ads', 'Google Ads', ..., 'google_ad_accounts', 'Google Ads account', 50);
```
Plus add `'google_ad_accounts'` to `ALLOWED_LINK_TABLES` in `portal-admin.js` (whitelist for SQL safety).

**`customer_services` table** — subscriptions:
```
id                 INTEGER PRIMARY KEY
email_client_id    TEXT NOT NULL
service_key        TEXT NOT NULL
linked_external_id TEXT                       -- NULL for plain on/off services
enabled_at         TEXT NOT NULL DEFAULT (datetime('now'))
enabled_by         TEXT                       -- 'admin' | 'backfill' | etc.
```

Indexes:
- `UNIQUE (email_client_id, service_key)` — one subscription per service per customer
- `INDEX (service_key)` — for picker queries
- `UNIQUE (service_key, linked_external_id) WHERE linked_external_id IS NOT NULL AND email_client_id != linked_external_id` — partial index that prevents two different customers from claiming the same external record. **Self-links (e.g. an email_client linking to its own id as the email source) are exempt** — they represent "use my own data" defaults, not cross-customer claims.

**Legacy columns kept for backwards compat:** `email_clients.service_email_enabled` and `email_clients.linkedin_client_id` are kept and synced from `customer_services` via `syncLegacyColumns()` after every service change. They can be dropped in a future cleanup chat once nothing reads them.

#### Locked-in defaults (don't relitigate)

- Brute-force lockout: 10 failed login attempts within 15 min per `(email_client_id, username)` → 15-min lockout
- Password minimum: 8 characters, no other rules
- Session: idle 7d, absolute 30d
- Bcrypt cost factor: 12
- Session tokens: `crypto.randomBytes(32).toString('base64url')`
- Slugs: lowercase, ASCII only, non-alphanumeric runs → single dash, trim. On collision append `-2`, `-3`...
- New customer-user provisioning: admin sets temp password, portal shows "your password is temporary" banner
- Reset emails: SES, From `studio@thegreenagents.com`
- Customer "Approve all" → Supergrow live `queue_post` (NOT draft)

---

## What's NOT done (priorities for next chat)

### 1. Real-world testing of chunk 3b (TOP PRIORITY)

All chunk 3b backend + frontend work is shipped and parse-clean. What hasn't happened yet:

- **End-to-end test of customer-portal Approve all → Supergrow push.** Cube6 hasn't yet had a successful test where the customer clicks "Approve all remaining" and sees posts land in Supergrow's live `queue_post`. Wez tried generating a new campaign for Cube6 on 2026-05-07 and hit the JSON-parse failure that has now been fixed (decision #25), but a fresh test cycle hasn't completed.
- **Inbox reply send via SES with threading.** Code shipped, not yet tested with a real reply.
- **Campaigns view with real numbers.** Code shipped, depends on the customer having real email_campaigns rows on their linked email_client.
- **History card expansion.** Code shipped, depends on having at least one `deployed` or `done` campaign.

The next chat should start by asking Wez to run a smoke test on each of these and reporting what works / what breaks. Don't add features until the existing ones are verified.

### 2. Phase 4 multi-step follow-up sequences — runtime + UI

Schema is in db.js. What's left:

**Design pre-decisions to confirm at start of that chat:**
- Stop conditions: positive / soft_negative / hard_negative classifications halt the sequence; auto_reply / forwarding don't
- Schedule inheritance: follow-ups use the same drip schedule as the original campaign
- Sequence editor UI: stacked step blocks with delay-days fields, max 10 steps
- Per-step reporting: "Last step" column in CampaignRecipientsPanel

**Build:**
- Drip-ticker extension to pick up due follow-up sends
- Stop-condition filter querying `email_replies`
- Sequence editor UI in CampaignModal — **mockup first**
- Per-step stats columns

### 3. Customer portal polish (small, low priority)

These came up during chunk 3b development but were deliberately deferred:

- **Mock data constants left declared.** `mockReplies` and `mockCampaigns` at the top of `PortalApp.jsx` are no longer referenced — they're harmless unused JS but worth a small cleanup.
- **The legacy combined `POST /posts/:id/regenerate` route** is no longer wired to a UI but kept in place. Can be removed in a future cleanup.
- **Stale-brief warning** is currently 14 days. May want tuning based on observed cadence.
- **Reply send retry on transient SES failure.** Currently fails fast with a 502 + error banner. Could add 1 retry with backoff for transient throttle errors.
- **Inbox infinite scroll / search.** Capped at 100 most-recent replies. If a customer has thousands, older ones are invisible.
- Visible feedback when a service is set to "Not required" (subtle warning text on the Manage panel).
- Banner at top of Manage panel when zero services are subscribed: "This customer has no services enabled — they'll see 'Not required' on every tab."
- Greater visual distinction for the Save Services button when dirty (currently relies on opacity change which can be missed).

### 4. SNS subscription wiring (USER ACTION ONLY, no code)

Endpoint code is done. User adds HTTPS subscriptions on AWS console.

### 5. Phase 5: Send & reply from inside the studio inbox (NOT STARTED)

Plain text v1. Use email_client name as from-name. Compose new + reply to existing.

**Build:**
- `npm install nodemailer`
- `services/smtp-sender.js` using `smtp.gmail.com:465` with the IMAP app password
- IMAP APPEND to Gmail Sent folder so user's Gmail shows the reply
- Don't reprocess our own sends as inbound (track sent message-ids)
- Compose modal with To/Subject/Body + Reply button

### 6. Phase 6: Postmaster Tools + SNDS (USER ACTION ONLY)

Direct user to set up `postmaster.google.com` and `sendersupport.olc.protection.outlook.com/snds/`.

### 7. Smaller backlog items

- **Drip starts immediately when scheduled today past window:** add a "fires next at..." line in the campaign queue
- **Reply matching for self-tests is broken** by design (Gmail rewrites threading between Workspace accounts)
- **Audit-log viewer** UI for `GET /api/email/audit-log`
- **`export default router` mid-file in routes/email.js** — cosmetic, not blocking
- **Drip reset on edit confirmation dialog** — currently changes apply tomorrow

---

## Database schema (current)

Migrations run on every boot in `server/db.js`. SQLite at `/var/data/studio.db` on Render.

### Core tables (Phase 1-2)
- `email_clients` — top-level grouping. Columns: `id, name, color, slug, default_from_email, default_from_name, portal_enabled, service_email_enabled, linkedin_client_id, logo_url, ...`
- `email_brands`, `email_lists`, `email_subscribers`, `email_campaigns`, `email_sends`, `email_link_clicks`, `email_campaign_links`, `email_sns_events`

### Phase 3 tables
- `email_inboxes` — Gmail mailboxes, AES-256-GCM `app_password_encrypted`, `last_uid` for IMAP poll
- `email_replies` — every email fetched, with classification fields
- `email_audit_log`

### Phase 4 (schema landed, runtime not built)
- `email_campaign_steps`, `email_sends.step_number`

### Customer portal (FULLY LIVE)
- `client_users (id, email_client_id, username, email, password_hash, role, created_at, last_login_at)` — UNIQUE on `(email_client_id, username)`
- `client_sessions (id [token], client_user_id, expires_at, created_at)` — idle 7d, absolute 30d
- `password_resets (id [token], client_user_id, expires_at [+1h], used_at, created_at)`
- `client_login_attempts (id, email_client_id, username, attempted_at)` — for brute-force lockout
- `client_post_regens (id, email_client_id, client_user_id, campaign_id, post_id, created_at)` — for daily 30/customer regen cap
- `email_outbound (id, email_client_id, in_reply_to_reply_id, client_user_id, from_address, to_address, cc_address, subject, body_text, body_html, message_id, in_reply_to_header, references_header, sent_at, error)` — outbound SES sends from the portal reply form
- `services (service_key, display_name, description, state, link_table, link_label, sort_order, created_at)` — services catalogue, seeded with linkedin/facebook/email
- `customer_services (id, email_client_id, service_key, linked_external_id, enabled_at, enabled_by)` — subscriptions, with two UNIQUE indexes (one full, one partial-and-self-link-exempt)

### Per-post approval state (inside `posts_json`, not a table)
Each post object inside `campaigns.posts_json` may have:
- `client_approved_at` — ISO timestamp from customer portal approve action
- `client_approved_by_user_id` — which `client_users` row clicked approve

Decision locked: keeping in JSON beats a sidecar table because all other per-post state (`linkedin_post_text`, `image_url`, `app_url`, `image_error`) lives there too.

### Helper attached to db object
- `db._portalUniqueSlug(name, excludeId)` — slug helper. Called by `routes/email.js` POST /clients and `routes/portal-admin.js` POST /customers.

---

## Important env vars (Render)

| Var | Purpose |
|---|---|
| `STUDIO_PASSWORD` | Admin Bearer auth |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | SES + SNS |
| `AWS_SES_REGION` | `eu-north-1` |
| `SES_CONFIGURATION_SET` | `studio-no-tracking` |
| `MAILBOX_ENCRYPTION_KEY` | 32-byte base64 for IMAP password encryption — **never rotate without migration** |
| `PUBLIC_URL` | base URL for tracking + reset links |
| `DB_PATH` | `/var/data/studio.db` |
| `ANTHROPIC_API_KEY` | Haiku for name parser, reply classifier |
| `NAME_PARSER_MODEL` / `CLASSIFIER_MODEL` | override Haiku model id (defaults to `claude-haiku-4-5-20251001`) |
| `R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_PUBLIC_URL` | Cloudflare R2 for images and logos |
| `NODE_ENV` | `production` on Render — drives Secure cookie flag for portal sessions |

If you ever see `[name-parser] AI fallback failed: ...model not found...` in Render logs, set `NAME_PARSER_MODEL` to whatever the current Haiku string is (check `https://docs.claude.com`). Same for `CLASSIFIER_MODEL`.

---

## File map (current)

```
server/
  index.js                        — boots app, mounts all routers, starts pollers/cron
                                    Mounts:
                                      /api/auth          → auth.js (admin login)
                                      /api/clients       → clients.js (LinkedIn/Supergrow)
                                      /api/campaigns     → campaigns.js (LinkedIn campaigns)
                                      /api/email         → email.js
                                      /api/algorithm     → algorithm.js
                                      /api/portal        → portal-auth.js (auth) + portal.js (data)
                                      /api/portal-admin  → portal-admin.js (admin-only)
  db.js                           — schema + migrations (run every boot, additive only)
                                    Note: linkedin_settings UPDATE happens BEFORE its CREATE TABLE
                                    line; works on existing prod DBs because the table was
                                    created on a prior deploy. Would crash on a fresh DB.
                                    Not blocking but worth fixing in a cleanup chat.
  middleware/auth.js              — Bearer token check (admin)
  routes/
    auth.js                       — admin login
    clients.js                    — Supergrow clients (NOT email_clients).
                                    POST /:id/logo cross-syncs to email_clients.logo_url.
    campaigns.js                  — Supergrow campaigns (NOT email_campaigns)
    email.js                      — ALL email-side routes. 1700+ lines. POST /clients now
                                    auto-generates slug via db._portalUniqueSlug.
                                    NB: export default router appears mid-file (~line 1173)
                                    with routes after it. Works (export-binding semantics)
                                    but confusing.
    algorithm.js                  — Supergrow algorithm
    portal-auth.js                — customer-portal auth + requirePortalSession middleware
                                    Exports requirePortalSession for use by portal.js.
    portal.js                     — customer-portal data routes. ALL OF CHUNK 3b SHIPPED.
                                    13 routes: GET /posts, PUT /posts/:id, POST /posts/:id/approve,
                                    POST /posts/:id/regenerate (legacy combined), POST /posts/:id/regenerate-text,
                                    POST /posts/:id/regenerate-image, POST /campaigns/:id/posts/approve-all,
                                    GET /campaigns-history, GET /inbox, GET /replies/:id,
                                    POST /replies/:id/send, GET /campaigns.
    portal-admin.js               — admin-side customer-portal management
  services/
    ses.js, tracking.js, touch-count.js, crypto-vault.js, imap-poller.js,
    classify-replies.js, name-parser.js, drip-ticker.js,
    claude.js, openai.js, supergrow.js, etc.
src/
  App.jsx                         — auth + dashboard mount; mounts PortalApp at /c/<slug>;
                                    fetch interceptor excludes /api/portal/* from admin Bearer
  components/
    Sidebar.jsx                   — left nav. Sections: Social Media Posts, Email Campaigns,
                                    Customer Portal. Mailboxes badge polls every 30s.
    Dashboard.jsx                 — view router (LinkedIn Posts / Customers / Domain Health /
                                    Mailboxes / Portal Customers)
    EmailSection.jsx              — THE BIG ONE. 2600+ lines. Email-related everything.
    ClientDetail.jsx              — LinkedIn-side client detail. Logo upload here cross-syncs
                                    to portal customers.
    PortalAdmin.jsx               — admin Customer Portal management (~1200 lines)
    customer-portal/
      PortalApp.jsx               — full customer-facing portal (~1400 lines)
                                    Includes login, reset password screen, all four tabs,
                                    settings, modal forms.
    RichTextEditor.jsx            — contentEditable wrapper
```

---

## Things that have caused pain (lessons)

1. **Always parse-check before claiming success.** EmailSection.jsx is 2600+ lines, PortalApp.jsx is 1400+. str_replace can silently delete lines if context isn't unique. Path: `/home/claude/.npm-global/lib/node_modules/tsx/node_modules/esbuild/bin/esbuild --loader:.jsx=jsx --log-level=warning <file> > /dev/null && echo OK`. Same for Node files: `node --check <file>`.

2. **str_replace + similar code blocks** — when several modals all start the same way, str_replace refuses with "found multiple times". Add 2-3 lines of unique surrounding context to disambiguate.

3. **MIME encoding bugs are subtle** — declaring quoted-printable but not actually QP-encoding the body works for ASCII but corrupts URLs. Stick with base64.

4. **The user pushes via GitHub Desktop on Windows** — can't run `npm install` themselves. If you add a dep to package.json, Render auto-installs on deploy. Don't ask user to run commands.

5. **The user values honest pushback over agreement.** When a pre-decision turns out wrong once you're knee-deep (e.g. "no posts table exists, can't extend it"), surface it. Don't silently work around. The user explicitly asked for this throughout.

6. **Big design changes deserve mockups before code.** When user asks for new UI, build interactive HTML mockups first (`visualize:show_widget` tool). Confirm direction before writing React.

7. **Browser editor visual ≠ recipient visual.** RichTextEditor uses lineHeight 1.6 and `<p>` blocks. Recipients see Outlook's `<p>` margins on top of that. `wrapBodyWithEmailCss` in ses.js compensates server-side.

8. **SQLite timestamps need timezone treatment.** `datetime('now')` returns a UTC string with a space and no Z. Browsers parse that as local time. Fix: detect format, append `Z` before constructing Date.

9. **Tool reminders / yellow toast** in claude.ai sometimes fire after long tool calls. Conversation usually still completes correctly. Tell user to refresh if it blocks.

10. **Phantom `last_uid`** — mailboxes connected pre-3.1.5 had `last_uid` set to current. Resync button forces fresh 30-day backfill.

### Lessons specific to the customer-portal work (this chat)

11. **Don't confuse "admin can save it" with "deployed and tested."** When Wez saves a service config, the database changes — but the customer-side portal might be cached, signed in pre-config, etc. Always tell Wez to hard-refresh (Ctrl+F5) the customer side after admin changes, especially if testing in a different tab.

12. **The two `clients` tables are a fact, not a problem to solve.** `clients` (LinkedIn) and `email_clients` (cold email) are independent. The customer portal joins them via `customer_services.linked_external_id`. This is the correct design and should NOT be merged or "cleaned up" without a major refactor that's well outside the portal scope.

13. **Self-links on `customer_services` are normal.** When a cold-email customer's portal points at its own email_clients row, that's the natural default. Don't add UNIQUE constraints that block it. The fix shipped: partial UNIQUE with `email_client_id != linked_external_id`.

14. **Generic services beats per-service columns once you hit service #3.** Adding Facebook would have been "another column"; adding SEO, Google Ads, etc. would have multiplied the cost. The `services` + `customer_services` design is now the source of truth — adding a new service is a DB insert.

15. **Backfill self-links explicitly when migrating.** When we moved from `service_email_enabled` (bool) to `customer_services` (rows with picker), every existing email-enabled customer needed a `customer_services` row pointing at itself. Without that, they'd silently lose email service on the next save. The migration handles this with `INSERT OR IGNORE` + a one-shot UPDATE for any rows already inserted with NULL.

16. **Mounting two routers at the same prefix works in Express.** `app.use('/api/portal', authRouter)` and `app.use('/api/portal', dataRouter)` both apply at the same prefix; requests cascade through them and each only matches its declared routes. The middleware `requirePortalSession` on `dataRouter` only runs for requests routed to it, not auth routes. Correct mounting order: auth first, data second.

17. **Don't fake tool calls.** I made one mistake this chat where I wrote `[USl_replace]` and "Successfully replaced string" as plain text instead of actually calling tools. No edits happened. The user caught it. **Always use real tool calls; if you see plain-text "tool result" lines without a real tool call confirmation, redo the work.**

### Lessons specific to chunk 3b (this chat)

18. **Read the Render logs before guessing.** When the user reported HTTP 500 on GET /posts after chunk 3b-i deploy, I spent multiple turns inspecting code looking for an import error. The actual cause was a `SELECT id, title, ... FROM campaigns` — `title` doesn't exist as a column on the `campaigns` table — and was visible in the logs immediately. Lesson: when a 500 hits, **ask for the Render log first**, don't guess from the code.

19. **`useState` calls must be above all early returns.** When extending `PortalPosts` with new state for chunk 3b-i (busy map, expandedId, bulkBusy, etc.), I initially put the new `useState` calls below the loading/error/empty early returns. React's rules-of-hooks require hooks to run in the same order on every render — putting them after a `return` violates this. Fixed by moving all hook calls to the top of the function.

20. **`generatePosts` web search was the failure mode.** On 2026-05-07, Cube6's campaign failed with "Claude did not return valid JSON: I need to conduct the required research before generating the posts." The model decided to research first and emitted a text response instead of JSON. Web search has now been removed from `generatePosts` (decision #25). The LinkedIn algorithm context comes from the stored `algorithm_brief` instead. Both `generatePosts` and `regenerateSinglePost` also got automatic JSON-parse retry — up to 2 attempts.

21. **Sidebar colour consistency was a real issue, not just aesthetic.** Admin and customer portal sidebars used different greens (`#0F6E56` vs `#0e3b2d`). Customer noticed immediately when comparing screenshots. Lesson: "consistent branding" means literal colour values, not "they're both green-ish."

22. **Mirror-the-admin meant exactly that.** The customer-portal post card had been built independently with truncated text, force-cropped 1.91:1 images, two action buttons. The admin used full text + natural-aspect images + three action buttons. Customer's instruction was "mirror the admin exactly" — which surfaced a series of decisions (separate Rewrite/New image buttons, hide "View in Supergrow", combined or separate regen cap) that needed pre-confirmation before code. Building those mockups first, getting calls on each, then writing code in one shot was the right path.

23. **Static asset convention: `public/` directory.** The repo had no images bundled anywhere — even the favicon was inline SVG. I created `public/tga-logo.png` as the convention going forward. Vite serves `public/*` from the URL root with no config changes. Future image assets should follow this pattern.

---

## What to do first in next chat

1. **Read this whole blueprint.**
2. **Ask Wez what's been tested and what's not.** Chunk 3b is fully shipped (backend + frontend + parse-clean) but real-world end-to-end tests of approve-all → Supergrow push, inbox reply send, campaigns view, and history expansion may not all have happened. The next chat's first job is verifying what works. Don't add features until existing ones are confirmed working.
3. **If Wez surfaces bugs from the chunk 3b deploy, fix those first.** Common things to check based on this chat's experience:
   - Is the algorithm_brief populated? `generatePosts` now relies on it. If null, posts generate from Claude's built-in knowledge (good but not customer-specific). If older than 14 days, the campaign log shows a non-blocking warning.
   - Are reply send threading headers landing correctly? Check Gmail/Outlook's "show original" on a customer-portal-sent reply to confirm `In-Reply-To` and `References` are wired.
   - Does the customer's linked email_client have an `email_inboxes` row? The reply-send route 500s if the mailbox can't be resolved — the helper returns null which the route handles, but verify in practice.
4. **Once chunk 3b is verified, the customer portal is functionally complete.** Next priority is **finishing Phase 4 multi-step sequences** (schema is in, runtime + UI still missing). Get the four design pre-decisions confirmed before writing code.
5. **Smaller backlog items** (see "What's NOT done" §3) are polish — don't pick those up before bigger pieces unless Wez asks.

---

## Final word

The user is patient, curious, and a great collaborator. They put genuine effort into testing each phase and report back with screenshots + Render logs. They want this to be a real product they could one day sell to other companies. Treat the project that way — quality matters more than speed. When in doubt, ask.

— Claude (end-of-chat handoff after customer-portal chunk 3b complete + admin-mirroring + history + post-generation reliability fix + sidebar parity)
