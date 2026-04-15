# THEGREENAGENTS STUDIO — COMPLETE BLUEPRINT
**Last updated: April 2026 — Session 1 complete**
> This document is the single source of truth for any new session working on this codebase. Read this entirely before touching any code.

---

## WHAT THIS APP IS

**The Green Agents Studio** is a private internal web application for the agency THEGREENAGENTS.COM. It automates the end-to-end production and deployment of LinkedIn content campaigns for B2B clients.

The app generates LinkedIn posts using GPT-4o (with the LinkedIn New Client Master system prompt), generates matching images using Google's Gemini Nano Banana API, uploads images to Cloudflare R2, and deploys every post as a **draft** into Supergrow via MCP — all from a single dashboard.

**The operator's journey for a client is:**
1. Open the client on the dashboard
2. Confirm RAG document is uploaded (PDF, MD, or TXT)
3. Hit **Run Campaign**
4. Watch live progress — posts generated, images created
5. **Review all 12 posts with images** before anything goes to Supergrow
6. Click **Send Drafts to Supergrow** — posts land as drafts in Supergrow Kanban
7. Client approves posts by dragging Draft → Approved in Supergrow Kanban
8. Agency schedules approved posts in Supergrow
9. Supergrow publishes to LinkedIn at scheduled time

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
| Auth | DISABLED for testing (passthrough) | See auth section below |
| AI — posts | OpenAI GPT-4o (`openai` package) | LinkedIn post generation |
| AI — images | Google Gemini `gemini-2.5-flash-image` (`@google/genai` package) | Nano Banana image generation |
| Image storage | Cloudflare R2 via `@aws-sdk/client-s3` | Public image hosting for Supergrow |
| Scheduling | Supergrow MCP via `@modelcontextprotocol/sdk` | LinkedIn post drafting |
| File uploads | `multer` (memory storage) | RAG document upload |
| Progress | Server-Sent Events (SSE) | Live campaign progress in browser |
| Hosting | Render Starter ($7/month) | Single Node.js web service |
| PDF parsing | `pdfjs-dist` (transitive dep, no extra install) | RAG PDF text extraction |

---

## FILE STRUCTURE

```
thegreenagents-studio/
├── index.html
├── package.json                        ESM, "type": "module"
├── vite.config.js
├── render.yaml
├── .npmrc                              legacy-peer-deps=true
├── .gitignore
│
├── server/
│   ├── index.js                        Express app, port 10000 (Render) or 3001 (local)
│   ├── db.js                           SQLite setup
│   ├── middleware/
│   │   └── auth.js                     AUTH DISABLED — passthrough next() for testing
│   ├── routes/
│   │   ├── auth.js                     POST /login, /logout, GET /check
│   │   ├── clients.js                  CRUD + RAG upload + Supergrow auto-sync
│   │   └── campaigns.js                Campaign pipeline, SSE, deploy endpoint
│   ├── services/
│   │   ├── openai.js                   GPT-4o post generation (LinkedIn Master prompt)
│   │   ├── gemini.js                   Nano Banana image generation
│   │   ├── r2.js                       Cloudflare R2 image upload
│   │   └── supergrow.js                Supergrow MCP client (dual-transport)
│   └── utils/
│       └── extractText.js              PDF/text extraction for RAG uploads
│
└── src/
    ├── main.jsx
    ├── App.jsx                         AUTH DISABLED — renders Dashboard directly
    ├── index.css
    └── components/
        ├── Dashboard.jsx               Client grid + auto-sync on load
        ├── Sidebar.jsx
        ├── ClientCard.jsx
        ├── NewClientModal.jsx
        ├── ClientDetail.jsx            Client detail, RAG upload, run campaign, history
        └── CampaignProgress.jsx        Live SSE progress + post review grid + deploy button
```

---

## DATABASE SCHEMA

**clients table**
```sql
id TEXT PRIMARY KEY
name TEXT                         -- e.g. "The Green Agents"
brand TEXT                        -- e.g. "The Green Agents" (used in image branding)
website TEXT
supergrow_workspace_name TEXT
supergrow_workspace_id TEXT       -- UUID from Supergrow workspace URL
supergrow_api_key TEXT            -- Per-client Supergrow API key (from Supergrow Settings > MCP)
timezone TEXT                     -- e.g. "Europe/London"
cadence TEXT                      -- e.g. "Daily", "3x week"
posting_identity TEXT             -- "personal" or "company"
approval_mode TEXT                -- currently IGNORED — always uses create_post (drafts)
rag_filename TEXT
rag_content TEXT                  -- Extracted plain text (NOT raw bytes) — PDFs are parsed
created_at TEXT
updated_at TEXT
```

**campaigns table**
```sql
id TEXT PRIMARY KEY
client_id TEXT
status TEXT                       -- pending | running | awaiting_approval | completed | failed
stage TEXT                        -- generating_posts | generating_images | awaiting_approval | deploying | done | error
progress INTEGER                  -- 0-100
total_posts INTEGER               -- 12 for testing, 96 for production
posts_generated INTEGER
images_generated INTEGER
posts_deployed INTEGER
posts_json TEXT                   -- JSON array of all posts with image_urls, quality scores, etc.
error_log TEXT
files_json TEXT                   -- JSON object of output files (content as strings)
created_at TEXT
completed_at TEXT
```

---

## ENVIRONMENT VARIABLES (set in Render)

| Key | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` | Still in env but Claude is no longer used for posts |
| `OPENAI_AI_KEY` | `sk-proj-...` | **NOTE: named OPENAI_AI_KEY not OPENAI_API_KEY** — code handles both |
| `GEMINI_API_KEY` | `AIza...` | Google AI Studio key |
| `SUPERGROW_MCP_URL` | `https://mcp.supergrow.ai/mcp?api_key=...` | Master API key URL |
| `R2_ACCOUNT_ID` | `9c5edb3cc8262aa7b43de4b42b970b99` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | `67815f3fd80704cfab3139dbc37c7bb1` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | `350763615e7ed3...` | R2 secret key |
| `R2_BUCKET_NAME` | `supergrowfortga` | R2 bucket name |
| `R2_ENDPOINT` | `https://9c5edb3cc8262aa7b43de4b42b970b99.r2.cloudflarestorage.com` | |
| `R2_PUBLIC_URL` | `https://pub-142245a59cdd4552a84f0f2d3e8ac94e.r2.dev` | Public image base URL |
| `STUDIO_PASSWORD` | `86sdg88gdsd6&DF!` | Auth disabled currently — for when re-enabled |
| `SESSION_SECRET` | `greenagents_studio_2026_secret_key` | |
| `NODE_ENV` | `production` | |
| `DB_PATH` | `/var/data/studio.db` | Persistent disk |

---

## AUTH STATUS — TEMPORARILY DISABLED

Auth is currently disabled for testing. Two files to restore it:

**server/middleware/auth.js** — uncomment the real check:
```js
// RESTORE: comment out the passthrough, uncomment the real check
export function requireAuth(req, res, next) {
  // return next(); // REMOVE THIS LINE
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorised' });
}
```

**src/App.jsx** — restore the full auth flow:
```js
// RESTORE: bring back Login component and auth check
// git show HEAD~5:src/App.jsx  (or check git history)
```

Also fix in Render: check STUDIO_PASSWORD has no trailing space — paste don't type.

---

## HOW SUPERGROW MCP WORKS (confirmed via live testing)

### Authentication
- API key in URL query param: `https://mcp.supergrow.ai/mcp?api_key=YOUR_KEY`
- No login/session exchange — key in URL is the only auth
- Per-client keys stored in `clients.supergrow_api_key`
- Missing key returns HTTP 401 with `{"error":"Missing api_key query parameter"}`
- Wrong key returns MCP-level error: `{"errors":["Invalid API key"]}`

### Transport
- **Streamable HTTP** — POST to `/mcp` then GET for SSE stream
- GET to `/mcp` returns 405 — no separate `/sse` endpoint
- Our code tries Streamable HTTP first, falls back to SSE (cached per API key)

### Tool: create_post (what we use — ALWAYS drafts)
```json
{
  "workspace_id": "uuid",
  "text": "post content",           // NOTE: 'text' not 'content'
  "image_urls": ["https://..."],    // optional array
  "linked_in_company_page_id": "uuid"  // optional
}
```
Returns: `{ status: "ok", post: { id, text, status: "draft", app_url, ... } }`

### Tool: queue_post (NOT used — creates draft with auto-assigned slot)
Same args as create_post. Returns same structure plus `time_slot_instance`.

### Tool: score_post (DISABLED — times out consistently)
```json
{ "workspace_id": "uuid", "text": "post content" }
```
Returns: `{ score: 0-100, feedback: "...", suggestions: ["..."] }`
**Currently disabled** — was timing out on every call (20s × 12 posts = 4 min waste).
Quality gate was: score < 70 triggers GPT-4o rewrite. Re-enable when MCP is stable.

### Tool: list_workspaces
No args. Returns array of `{ id, name, created_at, type, ... }`.
Used by auto-sync on dashboard load to add new workspaces as clients.

### Supergrow Approval Workflow (Kanban)
Three columns: **Drafts → Approved → Published**
- `create_post` lands posts in **Drafts** column
- Client/operator drags card from Drafts → Approved
- Agency clicks Schedule inside approved post to assign time slot
- Supergrow publishes at scheduled time
- Approval works on **pure drafts** — no slot assignment needed before approval

### Known issue: delete_post on a queued post
Returns 422 "Post cannot be deleted". Must `unschedule_post` first.
There is a test post (id: `69985593-9a5d-4adb-a149-9038bb4aaa07`) in the
Wesley Sweetman workspace that may need manual deletion from Supergrow.

---

## HOW THE CAMPAIGN PIPELINE WORKS

### Stage flow
```
generating_posts → generating_images → awaiting_approval → deploying → done
```

**Stage 1 — Post generation (GPT-4o, ~2-3 min)**
- Fetches Content DNA from Supergrow (non-fatal if fails)
- Calls OpenAI Responses API with web_search to get live LinkedIn algorithm context
- Sends full RAG + algorithm context + LinkedIn Master system prompt to GPT-4o
- Returns 12 posts (change `POSTS_PER_CAMPAIGN` in openai.js for 96)
- Each post has: id, topic, angle, buyer_segment, cta_type, content_pillar, format,
  suggested_day, suggested_time, linkedin_post_text, image_prompt

**Stage 2 — SCORING DISABLED**
- score_post was timing out on 100% of calls (20s each)
- Posts proceed directly to image generation

**Stage 3 — Image generation (Gemini Nano Banana, ~1-2 min)**
- Model: `gemini-2.5-flash-image` via `@google/genai` SDK
- Full Nano Banana spec applied (see IMAGE GENERATION section)
- Rate limit delay ONLY fires on successful generation (not on failures)
- Failed images are logged but don't stop the campaign
- Images uploaded to R2 at `images/{clientId}/{postId}-{uuid}.jpg`

**Stage 4 — awaiting_approval (operator review)**
- Pipeline STOPS here
- All 12 post cards with images shown in review grid
- Operator reviews, then clicks "Send N Drafts to Supergrow →"
- NOTHING goes to Supergrow until that button is clicked

**Stage 5 — Deploying (create_post, ~30 sec)**
- ALL posts sent as create_post (draft) — NEVER queue_post
- Each post includes image_urls if image was generated
- Single retry on failure
- 500ms delay between calls

---

## IMAGE GENERATION — NANO BANANA SPEC

"Nano Banana" is Google's codename for `gemini-2.5-flash-image`.
The spec comes from: `/Universal_NANO_BANNA_Image_Generation_Prompt_(Client-Agnostic)`

**Every image must have:**
- Brand name (`client.brand`) at bottom right — always
- 16:9 landscape for text posts, 1:1 square for carousel covers
- Scroll-stopper design: bold typography, high contrast, colour blocking
- Text on image allowed (hooks, stats, titles ≤15 words)
- Audience-tailored: uses `post.buyer_segment`
- NO stock photo clichés: no handshakes, no laptop photos, no whiteboard people

**SDK:** `@google/genai` (NOT the old `@google/generative-ai`)
```js
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash-image',
  contents: promptString,
  config: { responseModalities: ['TEXT', 'IMAGE'] }
});
```

**Free tier limits:** 500 images/day, 10 RPM (reset midnight Pacific)

---

## POST GENERATION — GPT-4o WITH LINKEDIN MASTER PROMPT

**Model:** `gpt-4o` via `openai` package
**System prompt:** Full LinkedIn New Client Master instructions (in `server/services/openai.js`)
**Key rules from the prompt:**
- Minimum 1,200 characters per post body
- First 2 lines = scroll-stopping hook, under 140 chars combined
- No external URLs in post body
- End every post with a specific open-ended question (never "Thoughts?")
- Banned words: delve, landscape, testament, crucial, unlock, game-changer, etc.
- Formats: Text Post, Carousel, Video Script, Founder Story
- Vary formats across the batch (min 2 carousels per 12 posts)

**Algorithm context:** Uses OpenAI Responses API with web_search tool to fetch
current LinkedIn algorithm best practices before every campaign run.
Falls back to static built-in guidelines if web search unavailable.

**Posts per campaign:** `POSTS_PER_CAMPAIGN = 12` (testing)
Change to 96 for production. Note: 96 posts will need batching (GPT-4o ~16k token limit).

**JSON response format per post:**
```json
{
  "id": 1,
  "topic": "",
  "angle": "",
  "buyer_segment": "",
  "cta_type": "",
  "content_pillar": "Authority | Story | Education | Commercial | Engagement",
  "format": "Text Post | Carousel | Video Script",
  "suggested_day": "Tuesday",
  "suggested_time": "08:00",
  "linkedin_post_text": "",
  "image_prompt": ""
}
```

---

## RAG DOCUMENT HANDLING

- Stored as plain text in `clients.rag_content` column
- PDFs are parsed via `pdfjs-dist` in `server/utils/extractText.js`
- Supports: `.pdf`, `.txt`, `.md`, `.csv` (anything else = UTF-8 string)
- Upload limit: 20MB via multer
- **Current client John Wicks uses `The_Green_Agents_RAG_Master.pdf`**

**IMPORTANT:** Any client whose RAG was uploaded BEFORE commit `6b6872b` (April 15 2026)
has binary garbage stored. Re-upload their PDF via Edit Client → Replace.

---

## AUTO-SYNC (Supergrow → App)

On every dashboard load, `POST /api/clients/sync` is called:
- Uses the master API key from `SUPERGROW_MCP_URL` env var
- Calls `list_workspaces` to get all Supergrow workspaces
- Creates new client records for any workspace not already in the DB
- Never modifies existing clients
- New clients get defaults: timezone=Europe/London, cadence=Daily, approval_mode=auto

Known workspaces in the account:
- john wicks's Workspace (`cd842050-...`)
- sweetbyte
- The Manson Group (`914be39a-f90d-4635-b216-6a2c7281abbd`)
- Cube6
- Tower leasing (added April 15 2026)

---

## THE JOHN WICKS CLIENT (primary test client)

**Who:** John Wicks, Co-founder of THEGREENAGENTS.COM
**Voice:** Plain speaking, light-hearted, slightly irreverent, UK English
**Anti-jargon:** Hates corporate fluff, vanity metrics, abstract marketing
**Focus:** Tangible outcomes — new customers, sales leads, predictable pipeline
**RAG file:** `The_Green_Agents_RAG_Master.pdf` (5 pages)
**Supergrow workspace:** john wicks's Workspace
**Content:** Two-Engine System (Outreach Engine + Social Trust Engine)
**Target:** UK SMEs, 50-200 employees, MDs/Founders/CEOs, no CMO

---

## SUPERGROW MCP — FULL TOOL REFERENCE (38 tools confirmed live)

Core tools used by this app:
| Tool | Args | Used? |
|---|---|---|
| `list_workspaces` | none | ✅ Auto-sync |
| `create_post` | workspace_id, text, image_urls?, linked_in_company_page_id? | ✅ Deploy |
| `queue_post` | workspace_id, text, image_urls?, linked_in_company_page_id? | ❌ Not used |
| `get_content_dna` | workspace_id | ✅ Before generation |
| `score_post` | workspace_id, text | ⏸ Disabled (timeouts) |
| `get_company_pages` | workspace_id | ✅ Available |
| `schedule_post` | workspace_id, post_id, year, month, day_of_the_month, hour, minute | ❌ Tested, failed (Invalid time slot) |
| `delete_post` | workspace_id, post_id | ⚠️ 422 if post is queued |

Other available tools (not yet used):
`list_posts`, `get_post`, `update_post`, `delete_post`, `create_public_link`,
`delete_public_link`, `unschedule_post`, `publish_post`, `get_weekly_calendar`,
`get_monthly_calendar`, `get_kanban_board`, `get_kanban_column`, `get_weekly_reports`,
`get_followers`, `get_metrics`, `extract_content`, `extract_youtube`, `extract_pdf`,
`extract_audio`, `questions_from_topic`, `questions_from_text`, `kb_ingest`,
`kb_list`, `kb_get`, `kb_delete`, `kb_search`, `regenerate_content_dna`,
`get_linkedin_accounts`, `create_auto_plug_comments`, `list_auto_plug_comments`,
`delete_auto_plug_comment`

**score_post returns 0-100 (NOT 0-10). Quality gate threshold = 70.**

---

## WHAT NEEDS BUILDING NEXT (priority order)

### 1. Individual post/image regeneration on review grid (HIGH PRIORITY)
Currently if you dislike a post or image, you must restart the entire campaign.
Need per-card buttons:
- **🔄 Regenerate image** — calls Nano Banana for just that post, replaces card image
- **✏️ Edit text** — inline text editor on the card
- **🔄 Regenerate post** — sends topic/angle back to GPT-4o, replaces post text
New endpoints needed:
- `POST /api/campaigns/:id/regenerate-image/:postIndex`
- `POST /api/campaigns/:id/regenerate-post/:postIndex`
- `PATCH /api/campaigns/:id/edit-post/:postIndex`
All update only the single post in `campaigns.posts_json`.

### 2. Persist review grid after deploy
After sending to Supergrow, completed campaigns should still be viewable.
Each post card should show a **"View in Supergrow →"** link using the `app_url`
returned by `create_post` (currently only saved in execution_results.json).
Store `app_url` per post inside `posts_json` during deploy.

### 3. Campaign history clickable
Campaign history rows should reopen the full post grid view.
Currently only shows status and download files.

### 4. Re-enable auth
Restore `server/middleware/auth.js` and `src/App.jsx`.
Fix STUDIO_PASSWORD in Render (re-paste, check no trailing space).

### 5. Scale to 96 posts
`POSTS_PER_CAMPAIGN` in openai.js = 96
Will need batching: 8 calls × 12 posts each (GPT-4o 16k token limit).
Gemini free tier: 500 images/day at 10 RPM — 96 images = ~10 min.

### 6. Scheduling
Manus used `queue_post` not `schedule_post` (schedule_post returned "Invalid time slot").
`queue_post` auto-assigns next available slot from workspace calendar.
For now, posts go as drafts and are scheduled manually in Supergrow.
Future: add per-client scheduling config and use queue_post after approval.

---

## RENDER DEPLOYMENT

**Build command:** `npm install --include=dev && npm run build`
**Start command:** `npm start`
**Build process:**
1. `npm install --include=dev`
2. `npm rebuild better-sqlite3 --build-from-source`
3. `vite build`
4. `node server/index.js`

**Auto-deploys** on every push to `main`.
Build takes ~3-5 minutes. Check Render logs if build fails.

---

## KNOWN ISSUES AND NOTES

**OPENAI_AI_KEY vs OPENAI_API_KEY**
Render env var is `OPENAI_AI_KEY` (typo). Code accepts either:
`process.env.OPENAI_API_KEY || process.env.OPENAI_AI_KEY`
Startup log shows: `OPENAI_API_KEY: SET ✓ (using OPENAI_AI_KEY)`

**better-sqlite3 requires native compilation**
Build command must include `npm rebuild better-sqlite3 --build-from-source`.

**ESM throughout**
`"type": "module"` in package.json. Use `import/export` everywhere.
Use `import.meta.dirname` or `fileURLToPath(import.meta.url)` for `__dirname`.

**score_post MCP timeouts**
Supergrow MCP `score_post` tool times out on every call from Render (~20s each).
Scoring is disabled. Quality gate at 70/100 is ready to re-enable.
The code for scoring + GPT-4o auto-fix still exists in openai.js (`fixPost`).

**Gemini model history**
- `gemini-2.0-flash-exp` — deprecated, 404
- `gemini-2.0-flash-preview-image-generation` — deprecated, 404
- `gemini-2.5-flash-image` — CURRENT, working ✅

**PDF RAG storage**
Old uploads (before commit 6b6872b) stored binary. Re-upload to fix.
New uploads use pdfjs-dist extraction — all formats work correctly.

**Session/Cookie auth**
Uses `cookie-session`, not `express-session`. Session stored in signed cookie.
`secure: true` in production — requires HTTPS (Render provides this).

**Supergrow auto-sync**
Runs on every dashboard load. Creates new clients from Supergrow workspaces.
New clients get master API key from SUPERGROW_MCP_URL env var.
Per-client API key should be set manually after auto-creation for real campaigns.

---

## API ROUTES REFERENCE

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | No | Login |
| POST | `/api/auth/logout` | No | Logout |
| GET | `/api/auth/check` | No | Check session |
| GET | `/api/clients` | Yes | List all clients |
| GET | `/api/clients/workspaces?api_key=` | Yes | Fetch Supergrow workspaces |
| POST | `/api/clients/sync` | Yes | Auto-sync Supergrow workspaces |
| GET | `/api/clients/test-supergrow` | Yes | Test Supergrow MCP connection |
| GET | `/api/clients/:id` | Yes | Get client + campaign history |
| POST | `/api/clients` | Yes | Create client (multipart with RAG) |
| PUT | `/api/clients/:id` | Yes | Update client (multipart with RAG) |
| DELETE | `/api/clients/:id` | Yes | Delete client + all campaigns |
| POST | `/api/campaigns/start/:clientId` | Yes | Start campaign (async) |
| GET | `/api/campaigns/progress/:id` | Yes | SSE stream for live progress |
| POST | `/api/campaigns/:id/deploy` | Yes | Deploy posts to Supergrow as drafts |
| GET | `/api/campaigns/client/:clientId` | Yes | List campaigns for a client |
| GET | `/api/campaigns/:id` | Yes | Get single campaign |

---

## GIT HISTORY — KEY COMMITS

| Commit | What changed |
|---|---|
| `aa82978` | Added SSE transport fallback + timeouts to supergrow.js |
| `4c16199` | Fixed content→text bug, score scale 0-100, suggestions array |
| `604dadf` | Fixed 401 redirect, improved login diagnostics |
| `9f60602` | Disabled auth for testing |
| `4ca05ef` | Replaced Claude with GPT-4o, added awaiting_approval stage + preview grid |
| `6b6872b` | Fixed OPENAI crash (env var name) + PDF text extraction |
| `cc6cbf5` | Removed score_post (100% timeout), fixed progress bar, UI overhaul |
| `884486d` | Fixed Gemini model, skip delay on image fail, fixed post grid render |
| `7684f28` | Implemented full Nano Banana image spec |
| `e72c55d` | Switched to gemini-2.5-flash-image + @google/genai SDK (CURRENT) |

