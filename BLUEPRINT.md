# THEGREENAGENTS STUDIO — COMPLETE BLUEPRINT
**Last updated: April 2026**
> This document is the single source of truth for any new session working on this codebase. Read this entirely before touching any code.

---

## WHAT THIS APP IS

**The Green Agents Studio** is a private internal web application for the agency THEGREENAGENTS.COM. It automates the end-to-end production and deployment of LinkedIn content campaigns for B2B clients.

The app replaces a manual workflow previously run through Manus AI. It takes a client RAG (brief document), generates 96 LinkedIn posts using the Claude API, generates a matching image for each post using Google's Gemini API (Nano Banana), uploads images to Cloudflare R2, and deploys every post directly into Supergrow via MCP — all from a single dashboard.

**The operator's journey for a repeat client is:**
1. Open the client on the dashboard
2. Upload a new or confirm existing RAG document
3. Hit **Run Campaign**
4. Watch live progress in the browser
5. Download the output files when complete
6. Posts are already live in Supergrow, queued for LinkedIn

---

## WHERE EVERYTHING LIVES

| Item | Location |
|---|---|
| GitHub repo | `https://github.com/H6gvbhYujnhwP/thegreenagents-studio` |
| Live app URL | `https://studio.thegreenagents.com` |
| Render service | `thegreenagents-studio` (Starter, $7/month) |
| Render service ID | `srv-d7f5khfaqgkc73a260og` |
| Render disk | `/var/data` — 1GB persistent disk for SQLite |
| SQLite database | `/var/data/studio.db` (set via `DB_PATH` env var) |
| Main website | `thegreenagents.com` — separate static site on Render, do NOT touch |

---

## TECH STACK

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Node.js 22 (ESM — `"type": "module"`) | Server runtime |
| Web framework | Express.js | API + static file serving |
| Database | SQLite via `better-sqlite3` | Client and campaign storage |
| Frontend | React 18 + Vite | UI |
| Auth | `express-session` + password check | Single shared password login |
| AI — posts | Anthropic Claude API (`claude-opus-4-5`) | 11-step post generation workflow |
| AI — images | Google Gemini API (`gemini-2.0-flash-exp`) | Nano Banana image generation |
| Image storage | Cloudflare R2 via `@aws-sdk/client-s3` | Public image hosting for Supergrow |
| Scheduling | Supergrow MCP via `@modelcontextprotocol/sdk` | LinkedIn post queuing |
| File uploads | `multer` (memory storage) | RAG document upload |
| Progress | Server-Sent Events (SSE) | Live campaign progress in browser |
| Hosting | Render Starter ($7/month) | Single Node.js web service |

---

## FILE STRUCTURE

```
thegreenagents-studio/
├── index.html                          Vite HTML entry point
├── package.json                        ESM, scripts: build/start
├── vite.config.js                      Vite config, proxies /api to :3001
├── render.yaml                         Render deploy config
├── .npmrc                              legacy-peer-deps=true
├── .gitignore
│
├── server/
│   ├── index.js                        Express app, serves dist/, port 3001
│   ├── db.js                           SQLite setup, creates tables on boot
│   ├── middleware/
│   │   └── auth.js                     requireAuth middleware
│   ├── routes/
│   │   ├── auth.js                     POST /login, /logout, GET /check
│   │   ├── clients.js                  CRUD for clients + RAG upload
│   │   └── campaigns.js                Campaign start, SSE progress, file output
│   └── services/
│       ├── claude.js                   Claude API — generates 96 posts as JSON
│       ├── gemini.js                   Gemini API — generates images (base64)
│       ├── r2.js                       Cloudflare R2 — uploads image, returns public URL
│       └── supergrow.js                Supergrow MCP — queue_post and create_post
│
└── src/
    ├── main.jsx                        React entry
    ├── App.jsx                         Auth check → Login or Dashboard
    ├── index.css                       Global reset
    └── components/
        ├── Login.jsx                   Password login page
        ├── Dashboard.jsx               Client grid + stats bar
        ├── Sidebar.jsx                 Green sidebar navigation
        ├── ClientCard.jsx              Card per client with status + progress bar
        ├── NewClientModal.jsx          Create/edit client form
        ├── ClientDetail.jsx            Client detail, RAG upload, run campaign, history
        └── CampaignProgress.jsx        Live SSE progress tracker + file downloads
```

---

## DATABASE SCHEMA

**clients table**
```sql
id TEXT PRIMARY KEY
name TEXT                         -- e.g. "The Manson Group"
brand TEXT                        -- e.g. "Manson Group"
website TEXT
supergrow_workspace_name TEXT
supergrow_workspace_id TEXT       -- UUID from Supergrow workspace URL
supergrow_api_key TEXT            -- Per-client Supergrow API key
timezone TEXT                     -- e.g. "Europe/London"
cadence TEXT                      -- e.g. "Daily", "3x week"
posting_identity TEXT             -- "personal" or "company"
approval_mode TEXT                -- "auto" (queue_post) or "draft" (create_post)
rag_filename TEXT                 -- Original filename of uploaded RAG doc
rag_content TEXT                  -- Full text content of RAG doc (stored in DB)
created_at TEXT
updated_at TEXT
```

**campaigns table**
```sql
id TEXT PRIMARY KEY
client_id TEXT                    -- FK to clients
status TEXT                       -- pending | running | completed | failed
stage TEXT                        -- generating_posts | generating_images | deploying | done | error
progress INTEGER                  -- 0-100
total_posts INTEGER               -- always 96
posts_generated INTEGER
images_generated INTEGER
posts_deployed INTEGER
posts_json TEXT                   -- JSON array of all posts with image_urls
error_log TEXT
files_json TEXT                   -- JSON object of all 9 output files (content as strings)
created_at TEXT
completed_at TEXT
```

---

## ENVIRONMENT VARIABLES (set in Render)

| Key | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` | Claude API key |
| `GEMINI_API_KEY` | `AIza...` | Google AI Studio key — must start with AIza, NOT sk-ant |
| `SUPERGROW_MCP_URL` | `https://mcp.supergrow.ai/mcp?api_key=...` | Full URL including api_key param |
| `R2_ACCOUNT_ID` | `9c5edb3cc8262aa7b43de4b42b970b99` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | `67815f3fd80704cfab3139dbc37c7bb1` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | `350763615e7ed3...` | R2 secret key |
| `R2_BUCKET_NAME` | `supergrowfortga` | R2 bucket name |
| `R2_ENDPOINT` | `https://9c5edb3cc8262aa7b43de4b42b970b99.r2.cloudflarestorage.com` | R2 S3-compatible endpoint |
| `R2_PUBLIC_URL` | `https://pub-142245a59cdd4552a84f0f2d3e8ac94e.r2.dev` | Public URL base for uploaded images |
| `STUDIO_PASSWORD` | `86sdg88gdsd6&DF!` | Single shared login password |
| `SESSION_SECRET` | `greenagents_studio_2026_secret_key` | Express session secret |
| `NODE_ENV` | `production` | |
| `DB_PATH` | `/var/data/studio.db` | Points to persistent disk |

---

## RENDER DEPLOYMENT

**Build command:**
```
npm install --include=dev && npm run build
```
> Must use `--include=dev` because vite is in devDependencies

**Start command:**
```
npm start
```

**Build process:**
1. `npm install --include=dev` — installs all packages including vite + react
2. `npm rebuild better-sqlite3 --build-from-source` — compiles native SQLite module for Linux
3. `vite build` — builds React app into `/dist`
4. `npm start` → `node server/index.js` — starts Express, serves `/dist`

**Disk:** 1GB persistent disk mounted at `/var/data`. The SQLite file lives at `/var/data/studio.db`. Without this disk, the database resets on every redeploy.

**DNS:** `studio.thegreenagents.com` → CNAME → `thegreenagents-studio.onrender.com` (set in Namecheap)

---

## HOW SUPERGROW WORKS

**What Supergrow is:**
Supergrow is a LinkedIn content scheduling platform. Each client has their own Supergrow **workspace** which is linked to a LinkedIn profile (personal or company page). Posts queued into a workspace automatically publish to LinkedIn on Supergrow's optimal schedule.

**MCP (Model Context Protocol):**
Supergrow exposes its functionality as MCP tools — the same protocol used by Claude's connector system. The MCP URL format is:
```
https://mcp.supergrow.ai/mcp?api_key=YOUR_API_KEY
```

The app connects to this URL using `@modelcontextprotocol/sdk` (StreamableHTTPClientTransport) and calls tools directly from Node.js without needing a browser.

**The two tools used:**
| Tool | When used | What it does |
|---|---|---|
| `queue_post` | `approval_mode = "auto"` | Adds post to Supergrow's queue, auto-assigns next available slot |
| `create_post` | `approval_mode = "draft"` | Creates post as draft, operator reviews before publishing |

**Payload sent per post:**
```json
{
  "workspace_id": "cd842050-02ae-41a6-aa00-6b02473fb784",
  "content": "Full LinkedIn post text here...",
  "image_urls": ["https://pub-xxx.r2.dev/images/client-id/post-1.jpg"]
}
```

**How LinkedIn is connected:**
- Each Supergrow workspace is authenticated to a LinkedIn account
- The workspace owner connects their LinkedIn profile in Supergrow's settings
- The app never touches LinkedIn directly — Supergrow handles all LinkedIn auth and publishing
- Default is personal profile; company page publishing requires the page to be explicitly connected in Supergrow and `posting_identity = "company"` set on the client

**Per-client API keys:**
Each client has their own Supergrow API key stored in the database. This means the app can handle multiple clients with different Supergrow accounts simultaneously. The key is found in Supergrow → Settings → MCP.

---

## HOW THE CAMPAIGN PIPELINE WORKS

**Stage 1 — Post generation (Claude API, ~3-5 min)**
- The full RAG document text is sent to `claude-opus-4-5` with the THEGREENAGENTS 11-step workflow prompt
- Claude returns a JSON object containing: client_profile, research_notes, topic_schedule, and 96 posts
- Each post has: id, topic, angle, buyer_segment, cta_type, linkedin_post_text, image_prompt
- The prompt instructs Claude to write for real buyers, optimised for enquiries, in the client's voice

**Stage 2 — Image generation (Gemini API, ~12-15 min)**
- For each of the 96 posts, the `image_prompt` field is passed to Gemini (`gemini-2.0-flash-exp`)
- Gemini returns a base64-encoded image
- Image is uploaded to Cloudflare R2 at path: `images/{clientId}/{postId}-{uuid}.jpg`
- Public URL is formed as: `{R2_PUBLIC_URL}/images/{clientId}/{postId}-{uuid}.jpg`
- Rate limit delay of 7 seconds between calls (free tier = 10 req/min)
- Failed images are logged but do not stop the campaign

**Stage 3 — Deployment (Supergrow MCP, ~5 min)**
- For each post, `queue_post` (or `create_post`) is called via MCP
- Passes: workspace_id (from client record), content (post text), image_urls (R2 URL array)
- 500ms delay between calls to avoid overwhelming the MCP endpoint
- Failed posts are retried once, then logged in execution_results.json

**Stage 4 — File packaging**
Nine files are generated and stored as strings in `campaigns.files_json`:
1. `client_profile.md` — normalised client operating profile
2. `research_notes.md` — market and platform context
3. `topic_schedule.csv` — content matrix by week/theme
4. `generated_posts.md` — human-readable post copy
5. `generated_posts.json` — machine-readable posts with image_urls
6. `generated_posts_for_scheduling.csv` — flat CSV for manual scheduling
7. `schedule_tracker.md` — deployment status and failures
8. `workflow_log.md` — run summary with counts
9. `execution_results.json` — full Supergrow API response log

**Progress tracking:**
- SSE (Server-Sent Events) stream at `/api/campaigns/progress/:id`
- Frontend connects via `EventSource` and receives real-time log messages and progress %
- In-memory `Map` stores SSE client connections per campaign
- Campaign status stored in SQLite, survives page refresh

---

## HOW IMAGE HOSTING WORKS

1. Gemini returns image as base64 string with mimeType (e.g. `image/jpeg`)
2. Node.js converts base64 to Buffer
3. Buffer uploaded to R2 bucket `supergrowfortga` via S3-compatible API
4. Key format: `images/{clientId}/{postId}-{uuid}.jpg`
5. Public URL: `https://pub-142245a59cdd4552a84f0f2d3e8ac94e.r2.dev/images/...`
6. This URL is passed directly to Supergrow in `image_urls[]`
7. Supergrow fetches the image from R2 when publishing to LinkedIn
8. R2 Public Development URL must remain **enabled** in Cloudflare dashboard

> ⚠️ If images stop working, check R2 bucket → Settings → Public Development URL is still enabled

---

## KNOWN ISSUES AND NOTES

**GEMINI_API_KEY must start with `AIza`**
The Gemini key from Google AI Studio starts with `AIza`. If it starts with `sk-ant` it is an Anthropic key entered in the wrong field. This was corrected during setup.

**better-sqlite3 requires native compilation**
The build command must be `npm install --include=dev && npm run build` on Render. The `npm rebuild better-sqlite3 --build-from-source` step inside the build script compiles the native C++ module for the Linux environment. Do not remove this step.

**ESM throughout**
The entire codebase uses ES modules (`"type": "module"` in package.json). Use `import/export` everywhere. Do not use `require()`. Use `import.meta.dirname` instead of `__dirname` where needed (or `fileURLToPath(import.meta.url)`).

**RAG files stored as text in SQLite**
RAG documents are stored as UTF-8 text in the `rag_content` column. PDFs are read as text (may lose formatting). For best results, clients should provide RAG documents as `.md` or `.txt` files. The 20MB multer limit handles most documents.

**Session cookie requires HTTPS in production**
`cookie.secure = true` when `NODE_ENV=production`. Render provides HTTPS automatically. Do not set `NODE_ENV=production` in local dev or sessions will break.

**Free tier Gemini rate limits**
Free tier = 10 requests/minute. The 7-second delay between image generation calls keeps within this limit. If rate limit errors appear, increase the delay in `server/services/gemini.js`. Upgrading to paid Gemini tier allows 60 req/min (reduce delay to 1 second).

**Supergrow MCP connection per post**
The current implementation opens and closes an MCP connection for each post. This is safe but slow. A future optimisation is to open one connection and call all 96 tools in sequence before closing.

---

## API ROUTES REFERENCE

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | No | Login with password |
| POST | `/api/auth/logout` | No | Destroy session |
| GET | `/api/auth/check` | No | Check session status |
| GET | `/api/clients` | Yes | List all clients with stats |
| GET | `/api/clients/:id` | Yes | Get client + campaign history |
| POST | `/api/clients` | Yes | Create client (multipart with RAG) |
| PUT | `/api/clients/:id` | Yes | Update client (multipart with RAG) |
| DELETE | `/api/clients/:id` | Yes | Delete client + all campaigns |
| POST | `/api/campaigns/start/:clientId` | Yes | Start campaign (async, returns campaignId) |
| GET | `/api/campaigns/progress/:id` | Yes | SSE stream for live progress |
| GET | `/api/campaigns/client/:clientId` | Yes | List campaigns for a client |
| GET | `/api/campaigns/:id` | Yes | Get single campaign |

---

## ADDING A NEW CLIENT — CHECKLIST

Before a new client can run a campaign, the operator must have:

- [ ] Client RAG document (`.md`, `.txt`, or `.pdf`)
- [ ] Supergrow workspace created for the client
- [ ] Client's LinkedIn account connected to their Supergrow workspace
- [ ] Supergrow workspace ID (visible in the workspace URL in Supergrow)
- [ ] Supergrow API key for that workspace (Settings → MCP in Supergrow)
- [ ] Confirmed whether posting to personal profile or company page
- [ ] Agreed posting cadence and timezone

---

## FUTURE IMPROVEMENTS (not yet built)

- [ ] Post preview UI — view all 96 posts + images before deploying
- [ ] Individual post editing before deployment
- [ ] Approval gate — require manual sign-off before Supergrow deployment
- [ ] Persistent MCP connection (single connection for all 96 posts)
- [ ] PDF text extraction (currently stored raw, markdown preferred)
- [ ] Campaign scheduling by specific date/time (currently queue_post auto-assigns slots)
- [ ] Multi-user login with named accounts
- [ ] Email notification on campaign completion
- [ ] Re-run single failed posts from campaign history

---

## QUICK REFERENCE — UPDATING THE APP

1. Make changes to files in the repo
2. Commit and push to `main` branch on GitHub
3. Render auto-deploys on push (or use Manual Deploy in Render dashboard)
4. Build takes ~3-5 minutes
5. Check Render logs if build fails

**To update build command:**
Render → thegreenagents-studio → Settings → Build & Deploy → Build Command

**To add/change environment variables:**
Render → thegreenagents-studio → Environment

**To check live logs:**
Render → thegreenagents-studio → Logs
---
name: supergrow-mcp
description: >
  Use this skill whenever a user wants to do anything with Supergrow — creating LinkedIn posts,
  scheduling content, checking their calendar, managing drafts, scoring posts, Content DNA,
  analytics, knowledge base, or managing multiple workspaces as an admin.
  Triggers: "create a post", "draft a post", "schedule content", "what's on my calendar",
  "score this post", "check my drafts", "publish to LinkedIn", "content DNA", "writing style",
  "turn this into a post", "queue this", "my Supergrow workspace", "what's performing",
  "weekly report", "analytics", "knowledge base", "save this to my brain", "all my clients",
  "all workspaces", "aggregated report", "pipeline health", or any LinkedIn content request.
  This skill ensures Claude follows the correct tool call sequence and never guesses the order.
---

# Supergrow MCP Skill

Supergrow is a LinkedIn content creation and scheduling platform for individuals, ghostwriters,
and enterprise teams.

---

## Golden Rules (always apply)

1. **No topic? Go to Workflow 0.** If the user says something vague like "create me a post", "write something", or "help me with LinkedIn" — don't guess. Run Workflow 0 to suggest ideas based on their Content DNA, recent performance, and knowledge base. Let them pick a topic first.
2. **Get Content DNA first.** Call `get_content_dna` before writing or scoring any post.
3. **Fetch weekly reports before creating content.** `get_weekly_reports` tells you what's working — use it to shape format, hook, and angle.
4. **Search the KB before writing.** `kb_search(topic)` pulls the user's real stories, stats, and frameworks. This is what makes posts authentic.
5. **Generate questions before writing.** Use `questions_from_topic` or `questions_from_text` — always. Prefill answers from context; ask the user only for what you don't know. Present all questions at once.
6. **Don't write until you have answers.** Questions → answers → write. Non-negotiable.
7. **workspace_id is always required.** If missing, call `list_workspaces` — never ask the user to find it.
8. **Respect workspace language.** `list_workspaces` returns a `language` field (e.g. "English", "Hindi"). Always write posts in that language unless the user asks otherwise.
9. **Always share both links after saving a post.** `create_public_link` (LinkedIn preview, no signup needed) + `app_url` from the response (opens post in Supergrow editor).

---

## Quick Decision Tree

```
No idea what to post         → Workflow 0
Write a post from a topic    → Workflow 1
Turn a URL/video into a post → Workflow 2
Manage existing posts        → Workflow 3
Content calendar             → Workflow 4
Content DNA                  → Workflow 5
Score a post                 → Workflow 6
Analytics & reports          → Workflow 7
Knowledge base               → Workflow 8
Auto-plug comments           → Workflow 9
Company page publishing      → Company Page Publishing
Admin / multi-workspace      → Admin Workflows A–D
```

---

## Workflow 0: Suggest Ideas (User Has No Topic)

```
1. get_content_dna
2. get_weekly_reports(limit=4)
3. list_posts(status=published)     → avoid repetition
4. list_posts(status=draft)         → avoid duplication
5. kb_list                          → KB items not yet posted = strong idea signals
6. Suggest 5–7 ideas → user picks one → go to Workflow 1
```

**Idea format** — vary formats, each needs a specific *angle* not just a topic:
```
💡 From your expertise
1. [Angle] — Format: Story

📈 Doubling down on what's performing
2. [Angle tied to recent top post] — Format: Question hook

🧠 From your knowledge base
3. [Angle from an unused KB item] — Format: List

🌱 Filling a gap
4. [Something not yet covered] — Format: Personal story
```
"Leadership" is a topic. "Why I stopped giving feedback in 1:1s" is an angle.

---

## Workflow 1: Create a Post from a Topic

```
1. get_content_dna
2. get_weekly_reports
3. kb_search(topic)
4. Brief insight to user: "Your last top posts were [X format]. I'll keep that in mind."
5. questions_from_topic(topic)
6. Prefill answers from KB + context; ask user only for unknowns (all at once)
7. Write post using answers + KB context + Content DNA + performance insights
8. score_post → refine if score < 7
9. create_post
10. create_public_link + share app_url
11. "Here's your preview: [link]. Open in Supergrow: [app_url]. Happy with it?"
12. If changes needed → update_post (preview link auto-updates)
13. Ask: queue_post / schedule_post / leave as draft
```

---

## Workflow 2: Turn a URL or Video into a Post

```
Step 1 — Extract:
  YouTube URL      → extract_youtube       (better transcript accuracy)
  Any other URL    → extract_content       (articles, PDFs, audio — limit: 10/day)

Step 2 — Continue:
2. get_content_dna
3. get_weekly_reports
4. kb_search(topic/theme from content)
5. questions_from_text(extracted content)
6. Prefill from extracted content + KB; ask user for their personal take (all at once)
7. Write post — the article gives facts; the answers give the authentic POV
8. score_post → refine if score < 7
9. create_post
10. create_public_link + share app_url
11. Ask: queue / schedule / leave as draft
```

---

## Workflow 3: Manage Existing Posts

```
Browse:
  get_kanban_board                          → all posts grouped by status
  get_kanban_column(status=...)             → single column (draft/under_review/approved/needs_changes/scheduled/published)
  list_posts(status=...)                    → flat filtered list

View:     get_post(post_id)                 → includes app_url
Edit:     get_post → update_post → score_post (recommended) → create_public_link
Publish:  publish_post                      → async, takes a few seconds
Preview:  create_public_link               → no-signup LinkedIn preview
Remove:   delete_public_link               → removes public access
Delete:   unschedule_post first if scheduled → then delete_post
```

---

## Workflow 4: Content Calendar

```
get_weekly_calendar(offset=0/1/-1)         → current / next / last week
get_monthly_calendar(offset=0)             → current month

Reschedule: unschedule_post → schedule_post or queue_post
```

**schedule_post fields:** year, month, day_of_the_month, day_of_week (0=Sun), hour (0-23), minute
**Timezone:** Pass `hour` in the workspace's local time — the API uses the workspace timezone, NOT UTC. Never convert to UTC. E.g. for 2 PM IST, pass `hour=14`.
Default recommendation: **Tue–Thu, 8–10am**. For hands-off: use `queue_post` instead.

---

## Workflow 5: Content DNA

```
get_content_dna                            → profile, tone, content patterns, audience
regenerate_content_dna                     → if empty or outdated (warn: takes a moment, needs LinkedIn connected)
```

---

## Workflow 6: Score a Post

```
1. get_content_dna
2. score_post(text)
3. Explain dimensions: Hook Quality · Clarity · Readability · Completeness · CTA · Originality · Grammar · Content DNA Alignment
4. Offer to improve it
```

---

## Workflow 7: Analytics & Performance

```
get_weekly_reports(limit=4)                → structured weekly summaries
get_metrics(metric=IMPRESSION/MEMBERS_REACHED/REACTION/COMMENT/RESHARE, period=last_30_days)
get_followers(period=last_30_days)         → follower count + growth trend
```

**Present as:** what's working → what's not → trend direction → follower insight → one recommendation.

Follower insight: flat growth + high impressions = reaching non-followers but not converting → suggest stronger CTA or profile-driven posts.

---

## Workflow 8: Knowledge Base

```
Add:     kb_ingest(content, title)         → returns status: processing (indexed async)
Browse:  kb_list(status=ready)             → filter by source_type: text/website/pdf/document/youtube/voice
View:    kb_get(item_id)
Search:  kb_search(query)                  → semantic search, returns chunks + insights (stats, quotes, milestones)
Delete:  kb_delete(item_id)               → permanent — confirm with user first
```

Good candidates to ingest: stories, frameworks, stats, past posts, meeting notes, voice transcripts, idea dumps.

**Proactively suggest ingesting** when user shares a compelling insight in chat:
> "That's a great story — want me to save it to your knowledge base for future posts?"

---

## Admin Workflows (Multi-Workspace)

Always start with `list_workspaces` to get all workspace IDs and names.

### A: Aggregated Performance Report
*"How are all my clients doing?"*
```
For each workspace (parallel): get_weekly_reports + get_metrics (all 5) + get_followers
```
Rank into tiers: 🏆 Top performer / ✅ On track / ⚠️ Needs attention / 🚨 Inactive (no posts in 7 days)
Surface: best performing format across accounts, most/least active workspace, recommended actions per workspace.

### B: Pipeline Health Check
*"Which clients have content ready? Who needs new drafts?"*
```
For each workspace: get_kanban_column for draft / under_review / approved / scheduled
```
Present as a table. Flag: 🚨 Empty pipeline / ⚠️ Backlog (drafts not moving) / ⚠️ Nothing scheduled.
Suggested cadence: run Workflow A + B together every Monday morning.

### C: Create Content for a Client
Same as Workflow 1/2, but:
```
list_workspaces → confirm target workspace with admin → proceed
```
**Always confirm the workspace first.** Wrong-account posts are the #1 agency risk.

### D: Follower Growth Comparison
*"Which accounts are growing fastest?"*
```
For each workspace: get_followers(last_30_days) + get_followers(previous_month)
```
Rank by MoM growth rate with absolute gain and trend indicator.

---

## Workflow 9: Auto-Plug Comments

Auto-plug comments are automatically published under a post after it goes live, with a configurable delay.
Cannot add comments to already-published posts.

```
Add:     create_auto_plug_comments(post_id, comments=[{text, post_after_time_unit, post_after_time_unit_count}])
         time units: "minutes", "hours", "days"
         Example: {text: "Link in bio!", post_after_time_unit: "minutes", post_after_time_unit_count: 5}
List:    list_auto_plug_comments(post_id)
Delete:  delete_auto_plug_comment(post_id, comment_id)  → cannot delete on published posts
```

**Suggest proactively** after creating or scheduling a post:
> "Want to add an auto-plug comment? E.g. a link, CTA, or follow-up question that posts automatically after your post goes live."

---

## Company Page Publishing

Posts can be published from a personal profile (default) or a LinkedIn company page.

```
get_company_pages                             → list connected company pages
create_post(..., linked_in_company_page_id)   → publish from company page
queue_post(..., linked_in_company_page_id)    → queue from company page
```

**When to use:** If the user says "post from my company page" or "publish as [Company Name]", call `get_company_pages` first to get the page ID.

---

## Media Attachments (optional)

| Type | Fields |
|------|--------|
| Images | `image_urls` (array) |
| Video | `video_url` + optional `video_title`, `video_thumbnail_url` |
| Carousel | `file_url` (PDF) + `carousel_title` |

Only attach if user explicitly provides a file or URL.


