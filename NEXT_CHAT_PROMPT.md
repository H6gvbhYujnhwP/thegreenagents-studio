I'm continuing work on thegreenagents-studio (studio.thegreenagents.com). I've attached BLUEPRINT.md and a FRESH repo zip.

Read BLUEPRINT.md start to finish before doing anything or touching any code — start with the "⭐ NEXT CHAT — START HERE" block (currently marked the 2026-06-11 ELEVENTH session) and the "⚠️⚠️ CURRENT TRUTH (#107)" block. It's the project memory and carries the reasoning behind decisions, not just the what — respect the locked-in decisions and working principles, and don't relitigate them.

FIRST ACTION: the zip I've attached is the current truth — build on it, never an older version. Several files now carry shipped Facebook/Meta work; don't roll them back: `meta-api.js`, `facebook-pixels.js`, `portal.js`, `db.js`, `FacebookPixels.jsx`, `FacebookAds.jsx`, `PortalApp.jsx`, plus `Sidebar.jsx`/`Dashboard.jsx`.

Key context from the last session (2026-06-11, eleventh):

* **Facebook & Meta Pixels are READ-ONLY in Studio (#107) and are now fully built on BOTH admin and customer portal.** Studio only DISPLAYS performance/stats; Manus AI makes the posts/images and builds the campaigns. One ad account / one pixel per customer.

* What shipped this session (#108–#112, all read-only display):
  - **Customer-portal Facebook Ads page** — portal mirror of the admin read view, scoped to the customer's own ad account (`GET /api/portal/facebook-ads`).
  - **"Facebook Posts" removed everywhere** — that service is retired; only Meta Pixels + Facebook Ads remain in both sidebars.
  - **Meta Pixels Stage 3 done** — admin **Live tracking** card (status + daily activity graph + plain-English event list) and a customer-portal **"Website Tracking"** page (`getPixelStats` in meta-api.js, `GET /:id/stats` + `GET /available-pixels` admin routes, `GET /api/portal/meta-pixels`). Added a **pixel picker dropdown** (lists business pixels) so the operator selects instead of typing the ID.
  - **Display tidy (operator decision):** pixel display is "Option A" (status + graph + labelled list). Removed the ambiguous "Events tracked"/"Event types" stats, the whole admin Setup checklist, and the Business ID / Ad account ID / Goal / Conversion event fields (DB columns left dormant, no schema change).
  - **Gating fix:** `db.js` `seedService` is INSERT OR IGNORE (never updates existing rows), so service-state changes use explicit idempotent UPDATEs — `facebook_ads` + `facebook_pixels` flipped to `live`, `facebook` retired.

* Meta operational facts (not code):
  - The **WDYQ pixel** ("We Do Your Quotes Pixel", id 1974001156566087) is LIVE on wedoyourquotes.com and confirmed firing; Studio reads it (showed ~21 page views).
  - For Studio to read a pixel's stats (and for it to show in the picker), the **Conversions API System User (61590505616709)** must be assigned to that pixel in Meta Business Settings (Manage/View). Missing assignment shows as **"(#100) Missing perms"** in Studio.
  - Meta's pixel **stats API lags** the live Test Events feed (up to ~30 min). Test Events fired via the Test Events button are TEST events and never count in Overview/Studio — only real visits do.
  - Studio shows ads; it does NOT run them. Ads only appear when a funded live campaign exists in Meta (Manus's job).

* Facebook/Meta optional follow-up (don't pre-act): a **Visitors → Leads funnel + conversion %** on the Meta Pixels pages — only meaningful once the customer's site fires a **Lead** event (form submit); today wedoyourquotes only fires PageView so it'd read 0. Add when Lead events are live.

* Still-open carry-overs from earlier sessions (don't pre-act unless I raise them): **#100** SES SNS Notifications wiring on the other 13 verified SES identities (operator action, ~90s each, no code); **#101a** one-line reply-count SQL fix; **#101b** scanner-vs-human click filter (Phase 2); **#101c** bounce-rate auto-pause; the **AWS-account split** for reputation isolation (plan agreed, no code); **#95** round-trip verification; tracked write path (#87/#88) when Cube6 step 3 fires; email_replies backfill (#90); the **Manson JSON-parse bug** (operator-deprioritised).

How I work (also in the blueprint): I'm not a coder. I push files via GitHub Desktop and communicate with screenshots. Explain things in how-the-app-behaves terms, not code jargon. Parse-check every file before claiming it's done. For any read-query that joins across the customer tables, smoke-test in-memory against the awkward shapes (Cube6 linked, Manson self-linked) before shipping (lesson #77). Give me one file per location with explicit "this file goes here" paths. When I ask for design X, propose the best mechanism + named alternatives (and mockups for screens) BEFORE writing code. Honest pushback is expected — don't agree just to be agreeable. Be careful editing `PortalApp.jsx` (sensitive, past regressions) — minimal changes, follow the existing nav/page wiring. Keep responses short and sweet.

Ask me what I want to work on first before diving in. Natural choices: (a) confirm the Facebook/Meta work renders correctly live (customer portal Meta Pixels + Facebook Ads pages, admin Live tracking + graph) and tune the graph from real output if needed; (b) the SES Notifications grind on the other 13 identities (#100); (c) the one-line reply-count SQL fix (#101a); (d) the AWS-account split (Stage 1 foundation); (e) something else I bring up.
