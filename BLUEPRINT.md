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
