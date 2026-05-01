# THEGREENAGENTS STUDIO — COMPLETE BLUEPRINT
**Last updated: April 2026 — Session 5 complete**
> This is the single source of truth. Read ALL of it before touching any code. Every session starts by cloning the repo and reading this file.

---

## SIDEBAR ARCHITECTURE — CRITICAL

Each sidebar nav item is a completely separate app section with its own component, routes, and DB tables. They share the sidebar and auth only. Never let changes in one section affect another.

| Nav item | Component | Purpose |
|---|---|---|
| Supergrow | `Dashboard.jsx` + `ClientDetail.jsx` | LinkedIn campaign pipeline |
| Customers | `EmailSection.jsx` | Email campaign clients + lists + campaigns |
| Domain Health | `EmailSection.jsx` (initialTab='domains') | DNS health check for all verified domains |

### Sidebar structure (Session 5)
```
SOCIAL MEDIA POSTS          ← bold section header
  Supergrow                 ← nav item

EMAIL CAMPAIGNS             ← bold section header
  Customers                 ← sub-item (indented, left accent bar when active)
  Domain Health             ← sub-item
```

Routing lives in `Dashboard.jsx`:
- `view === 'clients'` → Supergrow/LinkedIn pipeline
- `view === 'email-customers'` → `<EmailSection initialTab="customers" />`
- `view === 'email-domain-health'` → `<EmailSection initialTab="domains" />`

Adding a new section = add nav item to `Sidebar.jsx`, add route condition in `Dashboard.jsx`, create component.

---

## HOW WE WORK (read this first)

- Wez communicates via short messages and screenshots
- Always clone/pull repo and read BLUEPRINT.md at the start of every session
- Always read relevant source files before editing
- Always syntax check before committing: `node --check server/file.js`
- Discuss UI changes with mockup widgets BEFORE building
- Every change committed with clear message and pushed to main immediately
- Render auto-deploys on every push to main (~3-5 min build)
- Always tell Wez which folder every file goes in: `file.js` → `server/routes/`
- Never use require() — ESM only (import/export)
- Never use localStorage in artifacts
- Plain language only — no code jargon when talking to Wez

---

## WHAT THIS APP IS

**The Green Agents Studio** is a private internal web app for THEGREENAGENTS.COM. It does two things:

**1. LinkedIn campaigns (Supergrow)** — generates LinkedIn posts via Claude + images via Gemini, deploys as drafts to Supergrow for client approval.

**2. Email campaigns** — sends email campaigns directly via AWS SES. Full replacement for Sendy. Independent client list, mailing lists, subscribers, campaigns, drip scheduling, campaign reports.

---

## WHERE EVERYTHING LIVES

| Item | Location |
|---|---|
| GitHub repo | `https://github.com/H6gvbhYujnhwP/thegreenagents-studio` |
| Live app | `https://studio.thegreenagents.com` |
| Render service | `thegreenagents-studio` (Starter, $7/month) |
| Render disk | `/var/data` — 1GB persistent SQLite |
| SQLite DB | `/var/data/studio.db` (env: `DB_PATH`) |
| Sendy (being replaced) | `https://sendy.thegreenagents.com` |
| AWS SES region | `eu-north-1` (Stockholm) |
| AWS IAM user | `tga-studio-ses` (AmazonSESFullAccess) |
| AWS Account | 262023811768 (Sweetbyte) |

---

## TECH STACK

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 ESM (`"type":"module"`) |
| Framework | Express.js |
| Database | SQLite via `better-sqlite3` |
| Frontend | React 18 + Vite |
| Auth | Stateless Bearer token in localStorage. `window.fetch` patched in `App.jsx` to auto-add `Authorization: Bearer` to all `/api/` calls |
| LinkedIn posts | Claude `claude-sonnet-4-5` via Anthropic SDK + web_search tool + prompt caching |
| Images | Gemini `gemini-2.5-flash-image` via `@google/genai` SDK (Nano Banana style) |
| Image storage | Cloudflare R2 via `@aws-sdk/client-s3` |
| LinkedIn deploy | Supergrow MCP — `create_post` only (drafts, never queue_post) |
| Email sending | Raw HTTPS to AWS SES API — NO SDK for sends (see SES section) |
| File uploads | `multer` (memory storage) |
| Progress | Server-Sent Events (SSE) |
| Hosting | Render |

---

## FILE STRUCTURE

```
thegreenagents-studio/
├── index.html
├── package.json
├── vite.config.js
├── render.yaml
├── BLUEPRINT.md                        ← this file
│
├── server/
│   ├── index.js                        Express app entry point
│   ├── db.js                           SQLite schema + migrations
│   ├── middleware/
│   │   └── auth.js                     Bearer token auth (requireAuth)
│   ├── routes/
│   │   ├── auth.js                     POST /login, GET /check
│   │   ├── clients.js                  LinkedIn client CRUD + RAG + Supergrow sync
│   │   ├── campaigns.js                LinkedIn campaign pipeline + SSE + deploy
│   │   └── email.js                    Email clients/brands/lists/subscribers/campaigns
│   └── services/
│       ├── openai.js                   Claude post generation (LinkedIn)
│       ├── gemini.js                   Nano Banana image generation
│       ├── r2.js                       Cloudflare R2 upload
│       ├── supergrow.js                Supergrow MCP client
│       └── ses.js                      AWS SES — raw HTTPS, no SDK for sends
│
└── src/
    ├── main.jsx
    ├── App.jsx                         Auth check + global fetch patch
    ├── index.css
    └── components/
        ├── Dashboard.jsx               Routing hub (Supergrow view + email routing)
        ├── Sidebar.jsx                 Nav with section headers + sub-items
        ├── ClientCard.jsx              LinkedIn client card
        ├── NewClientModal.jsx          LinkedIn new client form
        ├── ClientDetail.jsx            LinkedIn client detail + campaigns
        ├── CampaignProgress.jsx        SSE progress + post review + deploy
        ├── RichTextEditor.jsx          contentEditable rich text for email body
        └── EmailSection.jsx            Full email module (~1200 lines)
```

---

## DATABASE SCHEMA

### LinkedIn tables

**clients**
```sql
id, name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
supergrow_api_key, timezone, cadence, posting_identity, approval_mode,
rag_filename, rag_content, created_at, updated_at
```

**campaigns**
```sql
id, client_id, status, stage, progress, total_posts, posts_generated,
images_generated, posts_deployed, posts_json, error_log, files_json,
created_at, completed_at
```

### Email tables (Session 4+5 — COMPLETELY SEPARATE from LinkedIn tables)

**email_clients** — independent client list, no link to LinkedIn clients
```sql
id, name, color, test_email, created_at
```
Auto-populated on startup from AWS SES verified domains. test_email persists per client.

**email_brands**
```sql
id, email_client_id, name, from_name, from_email, reply_to, color, created_at
```

**email_lists**
```sql
id, email_client_id, name, from_name, from_email, reply_to, subscriber_count, created_at
```

**email_subscribers**
```sql
id, list_id, email, name, status (subscribed|unsubscribed|bounced|spam),
created_at, unsubscribed_at, bounced_at, spam_at
UNIQUE(list_id, email)
```

**email_campaigns**
```sql
id, email_client_id, list_id, title, subject, from_name, from_email, reply_to,
html_body, plain_body, status (draft|scheduled|sending|paused|sent|failed),
scheduled_at, sent_at, sent_count, open_count, click_count, bounce_count,
unsubscribe_count, spam_count, daily_limit, queue_position, drip_start_at,
drip_sent, send_order, created_at
```

**email_sends**
```sql
id, campaign_id, subscriber_id, status, opened_at, clicked_at, bounced_at, sent_at
```

**email_link_clicks**
```sql
id, campaign_id, subscriber_id, url, clicked_at
```

### DB migrations (run on every startup in db.js)
All migrations use `PRAGMA table_info()` to check before altering — safe to run repeatedly.
- email_clients table created if missing
- email_client_id added to email_brands, email_lists, email_campaigns if missing
- email_lists rebuilt without old NOT NULL client_id constraint
- email_campaigns rebuilt without old NOT NULL client_id constraint
- spam_at added to email_subscribers if missing
- drip/queue columns added to email_campaigns if missing
- email_link_clicks table created if missing
- test_email added to email_clients if missing

---

## ENVIRONMENT VARIABLES (set in Render)

| Key | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API — LinkedIn post generation |
| `OPENAI_AI_KEY` | Legacy env var name — kept for compatibility |
| `GEMINI_API_KEY` | Google AI Studio — Nano Banana images |
| `SUPERGROW_MCP_URL` | Supergrow MCP URL with api_key param |
| `R2_ACCOUNT_ID` | Cloudflare R2 |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 |
| `R2_BUCKET_NAME` | `supergrowfortga` |
| `R2_ENDPOINT` | R2 endpoint URL |
| `R2_PUBLIC_URL` | Public R2 image base URL |
| `STUDIO_USERNAME` | Login username (default: `greenagents`) |
| `STUDIO_PASSWORD` | Login password |
| `DB_PATH` | `/var/data/studio.db` |
| `AWS_ACCESS_KEY_ID` | tga-studio-ses IAM user |
| `AWS_SECRET_ACCESS_KEY` | tga-studio-ses IAM user |
| `AWS_SES_REGION` | `eu-north-1` |

---

## AUTH

Stateless Bearer token. On login, server returns a token stored in `localStorage`. `App.jsx` patches `window.fetch` globally to add `Authorization: Bearer <token>` to every `/api/` request. No cookies, no sessions.

`server/middleware/auth.js` exports `requireAuth` — used on all protected routes.
`/api/email/unsubscribe` is public (no auth).

---

## EMAIL MODULE — FULL DETAIL (Sessions 4 + 5)

### Architecture
AWS SES sends all emails. No Sendy dependency.

**CRITICAL — SES sending uses raw HTTPS, NOT the AWS SDK.**
The AWS SDK v3 middleware attaches the account-level default configuration set to every send, which causes AWS to inject its `awstrack.me` tracking pixel. Sendy avoids this by using raw HTTP calls. We do the same.

`server/services/ses.js`:
- Builds raw MIME email (multipart/alternative, plain + HTML parts)
- Signs request manually with AWS Signature V4 (same algorithm as Sendy's class.amazonses.php)
- POSTs directly to `https://email.eu-north-1.amazonaws.com/`
- Parameters sorted alphabetically before signing (ksort — required for correct signature)
- No ConfigurationSetName passed — no pixel injected
- SDK still used ONLY for read-only queries: GetSendQuota, ListIdentities, GetIdentityVerificationAttributes

### Email clients — auto-populated from AWS
On every load of the Email section, the app:
1. Fetches verified domains from AWS SES (ListIdentities)
2. Compares against existing email_clients in DB
3. Auto-creates a client for any domain not yet in DB
4. Clients persist with all their data (lists, campaigns) permanently
5. Clients can be renamed via Edit — the domain link is stored as the name initially

### UI structure

**Left panel** — email client list (searchable, 240px)
- Auto-populated from AWS verified domains on first load
- Each client shows list count + active subscriber count
- Click client → right panel loads

**Right panel — Campaigns tab** — Campaign queue table (Variant 3)
- Table columns: #, Campaign, Status, List, Daily limit, Progress, Est. finish, Actions
- Test send field at top (persists per client in DB)
- Actions per campaign: Edit, Schedule drip, Send now, Test, Pause/Resume, Delete
- Click campaign title on sent campaigns → Campaign Report screen
- Auto-polls every 5s while any campaign is in 'sending' status

**Right panel — Lists tab** — Option A table
- Columns: List name, Active, Unsubscribed, Bounced, Spam, Actions
- Actions: View, Import, Export, Delete
- Header buttons: Import new list, + New list
- Click View → Subscriber detail screen

**Subscriber detail screen**
- Stats bar: Active, Bounced %, Unsubscribed %, Spam
- Filter tabs: All, Subscribed, Bounced, Unsubscribed, Spam (with counts)
- Search by name or email
- Paginated (50 per page)
- Import CSV, Export, Add subscriber buttons
- Per-row: Unsubscribe (active) or Remove (bounced/spam)

**Domain Health** (sidebar sub-item, not a tab)
- Loads all verified AWS domains automatically
- Checks SPF, DKIM, DMARC, MX for each
- Grid of domain cards with Pass/Missing per check
- Refresh button

### Campaign report screen
Shown when clicking a sent campaign title. Shows:
- 6-metric stats bar: Recipients, Opened %, Clicked %, Not opened %, Unsubscribed %, Bounced %
- Export buttons: openers, clickers, non-openers, bounced (CSV download)
- Engagement breakdown with per-metric export
- Top countries bar chart (approximate until open tracking pixel built)
- Link activity table: URL, unique clicks, total clicks, export clickers per link
- Duplicate campaign button

### Drip scheduling
- "Schedule drip" button on draft campaigns
- Modal: emails per day, start date, send order (top-to-bottom or random)
- Auto-calculates days to complete + estimated finish date
- Campaigns can be paused and resumed
- Status: draft → scheduled → sending → paused → sent

### Rich text email editor
`RichTextEditor.jsx` — contentEditable-based, no external libraries.
Features: Bold, Italic, Underline, Strikethrough, Align L/C/R, Bullet list, Numbered list, Indent, Link insert, Text colour, Background colour, Heading picker, Font size picker.
Line breaks and formatting preserved exactly in sent email.

### [Name] personalisation
- Type `[Name]` anywhere in email body or subject
- Replaced with subscriber's first name at send time
- On test sends: replaced with "there" (→ "Hi, there")
- First name = first word of stored name field

### Import new list (3-step wizard)
Step 1 — Upload CSV (browse or drop)
Step 2 — CSV table with dropdown above each column header:
  - Options: Email address ✱, Full name (split on first space), First name only, Last name only, Skip
  - Auto-detects column roles from header names
  - Only one column per role (selecting email on col B unsets it from col A)
  - "Hi, X" preview tag on first data row for name column
  - List details form: name, from name, from email
Step 3 — Field checker + review:
  - Validates all email addresses
  - Lists bad rows with row number and issue
  - Preview table: Name stored, Email, Hi [Name] preview
  - Summary: total, to import, issues found
  - Create list & import button

### Import into existing list
- Supports Sendy export format directly (Name, Email, Status columns)
- Status mapped: Bounced, Unsubscribed, Spam, Active → our statuses
- Duplicate emails silently ignored (INSERT OR IGNORE)

### CSV export
- Export from list row: all subscribers as CSV
- Export from subscriber view: current filtered view
- Export from campaign report: openers / clickers / non-openers / bounced

### SES verified domains (auto-loaded)
Pulled live from AWS on every app load. Currently verified (eu-north-1):
sweetbyte.co.uk, mail.weprintcatalogues.com, clear-a-way.co.uk, itcloudpros.uk,
thegreenagents.com, mail.engineersolutions.co.uk, syncsure.cloud, socialecho.ai,
clearerpaths.co.uk

### API routes (`/api/email/`)
```
GET    /clients                         List email clients (with stats)
POST   /clients                         Create email client
PUT    /clients/:id                     Edit (name, color, test_email)
DELETE /clients/:id                     Delete + cascade all data

GET    /brands?email_client_id=         List brands
POST   /brands                          Create brand
PUT    /brands/:id                      Edit brand
DELETE /brands/:id                      Delete brand

GET    /lists?email_client_id=          List with per-status counts
POST   /lists                           Create list
DELETE /lists/:id                       Delete + subscribers

GET    /lists/:id/subscribers           All subscribers (no status filter — client-side)
POST   /lists/:id/subscribers           Add single subscriber
POST   /lists/:id/import                Bulk CSV import (Sendy format supported)
DELETE /lists/:listId/subscribers/:subId  Unsubscribe/remove

GET    /lists/:id/queue                 Campaigns for a list (queue order)
POST   /lists/:id/queue/reorder         Reorder campaign queue

GET    /campaigns?email_client_id=      List campaigns with list_name
POST   /campaigns                       Create campaign
PUT    /campaigns/:id                   Edit campaign
DELETE /campaigns/:id                   Delete campaign
POST   /campaigns/:id/send              Send now (background)
POST   /campaigns/:id/start-drip        Configure + start drip send
POST   /campaigns/:id/pause             Toggle pause/resume
POST   /campaigns/:id/test              Test send to single address
GET    /campaigns/:id/report            Campaign stats + link clicks
GET    /campaigns/:id/export/:type      CSV export (openers|clickers|non-openers|bounced)

GET    /unsubscribe                     PUBLIC — unsubscribe link handler
GET    /domain-health/:domain           SPF/DKIM/DMARC/MX DNS checks
GET    /verified-domains                Live from AWS SES (ListIdentities)
GET    /stats                           Overall email stats
```

### SES sending detail
- Batches: 10 emails per batch, 800ms delay (~12/sec, under 14/sec limit)
- No unsubscribe link injected (removed by request — legal compliance is user's responsibility)
- [Name] replaced per subscriber before send
- Test sends: subject prefixed [TEST], footer says "TEST SEND — preview only", [Name] → "there"
- Send runs in background — HTTP responds immediately with subscriber count
- Campaign status: draft → sending → sent (or failed)
- Progress tracked: sent_count updated during send via onProgress callback

---

## AWS SES — TRACKING PIXEL INVESTIGATION (Session 5)

**Problem:** AWS SDK v3 middleware attaches account-level default configuration set (`my-first-configuration-set`) to every send, causing AWS to inject `awstrack.me` tracking pixel.

**Root cause confirmed:** Sendy uses raw HTTP POST to SES API (class.amazonses.php), bypassing SDK entirely. No SDK = no middleware = no config set attached = no pixel.

**Solution implemented:** ses.js now makes raw HTTPS POST directly to `email.eu-north-1.amazonaws.com`, manually signing with AWS Signature V4. SDK only used for read-only queries.

**Do NOT change AWS console settings** — `my-first-configuration-set` is Sendy's config set. Sendy is still running on the same account. Leave all AWS settings as-is.

**Signature V4 implementation notes:**
- Parameters MUST be sorted alphabetically before URLEncoding (ksort equivalent)
- amzDate format: `new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')` → 16 chars `YYYYMMDDTHHmmssZ`
- Do NOT include Content-Length in signed headers
- Signed headers: `content-type;host;x-amz-date`
- Service name for SES: `email` (not `ses`)

---

## WHAT TO BUILD NEXT (priority order)

### 1. Confirm pixel fix works
Send a test email and check raw source — should have NO `awstrack.me` image tag.

### 2. Own-domain tracking (like Sendy)
**Open tracking:**
- Inject `<img src="https://studio.thegreenagents.com/api/email/track/open/{campaignId}/{subscriberId}" style="width:1px;height:1px;">` at end of each HTML email
- Endpoint serves real 1×1 transparent GIF, records open in email_sends.opened_at, increments email_campaigns.open_count
- Hosted on our domain → Outlook does not flag it

**Click tracking:**
- Rewrite all `<a href="...">` links in email body to `/api/email/track/click/{campaignId}/{subscriberId}/{linkHash}`
- Endpoint records click in email_link_clicks, redirects to real URL
- Increments email_campaigns.click_count

**Bounce + complaint tracking (SNS webhooks):**
- Create SNS topic in AWS → attach to SES sending identity via SetIdentityNotificationTopic
- Add public POST `/api/email/sns` endpoint
- Verify SNS subscription origin (must end in amazonaws.com) before confirming
- Handle Bounce notifications → mark subscriber bounced, increment bounce_count
- Handle Complaint notifications → mark subscriber spam, increment spam_count
- Mirrors Sendy's bounces.php + complaints.php

### 3. Transfer clickers to new list
- One-click from campaign report link activity table
- Creates new list from all subscribers who clicked a specific link
- Ready for targeted follow-up campaigns

### 4. Email inbox triage (Google Workspace)
- Connect Google Workspace mailboxes
- See all replies across all client mailboxes in one view
- One-click unsubscribe a reply sender
- Needs Gmail API + Google OAuth

### 5. List quality checker
- ZeroBounce or NeverBounce API integration
- Verify lists before sending to protect domain reputation

### 6. Scale LinkedIn to 96 posts
- `POSTS_PER_CAMPAIGN` in openai.js currently = 12 (testing)
- Production = 96, needs batching: 8 calls × 12 posts each

### 7. LinkedIn scheduling
- Posts go as drafts currently
- `queue_post` auto-assigns next slot — test if it works now

---

## LINKEDIN POST GENERATION

Model: `claude-sonnet-4-5` via Anthropic SDK with web_search tool + prompt caching.

### Key prompt rules
- Story-first structure: every post opens with scene/person/situation, insight lands at end
- Anti-duplication gate: 12 mandatory content angles, no two posts share angle or CTA
- Batch uniqueness check: Claude scans all posts before finalising
- Format mix (12 posts): 8-9 Text Posts, 2-3 Founder Stories, 1 Video Script
- No emojis, no decorative symbols
- Minimum 1,200 characters per text post
- Short paragraphs, blank line between every paragraph
- Banned words: delve, landscape, testament, crucial, unlock, game-changer, robust, seamless, holistic, leverage (as verb)
- RAG document is ONLY source of truth for content

---

## SUPERGROW MCP — KEY FACTS

- Transport: POST to /mcp, GET for SSE stream
- Auth: `?api_key=` query param ONLY (no headers)
- Use `create_post` only — never `queue_post`
- `create_post` field is `text` not `content`
- `score_post` disabled — times out 100% of the time on Render
- EventSource cannot send headers — SSE auth uses `?token=` query param

---

## KNOWN ISSUES / DO NOT RE-LEARN

- `OPENAI_AI_KEY` is the env var (not `OPENAI_API_KEY`) — code handles both
- `better-sqlite3` requires `npm rebuild better-sqlite3 --build-from-source` in build
- Gemini working model: `gemini-2.5-flash-image` with `@google/genai` SDK
- PDF RAG: uses pdfjs-dist extraction. Old binary uploads need re-upload
- `score_post` MCP timeouts — do NOT re-enable
- `schedule_post` MCP returns "Invalid time slot" — not used
- Stockholm (eu-north-1) SES shows padlock in AWS console — it IS enabled, padlock = opt-in region indicator only
- AWS SDK v3 attaches account-level config set to sends — use raw HTTPS for all email sends (see ses.js)
- Email section and LinkedIn section have COMPLETELY SEPARATE client lists — do not merge them
- DB migrations use CREATE TABLE IF NOT EXISTS + PRAGMA table_info checks — safe to run on every startup
- Old email tables had `client_id` NOT NULL constraints — migrations rebuild those tables cleanly
- `my-first-configuration-set` in AWS is Sendy's config set — DO NOT delete or modify it

---

## RENDER DEPLOYMENT

**Build command:** `npm install --include=dev && npm run build`
**Start command:** `npm start`
**Auto-deploys** on every push to `main`. Build takes ~3-5 minutes.

---

## CLIENTS IN THE SYSTEM

**LinkedIn (Supergrow workspaces):**
- john wicks's Workspace
- sweetbyte
- The Manson Group
- Cube6
- Tower Leasing (x2 — duplicate, one capitalised)

**Email clients (auto-populated from AWS verified domains):**
- sweetbyte.co.uk
- mail.weprintcatalogues.com
- clear-a-way.co.uk
- itcloudpros.uk
- thegreenagents.com
- mail.engineersolutions.co.uk
- syncsure.cloud
- socialecho.ai
- clearerpaths.co.uk

These are auto-created in the DB on first load. They can be renamed to friendly names (e.g. "Sweetbyte") via the Edit button — data persists permanently.
