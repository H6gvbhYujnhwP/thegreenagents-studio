# THEGREENAGENTS STUDIO — COMPLETE BLUEPRINT
**Last updated: April 2026 — Session 4 complete**
> This is the single source of truth. Read ALL of it before touching any code. Every session starts by cloning the repo and reading this file.

---

## SIDEBAR ARCHITECTURE — CRITICAL

Each sidebar nav item is a completely separate app section with its own component, routes, and DB tables. They share the sidebar and auth only. Never let changes in one section affect another.

| Nav item | Component | Purpose |
|---|---|---|
| Dashboard | `Dashboard.jsx` | Client overview + stats |
| Clients | `ClientDetail.jsx` | LinkedIn campaign pipeline |
| Email | `EmailSection.jsx` | Email campaigns via AWS SES |

The sidebar has no section labels — just a thin divider between the LinkedIn items (Dashboard, Clients) and the Email item. Labels were removed because they changed the visual weight of the sidebar.

Routing lives in `Dashboard.jsx`: `view === 'email'` renders `EmailSection`, everything else is the LinkedIn pipeline. Adding a new section = add a nav item to `Sidebar.jsx`, add a route condition in `Dashboard.jsx`, create a new component.

---

## HOW WE WORK (read this first)

- Wez communicates via short messages and screenshots
- Always clone/pull repo and read BLUEPRINT.md at the start of every session
- Always read relevant source files before editing
- Always syntax check before committing: `node --check server/file.js`
- Discuss UI changes with mockup widgets BEFORE building
- Every change committed with clear message and pushed to main immediately
- Render auto-deploys on every push to main (~3-5 min build)
- Always tell Wez which folder every file goes in, in short format: `file.js` → `server/routes/`
- Never use require() — ESM only (import/export)
- Never use localStorage in artifacts

---

## WHAT THIS APP IS

**The Green Agents Studio** is a private internal web app for THEGREENAGENTS.COM. It does two things:

**1. LinkedIn campaigns** — generates LinkedIn posts via Claude + images via Gemini, deploys as drafts to Supergrow for client approval.

**2. Email campaigns** — sends email campaigns directly via AWS SES. Full replacement for Sendy. Brands, mailing lists, subscribers, campaigns, domain health checker. No Sendy dependency.

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
| Email sending | AWS SES via `@aws-sdk/client-ses` |
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
│   ├── db.js                           SQLite schema + connection
│   ├── middleware/
│   │   └── auth.js                     Bearer token auth (requireAuth)
│   ├── routes/
│   │   ├── auth.js                     POST /login, GET /check
│   │   ├── clients.js                  Client CRUD + RAG upload + Supergrow sync
│   │   ├── campaigns.js                LinkedIn campaign pipeline + SSE + deploy
│   │   └── email.js                    Email brands/lists/subscribers/campaigns/send/domain
│   ├── services/
│   │   ├── openai.js                   Claude post generation (LinkedIn system prompt)
│   │   ├── gemini.js                   Nano Banana image generation
│   │   ├── r2.js                       Cloudflare R2 upload
│   │   ├── supergrow.js                Supergrow MCP client
│   │   └── ses.js                      AWS SES email sending service
│   └── utils/
│       └── extractText.js              PDF/text extraction for RAG
│
└── src/
    ├── main.jsx
    ├── App.jsx                         Auth check + global fetch patch
    ├── index.css
    └── components/
        ├── Dashboard.jsx               Client grid + email nav routing
        ├── Sidebar.jsx                 Nav: Dashboard, Clients, Email
        ├── ClientCard.jsx
        ├── NewClientModal.jsx
        ├── ClientDetail.jsx            Client detail + RAG + campaign history
        ├── CampaignProgress.jsx        Live SSE progress + post review grid + deploy
        └── EmailSection.jsx            Full email module (split-pane Option E layout)
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

### Email tables (added Session 4)

**email_brands**
```sql
id, client_id, name, from_name, from_email, reply_to, color, created_at
```
One brand per client. Stores the default from/reply-to settings for all campaigns.

**email_lists**
```sql
id, client_id, name, from_name, from_email, reply_to, subscriber_count, created_at
```

**email_subscribers**
```sql
id, list_id, email, name, status (subscribed|unsubscribed|bounced),
created_at, unsubscribed_at, bounced_at
UNIQUE(list_id, email)
```

**email_campaigns**
```sql
id, client_id, list_id, title, subject, from_name, from_email, reply_to,
html_body, plain_body, status (draft|scheduled|sending|sent|failed),
scheduled_at, sent_at, sent_count, open_count, click_count,
bounce_count, unsubscribe_count, created_at
```

**email_sends**
```sql
id, campaign_id, subscriber_id, status, opened_at, clicked_at, bounced_at, sent_at
```

---

## ENVIRONMENT VARIABLES (set in Render)

| Key | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API — used for LinkedIn post generation |
| `OPENAI_AI_KEY` | Legacy env var name (not OPENAI_API_KEY) — kept for compatibility |
| `GEMINI_API_KEY` | Google AI Studio — Nano Banana images |
| `SUPERGROW_MCP_URL` | Master Supergrow MCP URL with api_key param |
| `R2_ACCOUNT_ID` | Cloudflare R2 |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 |
| `R2_BUCKET_NAME` | `supergrowfortga` |
| `R2_ENDPOINT` | R2 endpoint URL |
| `R2_PUBLIC_URL` | Public R2 image base URL |
| `STUDIO_USERNAME` | Login username (default: `greenagents`) |
| `STUDIO_PASSWORD` | Login password |
| `DB_PATH` | `/var/data/studio.db` |
| `AWS_ACCESS_KEY_ID` | NEW Session 4 — tga-studio-ses IAM user |
| `AWS_SECRET_ACCESS_KEY` | NEW Session 4 — tga-studio-ses IAM user |
| `AWS_SES_REGION` | `eu-north-1` |

---

## AUTH

Stateless Bearer token. On login, server returns a token stored in `localStorage`. `App.jsx` patches `window.fetch` globally to add `Authorization: Bearer <token>` to every `/api/` request. No cookies, no sessions.

`server/middleware/auth.js` exports `requireAuth` — used on all protected routes.
`/api/email/unsubscribe` is public (no auth) — handles unsubscribe link clicks from emails.

---

## EMAIL MODULE (Session 4 — full build)

### Architecture
AWS SES sends all emails. No Sendy. `server/services/ses.js` wraps the SES SDK.

### UI layout — Option E split-pane
Left panel: searchable brand list (240px, scrollable, scales to hundreds of clients).
Right panel: selected brand's Campaigns / Lists / Domains / Settings tabs.
Brand stores from_name, from_email, reply_to — inherited by lists and campaigns.

### API routes (`/api/email/`)
```
GET    /brands                    List all brands with stats
POST   /brands                    Create brand
PUT    /brands/:id                Edit brand
DELETE /brands/:id                Delete brand

GET    /lists                     All lists (filter by ?client_id=)
POST   /lists                     Create list
DELETE /lists/:id                 Delete list + subscribers

GET    /lists/:id/subscribers     Get subscribers (filter by ?status=)
POST   /lists/:id/subscribers     Add single subscriber
POST   /lists/:id/import          Bulk CSV import
DELETE /lists/:listId/subscribers/:subId   Unsubscribe

GET    /campaigns                 All campaigns (filter by ?client_id=)
POST   /campaigns                 Create campaign
PUT    /campaigns/:id             Edit campaign
DELETE /campaigns/:id             Delete campaign
POST   /campaigns/:id/send        Send campaign (background, responds immediately)

GET    /unsubscribe               PUBLIC — handles unsubscribe link clicks
GET    /domain-health/:domain     DNS checks: SPF, DKIM, DMARC, MX
GET    /verified-domains          List of SES-verified domains
```

### SES sending
- Batches at 10 emails per batch, 800ms delay between batches (~12/sec, under 14/sec limit)
- Auto-injects unsubscribe link into every email (HTML + plain text)
- Unsubscribe link format: `/api/email/unsubscribe?sid=SUBSCRIBER_ID&cid=CAMPAIGN_ID`
- Send runs in background — HTTP responds immediately with subscriber count

### Verified SES domains (eu-north-1)
thegreenagents.com, sweetbyte.co.uk, clear-a-way.co.uk, itcloudpros.uk,
mail.engineersolutions.co.uk, syncsure.cloud, socialecho.ai, clearerpaths.co.uk,
mail.weprintcatalogues.com

### AWS IAM
User: `tga-studio-ses` | Policy: `AmazonSESFullAccess` | Account: 262023811768
Root account keys should be deactivated (security recommendation in IAM dashboard).

---

## LINKEDIN POST GENERATION (Session 4 updates)

Model: `claude-sonnet-4-5` via Anthropic SDK with web_search tool + prompt caching.

### Key prompt rules added Session 4

**Story-first structure (mandatory)**
Every post opens with a scene, person, or specific situation. The insight lands at the END of the story, not the top. No opening with a claim or thesis.

**Anti-duplication gate**
12 mandatory content angles (myth-busting, how-it-works, objection-handling, stat/data, client story, contrarian take, behind-the-scenes, buyer pain, comparison, trend, FAQ, stakes). No two posts may share the same angle or CTA.

**Batch uniqueness check**
Claude scans all posts before finalising — each must teach a genuinely different lesson.

**Format mix (12 posts)**
- 8-9 Text Posts
- 2-3 Founder Stories (first person, specific, human)
- 1 Video Script
- No carousels, no documents

**Other rules**
- No emojis, no decorative symbols
- Minimum 1,200 characters per text post
- Short paragraphs, blank line between every paragraph
- Banned words: delve, landscape, testament, crucial, unlock, game-changer, robust, seamless, holistic, leverage (as verb)
- RAG document is the ONLY source of truth for content

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

---

## WHAT'S BEEN BUILT (session history)

### Sessions 1-3
- Full auth system (Bearer token)
- LinkedIn campaign pipeline with SSE live progress
- Per-card post/image regeneration (Edit, Rewrite, New image)
- Campaign history with clickable cards and delete
- Claude Sonnet post generation with web search + prompt caching
- Nano Banana image generation (Gemini)
- Cancel campaign button
- Image yes/no modal on campaign start
- Full image display (objectFit: contain)

### Session 4
- Story-first post structure enforced in prompt
- Anti-duplication gate + 12 content angle rotation
- Batch uniqueness check added to quality gate
- Full email module built: `server/services/ses.js`, `server/routes/email.js`
- Email DB tables: email_brands, email_lists, email_subscribers, email_campaigns, email_sends
- EmailSection.jsx — Option E split-pane UI (brands left, content right)
- Sidebar updated with Email nav item under Outreach section
- Dashboard routes `view==='email'` to EmailSection
- AWS SES IAM user `tga-studio-ses` created with AmazonSESFullAccess
- Env vars added to Render: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SES_REGION

---

## WHAT TO BUILD NEXT (priority order)

### 1. Email module — test and fix
First real use: create a brand → create a list → import CSV → create campaign → send.
Likely issues to watch for:
- `@aws-sdk/client-ses` install on Render (check build logs)
- SES send errors (check IAM permissions, verified domain used as from_email)
- CSV import edge cases

### 2. Email — inbox triage (Google Workspace)
Connect Google Workspace mailboxes so replies to email outreach can be triaged:
- See all replies across all client mailboxes in one view
- One-click unsubscribe a reply sender from their Sendy/SES list
- Flag reply as interested lead
- Needs: Gmail API + Google OAuth app setup
- Phase 2 — do email send first

### 3. Email — open/click tracking
- Open tracking: inject 1px transparent image pixel per send
- Click tracking: wrap all links in redirect through `/api/email/track/click`
- Update `open_count` and `click_count` on email_campaigns when fired

### 4. Email — list quality checker
- Integrate ZeroBounce or NeverBounce API to verify lists before sending
- Prevents bounces that damage domain reputation
- Wez to confirm which service they have/want

### 5. Scale LinkedIn to 96 posts
- `POSTS_PER_CAMPAIGN` in openai.js currently = 12 (testing)
- Production = 96, needs batching: 8 calls × 12 posts each
- Gemini free tier: 500 images/day at 10 RPM — 96 images ≈ 10 min

### 6. LinkedIn scheduling
- Posts go as drafts currently, manually scheduled in Supergrow
- `queue_post` auto-assigns next available slot — test if it works now

---

## RENDER DEPLOYMENT

**Build command:** `npm install --include=dev && npm run build`
**Start command:** `npm start`
**Auto-deploys** on every push to `main`. Build takes ~3-5 minutes.

---

## CLIENTS IN THE SYSTEM

LinkedIn (Supergrow workspaces):
- john wicks's Workspace (primary test client)
- sweetbyte
- The Manson Group
- Cube6
- Tower Leasing

Email brands to create (match to clients above after session 4 deploy):
- Create one brand per client in the Email section
- Use verified SES domain matching each client

