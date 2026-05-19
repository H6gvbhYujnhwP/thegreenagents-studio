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

### Customer-portal architecture (locked in earlier chats)

11. **Two parallel "client" tables exist by design** — `clients` (LinkedIn-side, Supergrow workspaces) and `email_clients` (email-side, send domains). They were built independently and DO NOT share IDs. The customer portal links them via `customer_services.linked_external_id`. **Don't try to merge them** — too much code reads from each, and the portal layer handles the join cleanly.

12. **Generic services model, not per-service columns.** Adding a new service (Facebook, SEO, Google Ads, anything) is `INSERT INTO services` — no schema change, no React changes, no service-specific code. Two tables drive the whole thing: `services` (catalogue) and `customer_services` (subscriptions). See "Customer portal — generic services design" below for full detail.

13. **`portal_enabled` flag separates "I have a portal" from "I'm a cold-email customer".** A customer like `mail.engineersolutions.co.uk` can be a cold-email customer (in `email_clients`) without having a portal. A customer like `Cube6` can have a portal without being a cold-email customer. They can also be both. The Customer Portal admin page filters by `portal_enabled = 1`.

14. **Self-links in `customer_services` are exempt from the cross-customer UNIQUE constraint.** The partial UNIQUE index has `WHERE linked_external_id IS NOT NULL AND email_client_id != linked_external_id`. Self-links represent "this customer's portal uses its own data" — they're a default state, not a cross-customer claim. Important: the original migration WITHOUT this exemption was deployed, and a fix was shipped that drops + recreates the index on every boot. Don't go back to the unconditional unique.

15. **Logo cross-sync is "option Z" — last write wins on both sides.** Uploading a logo on either the LinkedIn admin side OR the customer-portal admin side propagates to the other if a link exists. R2 keys differ (`logos/<id>/...` vs `logos/portal/<id>/...`) but both `logo_url` columns end up with the same URL.

16. **Slug auto-versioning on collision** — `tower-leasing` first, then `tower-leasing-2`, `-3`. Wez accepted that customer-facing URLs may end up looking versioned. **Don't try to "improve" this without re-asking.**

17. **Sessions are SQLite-backed, idle 7d / absolute 30d.** No in-memory Map (would die on Render restart).

18. **Customer "Approve all" → Supergrow uses live `queue_post`, NOT `create_post`/draft.** The customer's approval IS the green light. Differs from admin-side `deployToDrafts`.

19. **Admin sets initial portal passwords; portal shows "your password is temporary" banner on first sign-in.** No invite-link flow. Reset emails work the normal way for forgotten passwords later.

### Customer-portal final-mile decisions (locked in earlier chats)

20. **The customer portal mirrors the admin post-card layout exactly — image at natural aspect (no cropping), full body text with "Read full post" expand, content_pillar · format meta line, "📅 Day Time" schedule, four action buttons (Edit text / Rewrite post / New image / Approve).** The customer reviews exactly what'll be posted to LinkedIn — no truncated previews. Spinner overlays cover the card during text regen and sit over the image during image regen, with a "Please wait while your image/text is being regenerated" helper message.

21. **Regenerate is split into two backend routes — `/regenerate-text` (Anthropic only) and `/regenerate-image` (Gemini + R2 only).** Mirrors admin's "Rewrite post" / "New image" buttons. Combined 30/customer/day cap shared with the legacy combined `/regenerate` route — any text or image regen counts toward the same 30. The legacy combined route is kept in place but no longer wired to a UI.

22. **"View in Supergrow" link is hidden from customers everywhere.** Customers see the portal as a Green Agents product; they don't see the underlying Supergrow tool. Applies to both the live review grid and the read-only past-campaign history.

23. **Past campaigns history: ANY deployed campaign for this customer's linked LinkedIn client.** Specifically `stage IN ('deployed', 'done')` — meaning anything customer-approved via approve-all (`deployed`) AND anything admin pushed direct to Supergrow drafts before the portal existed (`done`). Read-only: same `PostCard` component as the live grid but with `readOnly` prop hiding the action row. Lives below the current-batch grid on the same LinkedIn Posts page (no separate "history" nav item).

24. **Customer portal sidebar uses identical colour to admin sidebar (`#0F6E56`).** TGA logo + tile + "The Green Agents / Studio" wordmark are visually identical at the top-left across both. Logo lives at `public/tga-logo.png` (Vite-bundled static asset, served from URL root).

25. **`generatePosts` runs without web search.** The web_search tool was the root cause of the 2026-05-07 Cube6 failure ("I need to conduct the required research before generating the posts" — Claude returned that as text and never produced JSON). The LinkedIn algorithm context now comes from the stored `algorithm_brief` (set by the admin "LinkedIn Algorithm" button). If the brief is null or older than 14 days, the campaign log shows a non-blocking warning. Both `generatePosts` and `regenerateSinglePost` also got an automatic JSON-parse retry — up to 2 attempts, with the second using an aggressive "JSON ONLY" override system message.

26. **Customer-portal reply send uses the mailbox the original arrived on.** Decision locked in chunk 3b-ii. The `email_inboxes.email_address` becomes the `From:` of the outbound. Maintains threading because (a) the recipient sees the same address that originally received them, (b) that mailbox is already SES-verified, (c) `In-Reply-To` and `References` headers wire the new message into the existing thread in Gmail/Outlook.

### Customer-portal further decisions (locked this chat)

27. **The legacy `'deployed'` campaign stage is dead — collapsed into `'done'` with a `deployed_by` column.** Earlier work set `stage='deployed'` on customer-portal approve-all, which the admin's CampaignProgress UI didn't recognise (its STAGES list goes `awaiting_approval → deploying → done`). Result: the admin opened a deployed campaign and saw a broken progress bar with active regen buttons that could overwrite live posts in Supergrow's queue. **Fix shipped:** customer approve-all now sets `stage='done', status='completed', deployed_by='portal'`. Admin deploy sets `deployed_by='admin'`. A one-shot migration in `db.js` converts any existing `'deployed'` rows to `'done'+deployed_by='portal'` on next boot. **Don't reintroduce a `'deployed'` stage value.**

28. **Admin regen/edit endpoints are stage-locked once a campaign is `done`.** `regenerate-image`, `regenerate-post`, and `edit-post` in `routes/campaigns.js` all return 400 if `stage === 'done'`. The admin UI also hides those buttons when `isDone`. Belt-and-braces: prevents stale browser tabs from blowing away posts already pushed to Supergrow.

29. **Admin sees "Customer approved" pill + read-only banner for portal-deployed campaigns.** Status pill in the campaign list reads "Customer approved" (blue) instead of "Deployed" (green) when `deployed_by='portal'`. Inside CampaignProgress, the header reads "✅ Customer approved & sent to Supergrow" and a blue banner says "All N posts pushed to Supergrow's scheduled queue. Editing and regeneration are locked because the posts are already live." The "Re-send all to Supergrow" button does NOT appear (re-sending live queued posts would duplicate them).

30. **The temporary-password banner on the customer portal is permanently removed.** Was a yellow strip at the top of the portal that nudged customers to change their initial password. Wez explicitly killed it — "I do not want this shown period." The `must_change_password` flag still flows from `/auth/check` (no DB change, no API change) but is no longer surfaced anywhere in the UI. Don't reintroduce.

31. **Customer-portal posts grid uses responsive auto-fill columns matching admin exactly.** Was hardcoded `'1fr 1fr'` (forced 2 columns regardless of viewport). Now `'repeat(auto-fill, minmax(340px, 1fr))'` with 16px gap — same rule the admin uses. On a wide screen this gives 4 columns; narrower viewports automatically reflow. Both the live review grid and the past-campaigns history expansion grid use the same value.

32. **Customer portal sidebar groups social services under "Social media" (not "Social posts").** The section was renamed to fit Facebook Pixels (a tracking service, not a posting one). All five items live there: LinkedIn Posts, Facebook Posts, Instagram, TikTok, Facebook Pixels.

33. **Three new social services seeded as `state='coming_soon'` in the catalogue: instagram, tiktok, facebook_pixels.** These join the existing `linkedin`, `facebook`, `email`. The admin Manage panel automatically shows them as "Coming soon" entries (no checkbox available). The customer portal automatically shows them in the sidebar with a sales pitch on click. Adding a new service in future is still a DB insert + frontend NavItem.

34. **`services.customer_pitch` column holds customer-facing sales copy.** Separate from the existing `description` column which is admin-facing operator text. Two audiences, two columns. Pitch text is re-applied on every boot via the seed block in `db.js` so wording tweaks ship via deploy with no manual DB work. Pitches landed for: facebook, instagram, tiktok, facebook_pixels, email. (linkedin pitch is null — that service is enabled for everyone who has it, never gated for sales.)

35. **`services` payload from `/api/portal/auth/check` now returns `{state, label, pitch}` per service, not bare strings.** Was `{linkedin: 'enabled'}` previously, now `{linkedin: {state: 'enabled', label: 'LinkedIn Posts', pitch: null}}`. All read sites in PortalApp.jsx updated to use `svc.linkedin?.state`. ServiceGate is defensive — handles either shape so a stale browser cache doesn't crash.

36. **Customer-side ServiceGate shows "Not Subscribed" + sales pitch — never "Coming soon".** Both `coming_soon` and `not_required` states render identically on the customer side. The customer doesn't need to know the DB-level distinction (which exists only to gate the admin's Manage panel checkbox). Pill says "Not Subscribed" in neutral grey. Body shows the service-specific sales pitch from `services.customer_pitch`.

37. **Admin sidebar has a single placeholder screen (`AdminComingSoon`) re-used for unbuilt services.** Four sidebar items — Facebook Posts, Instagram, TikTok, Facebook Pixels — all route to the same generic "Coming soon — Feature in development" component in `Dashboard.jsx`. Each has a "Soon" badge in the sidebar (admin needs to know which screens are real and which are placeholders). When a real admin tool ships for any of these, replace its branch in Dashboard's view router with a real component mount.

38. **(SUPERSEDED by #42 and #54.)** Originally specified auto-detect of logo background type (transparent vs white-bg vs dark-corner JPEG-as-PNG) with a different patch-colour decision per case. Both the auto-detect AND the per-case branching are gone — every logo now goes through the same upload-time trim pipeline (#54) and the same always-white compositor panel (#42). Kept here for history because earlier session lessons still reference it.

39. **(SUPERSEDED by #54.)** Originally specified that logo trim happens inline in the post compositor on every regen, branched on whether the source has alpha. The trim location moved to upload time in #54 — the file in R2 is now the canonical pre-trimmed form. The transparency branching logic itself is unchanged, just relocated to `services/logo-prep.js`. Kept here for history because earlier session lessons reference it; consult #54 for the live behaviour.

40. **IMAP poller crashes are logged, not fatal.** ImapFlow emits `error` events on the EventEmitter when sockets time out. Without listeners, Node treats them as unhandled and kills the entire process — taking the drip ticker and reply classifier with it. Fix shipped: `client.on('error', handler)` attached to every ImapFlow client at construction (both `pollOneInbox` and `testImapCredentials`). Belt-and-braces: top-level `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers in `server/index.js` log and continue rather than crashing.

### Customer-portal further decisions (locked in this chat — 2026-05-08)

41. **`email_clients.source` column distinguishes real email customers from portal anchor rows.** Three values: `'aws_domain'` (auto-pulled from AWS verified domains, or matched to one when manually added), `'manual'` (operator-created with a name that's not a verified SES domain — vanishingly rare), `'portal'` (auto-created as a portal anchor when a LinkedIn-only customer like Cube6 had a portal enabled — these rows have no email-sending purpose). The Email Campaigns Customers list filters `WHERE source IN ('aws_domain', 'manual')` so portal anchors don't pollute the list. Migration on first boot classified the 13 existing rows: any `portal_enabled=1` row with no email activity (no lists, subs, campaigns, or inboxes) → `'portal'`; everything else → `'aws_domain'`. Self-healing: if a portal-only customer ever becomes a real email-sending customer the activity check would flip them automatically — but this would be rare enough that the operator would just manually update the row.

42. **Logo compositor uses one unified path for every customer — always-white panel, no detection branching.** Earlier code tried to detect when a logo had its own white background (e.g. Tower Leasing) and skip the contrast panel, plus a separate dark-corners override for JPEG-as-PNG logos that forced white panel colour. Both branches are gone. **Every logo now goes through the same path: resize the (already-trimmed) canonical logo → place on a fully-opaque pure-white panel with rounded corners (`rgba(255,255,255,1.0)`) and proportional padding (20% of the logo's smaller dimension after resize, floor 8px).** White-bg logos blend into the panel — no harm. The image's bottom-right brightness is no longer sampled to decide patch colour either, because that heuristic produced dark panels on Sweetbyte's regen (orange-band image bottom-right → dark panel → dark-on-dark logo, illegible). Predictability beats cleverness. The Gemini fallback model order was also reordered so the working `gemini-2.5-flash-image` is tried first (~150ms saved per image). **Known limitation:** white-on-transparent logos (light wordmark designed for dark backgrounds) would render invisibly on the white panel — none of our current customers have one, but if a future customer does the answer is "ask them for a darker version", not "re-introduce detection branching". Two specifics later changed in the next session: (a) trim moved out of the compositor entirely — see #54 for upload-time trim; (b) padding became proportional rather than fixed-20 — see #55 for the trade-off across Tower's wide wordmark vs Cube6's compact logo.

43. **Phase 4 multi-step sequence editor is fully built, not "schema only".** The blueprint-as-of-2026-05-07 said "Sequence editor UI in CampaignModal — mockup first" was still missing. Wrong. The campaign modal has tab-strip UI ("1st contact / 2nd contact / 3rd contact / + Add contact") with per-step body editors and a delay-days input that shows on every step after the 1st. Steps are saved via `PUT /api/email/campaigns/:id/steps`; they're sent by the drip ticker which extends the candidate list with follow-ups whose previous step's send timestamp is `delay_days` ago. Up to 10 steps per campaign. Step 1's `html_body` is mirrored to `email_campaigns.html_body` for legacy code paths. Step removal warns if the step has already been sent to anyone.

44. **Subject line is per-step, not campaign-wide.** Each follow-up in a sequence can have its own subject — e.g. "Quick question, {{first_name}}" → "Re: my last note" → "One more thought". Stored as `email_campaign_steps.subject TEXT` (NULL means "fall back to the campaign-wide subject at send time"). Step 1's subject is required and is mirrored to `email_campaigns.subject` so test sends, previews, and the legacy single-step send path keep working unchanged. Steps 2+ subjects are optional. The `sendCampaign` function in `services/ses.js` accepts a `subjectOverride` parameter mirroring the existing `bodyOverride`; the drip ticker passes the step's subject through. The campaign modal moved the subject input out of the campaign-level header and into the per-step tab panel above the body editor. Step 1's tab labels it "Email subject *"; later tabs label it "Email subject for this contact (leave blank to reuse the 1st contact subject)".

45. **Rich-text editor defaults to Verdana 12pt; operator can change via toolbar.** Was Arial 14pt. Toolbar gained a font-family picker (8 email-safe fonts: Verdana, Arial, Helvetica, Tahoma, Trebuchet MS, Georgia, Times New Roman, Courier New). The font-size picker also got 10px and 11px added to the smaller end. The recipient-side CSS in `services/ses.js` `wrapBodyWithEmailCss` was updated to match — defaults to Verdana 12 — so the body of a new campaign authored in the editor renders identically in Gmail/Outlook. Existing campaigns that had inline `<span style="font-family:Arial; font-size:14px">` from previous authoring keep those styles (inline overrides the wrapper CSS), so no visual change to in-flight or already-sent drafts.

### Customer-portal further decisions (locked in this chat — 2026-05-08, second session)

46. **Customer-portal post action buttons are solid TGA-green with white text.** All four (Edit text / Rewrite post / New image / Approve) share one style now — solid `#0F6E56` background, white text, no border, 11px, weight 500, 7px vertical padding. Disabled state dims to 55% opacity. Approved state uses the lighter green tone (`TGA_GREEN_LO`) to show "✓ Approved" while staying on-brand. The operator explicitly chose "all four exactly the same" over giving Approve visual prominence. Trade-off accepted: customers may occasionally click a regen button thinking it's the confirm action. Blueprint should NOT relitigate this without re-asking.

47. **Three customer-portal post action endpoints had a number-vs-string ID bug latent since shipping.** Posts in `posts_json` have **numeric** id fields (Claude's generation prompt assigns `"id": 1, "id": 2, ...`). Express URL params are always strings. The original `findPostForPortalUser` lookup used strict equality (`p.id === postId`), which was always `1 === "1"` → false. Every per-post action route (Edit / Approve / Rewrite / New image) returned 404 "Post not found" for any campaign with numeric IDs. Cube6 didn't surface this because the customer skipped straight to Approve all (a different helper, `findCampaignForPortalUser`, which was correct). Tower Leasing was the first case that hit it. **Fix shipped:** `String(p.id) === String(postId)` plus a tolerance for the synthesised `post_<N>` form for posts that genuinely lack an id. Keep this string-coercion convention for any future code that compares post ids from URL params.

48. **`findPostForPortalUser` SELECT must include every column its callers use.** Same helper had a second bug discovered immediately after fixing the first — `SELECT id, stage, posts_json, created_at` omitted `client_id`. The regen routes then tried `campaign.client_id` to look up the LinkedIn `clients` row, found undefined, returned "Linked LinkedIn client not found". **Lesson, written down for future helpers: when a SQL helper returns a row to multiple downstream consumers, list every column the consumers need explicitly, or use `SELECT *`. Partial selects are a foot-gun across helper boundaries.** The companion helper `findCampaignForPortalUser` was already correct (it includes `client_id`).

49. **`email_clients.source` filter in admin routes hides portal-anchor rows from Email Campaigns customer list.** Decision #41 added the `source` column. The actual filtering ships in `routes/email.js` `GET /clients` with `WHERE source IS NULL OR source IN ('aws_domain', 'manual')`. The defensive `IS NULL` clause exists for race safety on a fresh deploy where the migration hasn't yet run on a row. Three real LinkedIn-only customers (Cube6, Mansons, Tower Leasing) now disappear from the Email Campaigns list while their portals continue to work. The classification on first boot was confirmed by a Render-shell diagnostic before code shipped — `portal=3, aws_domain=10` matched expectations exactly.

50. **Default-sender fields are inline-editable on the customer detail page header, not buried in the Edit Client modal.** Database columns `default_from_email` and `default_from_name` already existed pre-this-session — they auto-populated new campaigns and lists, but were only editable from inside the Edit Client modal. Now they live next to the Test send address on the customer detail header (`CampaignQueue` component), each with debounced 800ms auto-save to `PUT /api/email/clients/:id`. When the operator switches between customers in the left sidebar, all three fields re-sync from the new customer's row. New campaigns now also default Reply-to to `default_from_email` (was previously left blank) — operator confirmed reply-to should always equal the From address.

### Customer-portal further decisions (locked in this chat — 2026-05-08, third session)

51. **Inline-editable header fields update the parent's in-memory clients list, not just local state.** Decision #50 introduced the inline header fields with debounced auto-save, but the parent (`EmailSection`) held the customers array from a single `loadAll()` at page mount and never refreshed it after a save. Result: the operator typed values that DID save to the DB, but switching customers and back showed the old empty values (component remount re-initialised local state from the stale prop), and the New Campaign / List modals read the stale prop too — so neither auto-filled. Fix: the save handlers now read the response from `PUT /api/email/clients/:id` and call a new `updateClientLocally(updated)` helper on the parent which splices the updated fields into the in-memory `clients` array (preserving `list_count` / `subscriber_count` / `campaign_count` which the GET adds via subqueries but the PUT response doesn't include — explicit preserve so the sidebar list never flashes "undefined lists · undefined subs"). Same fix also narrowed the resync `useEffect` deps from `[id, test_email, default_from_name, default_from_email]` down to `[id]` only — otherwise updating the parent's array after a save would re-fire the effect mid-typing and clobber what the user was still entering. Header inputs also lost their placeholder text ("John Wicks", "hello@…") because operator wanted them genuinely blank when unset — placeholder was reading as a real saved value.

52. **Auto-unsubscribe gated on `matched_campaign_id`.** The classifier in `services/classify-replies.js` runs on every email in the customer's INBOX (so every row has a sensible badge), but the auto-unsubscribe path was firing on any `hard_negative`/`soft_negative` classification regardless of whether the inbound was a campaign reply. Random vendor mail with "remove me" footers (e.g. `cole@formspree.io`) was getting classified negative and auto-unsubscribing any subscriber on any of the customer's lists with a matching sender address — even though they'd never replied to a campaign. **Fix:** add `reply.matched_campaign_id &&` to the trigger condition in `applyClassification`. Lines up with the customer-portal "Normal email" badge logic (`PortalApp.jsx`'s `ClassifyBadge` already used `!reply.campaign_title` to neutralise the badge for non-campaign mail). If we can't tell which campaign a reply belongs to, we shouldn't act on its classification. Existing badly-unsubscribed rows from before this fix are NOT cleaned up — operator decided historical mess is fine.

53. **Gemini "BOTTOM RIGHT CORNER" prompt rule softened.** Earlier wording asked Gemini to "leave the bottom-right 320x140px area relatively clear (no text, no important design elements)" so our composited logo wouldn't cover important content. Side effect: Gemini interpreted the instruction as a positive design brief and rendered a visibly LIGHTER, cleaner-looking patch in that exact rectangle. On busy/dirty backgrounds (Cube6's factory-floor scene was the surfacing case) the lighter patch was clearly visible as a faint halo extending up and left of the actual white logo panel — looked like a "second white box" floating above the logo. **New wording:** `"Don't place text or the main subject in the bottom-right corner — a small logo will be added there in post-processing."` Drops the "320×140px clear area" framing that was producing the halo, keeps the protection against Gemini placing important content where the panel will land. The panel is opaque so anything underneath is hidden anyway — the only thing actually needed from Gemini is "don't put your main subject there."

54. **Logo trim moved from compositor to upload time.** Previously `compositeLogoBottomRight` in `services/gemini.js` ran Sharp's `.trim({ threshold: 30 })` inline on every regen. Sharp's trim is data-dependent — the same source file fetched twice could produce slightly different post-trim dimensions due to anti-aliasing, compression noise, or floating-point rounding. On Tower Leasing this surfaced as visible variance: Post 1's white logo panel was 320×116 pixels, Post 2's was 280×80, despite identical source logo and identical 1024×1024 underlying canvas. Diagnosed by Python script measuring the saved files. **Fix shipped:** new `services/logo-prep.js` module with `prepareLogoForStorage(buffer, mimetype)` that does the trim once at upload time. Same logic that used to live in the compositor — branch on alpha (transparent → keep alpha after trim; opaque → trim then `.flatten({ background: '#ffffff' })`), threshold 30, output as PNG (because trim can introduce alpha). SVGs pass through untouched (vector trim is meaningless). On trim failure (extreme edge case — entire image one colour) we fall back to the original buffer so the upload doesn't fail. Both upload routes (`routes/clients.js` POST `/:id/logo` and `routes/portal-admin.js` POST `/customers/:id/logo`) now call `prepareLogoForStorage` before the R2 PutObject. The shared `uploadLogoToR2` helper in `portal-admin.js` does it inline; `clients.js` mirrors the same pattern. The compositor in `gemini.js` no longer has any trim logic — it just resizes and places. Trim now happens once per upload, never per regen — every post gets identical bytes, identical dimensions, identical panel size. Two new DB columns track which rows have been processed: `clients.logo_processed_at TEXT` and `email_clients.logo_processed_at TEXT`. Both upload routes stamp this column on success. The cross-sync UPDATE that mirrors a LinkedIn-side logo across to linked email_clients rows now stamps the column on both sides simultaneously.

55. **Logo panel padding is proportional, not fixed-pixel.** First attempt after #54 bumped the compositor's PADDING constant from 20 to 40 because the operator wanted Tower Leasing's "Post 1" look (the bigger 320×116 panel) applied to every customer. That was a misread: the 320×116 size was just what 20px padding produced around Tower's natural ~280×76 wordmark — the variance was only between regens of the same customer, not between different customers. Bumping to 40 broke Cube6 — Cube6's compact logo + tagline composite is only ~100×100 after resize, so 40px on each side proportionally added an entire extra logo's width of empty white per axis. **Final answer: padding = 20% of the logo's smaller dimension after resize, with a floor of 8px.** Tower's ~280×76 wordmark gets ~15px padding (smaller dim = 76, 20% = 15); Cube6's ~100×100 logo gets ~20px padding. Different shapes, proportionally similar comfort. Floor of 8px guarantees breathing room for hypothetical tiny logos that resize to 30×30 or smaller. **Lesson:** when tuning a "looks right" pixel value across customers with different logo proportions, fixed pixels will always pull in the wrong direction for SOMEONE — proportional scaling is the only stable answer.

56. **Boot-time logo backfill in `services/logo-backfill.js`.** Every existing customer logo predates the trim-at-upload pipeline (#54), so they're sitting in R2 in their raw uploaded form. The backfill module walks every `clients` and `email_clients` row where `logo_url IS NOT NULL AND logo_processed_at IS NULL`, fetches the file from R2's public URL, runs it through `prepareLogoForStorage`, uploads the trimmed version to a NEW R2 key under the same prefix shape, and updates the DB row to point at the new URL with `logo_processed_at` stamped. The OLD raw file is left in place in R2 — we don't delete it, so a stale frontend tab loaded mid-deploy doesn't 404. The cross-sync between `clients` and any linked `email_clients` rows happens in the same pass, so processing a LinkedIn-side row also stamps + repoints any portal-mirror rows it's linked to. Idempotent: rows with `logo_processed_at` set are skipped, so re-running on subsequent boots is a no-op. Fire-and-forget: kicked off from `server/index.js` after `app.listen` returns, with a top-level catch so any failure logs but doesn't crash the process. Logs progress per-row as `[logo-backfill] clients[<id>] processed → <new url>` and a summary `Succeeded=N Failed=M Skipped(cross-synced)=K` at the end.

### Decisions from the 2026-05-12 chat session

57. **The Email Campaigns customer list is AWS-verified-domain-only. The `+ New client` button is removed.** Email customers are auto-pulled from the AWS SES verified-domains list by `loadAll()` in `EmailSection.jsx` every time the page opens — that's the only path to creating an email customer now. The `+ New client` button at the bottom of the customer-list sidebar (which routed to a manual-add modal) is gone. The empty-state fallback button (`Add your first email client`, shown when `clients.length===0`) is left in place but is unreachable on the live database which always has at least one customer. The existing `'manual'` source value on `email_clients.source` (decision #41) is now effectively dead — no code path produces it any more. Migration left in place because (a) historical rows from before this rule may exist and (b) the GET /clients filter `WHERE source IS NULL OR source IN ('aws_domain', 'manual')` keeps any legacy `'manual'` rows visible until manually reclassified. **Lesson driving this:** on 2026-05-12 a stray `'Mansons'` row was discovered in the Email Campaigns list — it had been created via `+ New client` early in the project, classified as `'aws_domain'` by the migration in db.js because it had a (single, empty) email_list attached to it (the migration's `hasActivity` check counts list rows, see decision #41). The list was never used for actual sending. A single Render-shell SQL update flipped `source` to `'portal'` and deleted the empty list; the row stayed (Mansons is a real LinkedIn-side portal customer that needs the `email_clients` anchor for its portal). With the button removed, that accidental-create path is closed. **Don't reintroduce a manual-add UI.** If a future customer genuinely needs to send from a non-AWS-verified domain, the answer is to add the domain to AWS SES first — at which point the auto-sync will pick it up. The architectural invariant is: **rows in the Email Campaigns customer list ↔ AWS SES verified domains, no other source.**

58. **Campaign log terminal no longer auto-scrolls the page.** The `useEffect` in `CampaignProgress.jsx` that called `logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })` on every `logs` change was dragging the entire page to the bottom on every regen action. The original intent had been "keep the log terminal scrolled to its newest line during campaign generation" — but `scrollIntoView` walks UP the DOM and scrolls every scrollable ancestor, including the page, so the side effect was always present, just unnoticeable during initial generation when the user was already looking at the log. Spotted after the user clicked "New image" on a post and the page yanked to the bottom every time. **Fix:** the entire `useEffect` was removed along with the now-unused `logsEndRef` ref, the `useRef` import, and the dead marker `<div ref={logsEndRef}/>` at the bottom of the log terminal. A short comment was left in place explaining what was removed and why. The log terminal is now manually scrollable; new lines still appear, the page just doesn't move. Alternative considered: contain the scroll to the log terminal element only via `element.scrollTop = element.scrollHeight`. Not shipped because the user genuinely doesn't watch the log terminal during regen actions — they're watching the post card.

59. **IDYQ admin embed via signed-ticket bridge — reusable pattern for App integrations.** A new sidebar section `App` was added under the existing `Customer Portal` section, with one entry: `IDYQ` (the user's separate IdoYourQuotes product). Clicking it mounts a new component `src/components/apps/IDYQAdmin.jsx` inside the admin chrome. That component fetches a one-time URL from `GET /api/idyq-bridge/url` on the Studio backend; the backend mints a 60-second HMAC-SHA256-signed ticket `<expiry>.<nonce>.<sig>` using a shared secret `IDYQ_BRIDGE_SECRET`, returns a URL `https://idoyourquotes.com/admin-bridge?ticket=<signed>`. The component drops that URL into an iframe `src`. On the IDYQ side, a matching `/admin-bridge` endpoint verifies the ticket with the same secret (env-named `STUDIO_BRIDGE_SECRET` on IDYQ's side — same value, different env-var name to keep the directions clear), sets an IDYQ session cookie for a dedicated bridge admin user `studio-bridge@idoyourquotes.com` (created once via SQL on IDYQ's Render shell with a random bcrypt hash; this user can never log in via the IDYQ login form because no human knows the password), then 302-redirects to IDYQ's admin panel `/manage-7k9x2m4q8r`. End state: the iframe lands on IDYQ's admin panel already signed in, no double-login. **Architectural notes:** the shared secret + short-lived signed ticket is a clean, dependency-free pattern that can be reused for ANY future external admin embedded under the Studio sidebar (calendar, quoting, billing, etc.). Each integration gets its own secret pair, its own bridge admin user, its own `/admin-bridge` endpoint on the target side, and its own `/url` endpoint under `/api/<service>-bridge/` on Studio. The pattern handles three known failure modes with distinct visual signatures: (a) Studio chrome with yellow error card → Studio backend problem, most likely the secret env var isn't set; (b) blank iframe with no error → frame-blocking headers (X-Frame-Options, frame-ancestors CSP) on the target's edge — fix is one line of CSP add on the target side; (c) iframe loads to IDYQ's red Access Denied card → cookie didn't stick, either Safari/Chrome cookie partitioning (add `partitioned: true` to cookieOptions) or the bridge admin user was never created. IDYQ also explicitly chose to render an inline "Access Denied" card in its AdminPanel rather than redirect to login when session is missing — better failure mode for the embed than a blank screen. The integration shipped 2026-05-12 with the user confirming all three verification checks pre-deploy: no frame-blocking headers in IDYQ codebase, cookie is `SameSite=None; Secure` (matching every other IDYQ login path), and AdminPanel's behaviour on missing session is the inline card (no redirect).

60. **Admin reset-password supports admin-chosen passwords with random fallback.** Previously `POST /api/portal-admin/users/:id/reset-password` always generated a random temporary password via `genTempPassword()` and returned it to the admin. After a user request "I want the ability to choose the password," the endpoint now accepts an optional `{ new_password: string }` body field. If supplied, the admin-chosen value is used as the new password (validated server-side at `<8` chars matching `portal-auth.js`'s existing rule). If absent, the original random-generation behaviour fires. The response now includes a `kind: 'admin_chosen' | 'random'` field for any future consumer that wants to log the distinction (no UI uses it currently). The frontend in `PortalAdmin.jsx` `UserRow` now opens a new `ResetPasswordModal` on click (replacing the old `confirm()` dialog), with a password input + show/hide toggle, an inline "Generate random instead" button, Cancel, and primary Set password buttons. Enter submits, validation errors render inline (not via `alert()`). The existing `TempPasswordModal` is reused after success to show the new password once with copy buttons — same UX whether the password was admin-chosen or random-generated. The TempPasswordModal's "This is the only time you'll see this password" banner stays accurate in both cases: the password is bcrypt-hashed on save and there is no decrypt path. **Lesson driving this:** the user initially asked for a Render shell command to *reveal* an existing portal user's password — answered with the explanation that bcrypt hashing means the system literally cannot, plus the alternative "let me choose the password they get reset to" which became this feature. Worth recording: **customer-portal passwords are bcrypt-hashed and unrecoverable by design — never write a code path that stores or returns plaintext beyond the one-time return at creation/reset.** This is also a business asset, not just a security practice: being able to honestly say "we can't see your customers' passwords" is a stronger trust signal than "we try not to."

61. **"Refine my posts" — customer-facing post override rules with two-layer enforcement.** Customers were complaining that generated LinkedIn posts strayed onto topics they didn't want (e.g. a workshop with anxious clientele didn't want posts mentioning "stress"; an industrial customer didn't want references to machinery breakdowns). RAG-document edits weren't reliably preventing this — the LinkedIn algorithm research and the model's own judgment routinely overrode RAG nuance. **Feature shipped:** new `clients.content_rules TEXT` column (JSON-encoded array of `{id, text}`), new `Refine my posts` button in the portal header (next to the customer logo, only shown when LinkedIn is enabled), new modal `RefinePostsModal` in `PortalApp.jsx` with numbered list of rules — each row is an inline-editable textarea, delete per row, single Save button at the bottom. New endpoints `GET /api/portal/content-rules` and `PUT /api/portal/content-rules` on the portal side. Server-enforced limits: max 50 rules, max 500 chars per rule, dedup by trimmed-lowercase text, whitespace stripped. **AI enforcement is two-layer:** (a) **Prompt injection** — rules are rendered as a non-cached prompt block by `services/content-rules.js`'s `renderRulesPromptBlock(rules, { failedRules })`, inserted into both bulk generation and single-post regen prompts AFTER the cached RAG block but BEFORE the cached system prompt's continuation. The block is deliberately NOT wrapped in `cache_control: ephemeral` — this is the cache-invalidation fix for the user's explicit requirement "if they edit or delete a refine my post line then all future posts must obey by the delete/edit and not use cached info from before." Because the rules block is non-cached, every API call reads the latest `content_rules` from the client row and Anthropic re-tokenises it every time. (b) **Validation pass** — `validatePostAgainstRules(postText, rules)` in `services/content-rules.js` sends the generated post + rules to Claude Haiku 4.5 with a strict yes/no JSON-output prompt, returns `{ ok, violations: [{ruleId, ruleText, reason}] }`. Bulk generation validates all 12 posts in parallel; any failures get one retry via `regenerateSinglePost(post, client, { failedRules })` which calls out the violated rules specifically with extra emphasis. If the retry still fails, the post is kept with a `validation_warnings` array attached. Portal-side single-post regen (both `regenerate-text` and full `regenerate`) does the same validation but no retry (the customer can click Rewrite again themselves). **UI feedback** — `projectPost` in `routes/portal.js` exposes `validation_warnings` to the frontend. `PostCard` renders an amber card above the post body listing each violated rule and the AI's reason for flagging — so the customer can either edit their rules to clarify, or click Rewrite post to try again. Both decisions explicitly chosen by the user: (i) per-post regen picks up LATEST rules, not the rules at original generation time; (ii) flagged posts are visibly flagged so the customer knows what to amend. **Validation pass fails open** — any error from Haiku (network, parse, timeout) returns `{ ok: true, violations: [] }` rather than blocking the post. Validation is a safety net, not a hard gate. **Cost** — Haiku 4.5 at ~$1/MTok input / $5/MTok output, ~$0.0025 worst case per post = ~$0.030 per 12-post campaign. Negligible against the ~$0.50-1.50 a Sonnet generation costs. **Architectural notes for next chat:** the non-cached-prompt-block pattern (a separate user-message block with no `cache_control`) is the canonical way to inject content into a Claude API call that must NEVER be stale — keep this pattern in mind for any future feature where "the customer can change X and the change must apply immediately." The `MAX_VALIDATION_ATTEMPTS = 2` constant in `content-rules.js` is the cap on retries during bulk generation — raising it would multiply Sonnet token cost and is not recommended without strong evidence the second retry materially helps. The legacy `services/claude.js` is now dead code (no imports anywhere in the server) — `services/openai.js` is the sole generation path; leaving claude.js in place because changing dead code only introduces risk.

62. **Dark-background logo detection in `logo-prep.js` — escape hatch for non-light-background logos.** The trim pipeline (decision #54) assumes the logo's background is light/transparent so the corner pixel represents "background to crop." That assumption broke on The Manson Group's logo upload (2026-05-12): a JPEG with deep navy-blue background, white "THE MANSON" wordmark with subtle gradient/vignette. Sharp's `.trim({ threshold: 30 })` saw the dark corner, treated it as the reference colour, and the threshold-of-30 ended up matching irregular gradient pixels around the wordmark — cropping the "GROUP" subtitle off the bottom. Then `.flatten({ background: '#ffffff' })` painted what was left onto white, destroying the customer's branding. **Fix shipped:** new helper `medianCornerLuminance(buffer, meta)` samples the four corner pixels of opaque uploads (transparent PNGs are unaffected — their corners are by definition alpha, which is what the existing trim correctly handles), computes Rec. 601 luma per corner (0.299R + 0.587G + 0.114B), takes the MEDIAN of the four. If median luma < 120 (`DARK_BG_LUMINANCE_THRESHOLD`), the file is classified as dark-background and the trim path is SKIPPED ENTIRELY — the uploaded buffer is returned unchanged. Verified on the actual Manson file: top corners RGB(0,62,95)→luma 47, bottom corners RGB(0,42,66)→luma 32, median 39.7, well below 120. Light backgrounds read 220+; mid-grey reads ~128, so 120 cleanly separates "needs trim" from "leave alone." The decision log line `[logo-prep] Dark background detected (median corner luminance N < 120) — skipping trim, preserving original.` prints the exact median value so if a future logo lands in the 100-140 grey zone and gets the wrong classification, the right threshold is always inferable from Render logs. **Why median, not mean:** if a logo has three light corners and one dark corner (foreground element touching a corner), three-of-four lights should dominate the classification. Median-of-four = average of the two middle values, robust against a single odd corner. **Re-upload required after deploy:** the existing R2 file for any pre-fix dark-bg customer is already the wonky trimmed version. The fix prevents future damage but doesn't repair past damage — the customer logo must be re-uploaded via the admin Brand logo button to pick up the new code path. **Future enhancement (not shipped):** the compositor still places the (now untrimmed) dark-bg logo onto a WHITE panel in generated posts. If a customer specifically asks "I want my posts to use my dark brand colour for the panel instead of white," that's the "Option 3" change from the design discussion — bigger compositor change, deferred until a real complaint surfaces.

63. **Robust JSON parsing + automatic retry in `openai.js`.** A campaign generation for The Manson Group on 2026-05-12 failed with `Claude did not return valid JSON` despite the Render log showing `stop_reason: end_turn` (model thought it finished). Inspection of the response showed valid JSON with a stray non-JSON word — the literal string `Menu` — hallucinated between two key-value separators (`"angle": "...", Menu "buyer_segment": "..."`). One-off model anomaly; the JSON was otherwise complete. **Fix shipped:** three-layer defence at the module-scope helper `tryParseClaudeJSON(raw)` in `openai.js`. (1) Direct `JSON.parse`. (2) Greedy outer-object regex match `/\{[\s\S]*\}/` + parse. (3) **Repair pass** — strips stray non-JSON tokens via `match[0].replace(/,(\s*)[^"{}\[\],\s][^",{}\[\]]*?(\s+)"/g, ',$1$2"')`. The regex matches: between `,` and the next `"key":`, any non-quote/non-brace/non-bracket/non-comma token sequence, and replaces with the comma + whitespace + key opener. Deliberately conservative — only fires in JSON-structural positions where a key opener should follow a comma, so legitimate string values containing commas cannot be damaged. Critically, valid JSON parses on the first strategy so the repair never even sees its bytes — only broken JSON enters the repair path. Verified on the actual Manson failure case: the stray `Menu` is stripped and the JSON parses cleanly. Plus tested against safety cases (already-valid JSON, comma-inside-string, multiple stray tokens) — all behave correctly. **Plus automatic retry:** if all three parse strategies fail, the generation API call retries once with an appended user-message instruction: `IMPORTANT: your previous response was not valid JSON. Respond ONLY with the JSON object specified above. Do not include any other text, words, prose, or comments — not before the JSON, not after it, and not anywhere inside the JSON structure. Every character must be part of valid JSON.` Same cached context (RAG, system prompt, customer rules) — only the user-side instruction is strengthened. Most retry cases are transient model anomalies that don't repeat on a fresh call. **Plus full raw response logged on failure** — the previous error message only included `raw.slice(0, 300)`. The new code logs the FULL raw response (`console.warn` with `${raw.length} chars` prefix) every time parsing fails, so if a new anomaly type appears we can see exactly what the model produced and tune the repair regex. The same `tryParseClaudeJSON` helper is also used by `regenerateSinglePost` so per-post regen gets the same protection. The API-call helper `callClaudeForPosts(extraInstruction)` was extracted to allow clean second-attempt invocation without duplicating the streaming-with-web-search dance.

### Decisions from the 2026-05-19 chat session

64. **Per-customer Brand Panel (admin-side) — three new `clients` columns.** The Manson Group has a dark-blue logo with a built-in background, which fights the always-white panel mandated by decision #42. Rather than re-introduce auto-detection (explicitly rejected by #39/#42 — "predictability beats cleverness"), the panel is now **operator-controlled per customer**. Three additive columns on the `clients` table via boot migrations: `logo_position` (default `'bottom-right'`), `logo_panel` (default `'white'`), `logo_size` (default `'small'`). Every column defaults to the exact pre-existing behaviour, so every customer that existed before this migration is visually unchanged. The admin LinkedIn customer page ("Overview" tab, Supergrow card) gained a "Brand panel" section: three dropdowns (Position / Background / Size) with debounced 1-second auto-save and a "Saving… / ✓ Saved" indicator. `compositeLogo` in `gemini.js` reads the three settings off the client row: Position = 4 corners; Panel = white | none; Size = small (≈280×100) / medium (≈480×160) / large (≈640×220, "2× small"). The Gemini prompt's corner-clearance rule is keyed to `logo_position` so the model keeps the chosen corner clear. **This is a deliberate, operator-requested step OFF decision #42's "always-white panel, one unified path."** #42's reasoning (one input must not produce multiple outputs) still holds — the difference is the panel colour is now a stored per-customer setting, not a per-render heuristic, so it remains fully predictable: the same customer always gets the same panel. This is the deferred "dark-background logo" / "Option 3" work from decision #62's future-enhancement note and the blueprint §6.6 backlog item, picked up because a real customer (Manson) asked. Files: `server/db.js`, `server/routes/clients.js`, `server/services/gemini.js`, `src/components/ClientDetail.jsx`. **Operator-verified working** — earlier "it didn't save" reports were the operator navigating away before the 1-second debounce fired; the save itself is correct. Verification caveat recorded as lesson #62.

65. **Per-post logo controls (customer portal) — two-stage image generation + recomposite endpoint.** Building on #64, customers can now reposition/resize/re-panel the logo on an individual post WITHOUT regenerating the image (no Gemini call, no AI cost, ~½ second, does NOT count against the 30/day regen cap). To make this possible, `generateImage` in `gemini.js` was split into two stages: it now returns BOTH the pre-logo image (raw Gemini output, before any compositing) AND the final composited image. All four image-generation callers (`campaigns.js` ×2, `portal.js` ×2) upload the pre-logo bytes to R2 alongside the final image under a `-prelogo` key suffix; that upload is non-fatal if it fails. New endpoint `POST /api/portal/posts/:id/recomposite-logo` re-runs ONLY the compositor on the stored pre-logo image with per-post Position/Size/Background overrides. Returns `400 {error:'pre_logo_unavailable'}` for posts generated before this feature shipped (no stored pre-logo image — those posts must use "New image" to get one). `projectPost` exposes per-post overrides `logo_position`/`logo_size`/`logo_panel` (null = use customer default), `logo_controls_enabled` (bool), and the customer-level defaults `default_logo_position`/`default_logo_size`/`default_logo_panel`. Customer portal post card gained a 3-column dropdown row (Position / Size / Background) above the four green action buttons, dashed amber separator, "Logo on this image" label, disabled with a "Click New image to enable" hint when there's no stored pre-logo image. The image-spinner overlay is reused for the recomposite ("Updating logo… Repositioning logo — no charge."). **Every full regen path (campaign batch, single-post regen, legacy combined regen, admin per-post regen) resets all three per-post overrides to null** so a fresh image starts from the customer default, not a stale per-post override. Files: `server/services/gemini.js`, `server/routes/portal.js`, `server/routes/campaigns.js`, `src/components/customer-portal/PortalApp.jsx`. **Pending end-to-end verification** (see §"what to do first"): the recomposite flow start-to-finish, the disabled state on pre-deploy posts, the dropdowns initialising from customer-level defaults.

66. **Gemini prompt: explicit blanket ban on AI-drawn brand marks (customers WITH a logo).** Gemini was drawing a fake second brand mark (e.g. an invented "MANSON" wordmark bottom-right) that collided with the real composited logo, producing two logos per image. For every customer WITH a logo file the prompt rule was strengthened from "don't put text/subject in the [corner]" to an explicit blanket ban: do NOT include any logo, watermark, company name, brand signature, or text reading "[brand]" anywhere in the image — not in any corner, not as a decorative element, not as part of any sign, screen, label, or background. Customers WITHOUT a logo file keep the old "draw the brand name bottom-right" rule unchanged. File: `server/services/gemini.js`. **Gemini compliance is probabilistic** — if a fake mark still slips through occasionally that's a model quirk, not a rule error; a post-processing detection step would be the next-line defence (bigger build, not done). Does NOT fix existing posts — a baked-in fake mark requires a "New image" full regen to clear. **Pending verification:** confirm a freshly-generated Manson image has no AI-drawn fake brand mark.

67. **AI output sanitiser — strips stray non-Latin characters from generated post text.** A Manson post came back with stray CJK glyphs spliced mid-sentence (same family of model anomaly as the decision #63 stray-token bug — rare contamination of long structured output). New `sanitizeAiText()` helper in `openai.js` with a deliberately generous whitelist: tab/LF/CR, printable ASCII, Latin-1 Supplement + Latin Extended-A/B (é à ü ñ ç ø etc. for European customer/place names), a General Punctuation subset (em-dash, en-dash, ellipsis, curly quotes, bullet — Claude's normal style), and Currency Symbols (£ €). Everything else is stripped (CJK, Cyrillic, Arabic, Hebrew, Thai, zero-width chars, accidental emoji). Recurses through arrays and objects so a whole post object passes through. Logs a count + hex sample on strip (`[sanitize] stripped N non-Latin char(s) …`). Applied at three return points — `generatePosts`, `regenerateSinglePost`, `fixPost` — running AFTER the Haiku validation pass and just before return, so the customer never sees dirty text but validation still sees the original output. Smoke-tested with 11 cases (accented names / currency / curly quotes / ellipsis kept; Chinese / Cyrillic / Arabic / zero-width / emoji stripped) — all passed. Does NOT clean existing posts or operator/customer manual edits (only AI output going forward — manual edits are intentionally not sanitised). **Pending verification:** watch Render logs for `[sanitize]` lines after a few campaigns — frequent lines would mean the contamination is widespread and worth deeper investigation.

68. **Decision #61's customer-visible validation warning is HIDDEN but INTACT (dormant, not removed).** The yellow "This post may conflict with one of your rules" box in the customer portal is hidden via `{false && Array.isArray(post.validation_warnings) …}` in `PortalApp.jsx`. The render logic and a clear comment block are deliberately LEFT IN PLACE — re-enabling is a one-word change (delete the `false &&`). **The server-side validation pass STILL runs, STILL stores `validation_warnings`, STILL audits — only the UI surface is hidden.** Operator decision (2026-05-19), made with full pushback on record: the warnings were firing on ~90% of Manson posts because Haiku interprets rules thematically rather than literally, AND the Manson content strategy is inherently problem/pain-point driven so most posts legitimately mention a problem somewhere. So decision #61's customer-facing half is now dormant; its server-side half is unchanged. Treat #61 as "two-layer enforcement, customer-visible layer currently hidden by operator choice" — not "removed."

69. **Refine-my-posts modal: auto-growing rule textareas.** `RefineRuleRow`'s textarea now auto-grows to fit its full content (ref + useEffect: collapse to `auto` first so it can shrink, then set height to `scrollHeight`). `resize:'none'`, `overflow:'hidden'`, `rows={1}` baseline. `useRef` was added to the React import in `PortalApp.jsx`. This fixes a real bug, not just polish: long rules were clipping inside their own fixed-height textarea, so the rules-list container never overflowed and its existing `overflow:'auto'` scrollbar never engaged. With auto-grow, long rules push the list past the modal's 80vh and the single outer scrollbar engages correctly (one scrollbar for the whole list, not one per row). File: `src/components/customer-portal/PortalApp.jsx`. **Pending verification:** confirm the outer scrollbar appears with many rules and that long rules render in full.

70. **Admin Brand-panel dropdown label cleanup.** Dropped misleading sub-labels in `ClientDetail.jsx`: "No panel (logo directly on image)" → "No panel"; "Small (default)" → "Small". The "(default)" suffix was making the operator think it indicated the *current saved* value rather than the *factory default*. "Large (≈ 2× small)" was kept — it's genuinely informative about relative size, not misleading about saved state. File: `src/components/ClientDetail.jsx`.

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
- Auto-unsubscribe fires on `hard_negative` AND `soft_negative` — but ONLY when `reply.matched_campaign_id` is non-null (gated by decision #52). Random vendor mail with negative wording no longer poisons the unsubscribe list.
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

### Phase 4 multi-step sequences (BUILT and live, not schema-only)

The blueprint previously said this was schema-only. Wrong — corrected this chat.

**What's live:**
- `email_campaign_steps(id, campaign_id, step_number, subject, html_body, delay_days, created_at)` + UNIQUE on `(campaign_id, step_number)`
- `email_sends.step_number INTEGER NOT NULL DEFAULT 1` + index `(campaign_id, subscriber_id, step_number)`
- Backfill: every existing campaign auto-gets a step_1 row from its `html_body` on first boot
- Per-step subject (decision #44): `subject TEXT` column on `email_campaign_steps`. NULL = fall back to `email_campaigns.subject`.
- `sendCampaign()` accepts `stepNumber`, `bodyOverride`, and `subjectOverride` parameters
- **Drip-ticker extension is built and running.** `services/drip-ticker.js` queries the step list per campaign, finds subscribers due for step N+1 (where their last send was ≥ `delay_days` ago), and combines them with step-1 first-time candidates into the same daily burst budget. `_stepNumber` flows through the `toSendNow` array and back to `sendCampaign`.
- **Sequence editor UI is built and live.** `CampaignModal` in `EmailSection.jsx` has the tab strip ("1st contact / 2nd contact / + Add contact"), per-step body editor, per-step subject field, per-step delay-days input. Up to 10 steps, with a remove confirmation that warns if the step has already been sent to anyone.

**Still missing (real backlog for next chat):**
- **Stop-condition filter.** The drip ticker doesn't yet halt the sequence for subscribers who replied with `positive` / `soft_negative` / `hard_negative`. They keep getting follow-ups. Fix is small: extend the candidate query with `AND NOT EXISTS (SELECT 1 FROM email_replies WHERE matched_campaign_id = c.id AND from_subscriber_id = s.id AND classification IN ('positive','soft_negative','hard_negative'))`.
- **Per-step reporting in `CampaignRecipientsPanel`.** Recipients view doesn't currently show "last step sent". Useful for operators to see how far through the sequence each subscriber has reached.
- **Edit-warning toast for already-sent steps.** State is wired (sent_count > 0 flag), but the modal doesn't yet show a confirmation "this step has been sent to N people, your edit applies to the rest only" before save. Helper text shows on the step itself but doesn't gate the save.

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
- `GET /auth/check` — validates cookie, bumps idle expiry, returns `{ user, client, services }`. The `services` payload is now a map of `{state, label, pitch}` per service, not bare strings. Read sites must use `svc.linkedin?.state`, etc. ServiceGate tolerates either shape for stale-cache safety.
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
- `POST /campaigns/:id/posts/approve-all` — bulk approve. On full success: pushes posts sequentially to Supergrow as live `queue_post` calls in `posts_json` order, then sets `stage='done', status='completed', deployed_by='portal', completed_at=now()` so the campaign reaches the same terminal state as an admin push. On partial failure: stops at the first failure (no out-of-order queue), keeps stage at `awaiting_approval`, marks only the successful ones with `client_approved_at`, audits the partial state. Returns 207 with details.

History (3b-i):
- `GET /campaigns-history` — all campaigns where `stage = 'done'` for the linked LinkedIn client. `'done'` is now the single terminal stage; the legacy `'deployed'` value was migrated into `'done'+deployed_by='portal'` on next boot (decision #27). Returns full projected posts arrays so the frontend can expand a card without a second fetch.

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
service_key      TEXT PRIMARY KEY
display_name     TEXT NOT NULL
description      TEXT                            -- admin-facing operator notes
customer_pitch   TEXT                            -- customer-facing sales copy
state            TEXT NOT NULL DEFAULT 'live'    -- 'live' | 'coming_soon' | 'retired'
link_table       TEXT                             -- SQL table for picker options, NULL for plain on/off
link_label       TEXT                             -- friendly label for the picker
sort_order       INTEGER NOT NULL DEFAULT 100
created_at       TEXT NOT NULL DEFAULT (datetime('now'))
```

Currently seeded with six rows (re-seeded every boot, idempotent — wording tweaks ship via deploy with no manual DB work):
- `linkedin` → `state='live'`, `link_table='clients'`, sort 10
- `facebook` → `state='coming_soon'`, sort 20, with sales pitch
- `instagram` → `state='coming_soon'`, sort 25, with sales pitch
- `tiktok` → `state='coming_soon'`, sort 28, with sales pitch
- `facebook_pixels` → `state='coming_soon'`, sort 29, with sales pitch
- `email` → `state='live'`, `link_table='email_clients'`, sort 30, with sales pitch

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

### 1. Customer-portal smoke tests — what was verified this chat

Several end-to-end flows were tested and confirmed working in production:

- **Approve all → Supergrow live queue** ✅ Wez ran a 12-post campaign for Cube6 (and later Sweetbyte), customer clicked Approve all, posts landed in Supergrow's scheduled queue in order. Confirmed.
- **Branding tile on Settings** ✅ Was hardcoded "Tower Leasing" mock data — replaced with real client object from `/auth/check`.
- **Inbox badge for non-campaign emails** ✅ Was misleadingly applying classifier output to random INBOX traffic. Now shows neutral grey "Normal email" badge when `campaign_title` is null.
- **Customer portal grid layout** ✅ Was forced 2-column; matches admin's responsive auto-fill now.
- **Past-campaign history** ✅ Visible after deploy fix (legacy `'deployed'` rows migrated to `'done'`).
- **Customer-approved campaign read-only view** ✅ Admin opens a deployed campaign → blue banner, no regen buttons, no Re-send button. Header reads "Customer approved & sent to Supergrow."

Verified during the second 2026-05-08 session:

- **`email_clients.source` filter** ✅ After deploy and migration, Cube6/Mansons/Tower Leasing disappeared from Email Campaigns customers list while their portals continued working. Confirmed by Wez.
- **Phase 4 sequence editor** ✅ Already shipped pre-this-session — confirmed by reading the live code (the previous blueprint's "still missing" claim was stale).
- **Per-step subjects** ✅ Shipped this session; Wez has not yet sent a multi-step campaign to confirm in production but the plumbing is end-to-end (frontend → backend → DB → drip-ticker → SES `subjectOverride`).
- **Verdana 12 default** ✅ Shipped this session, not yet confirmed by recipient inspection — worth a test send to a personal address and Show original to confirm the wrap CSS is applying.
- **Customer portal post action button styling** ✅ All four buttons now solid TGA-green with white text. Shipped this session.
- **Customer portal post-action 404 bug (numeric ID + missing client_id)** ✅ Two fixes shipped this session in sequence; Wez confirmed Tower Leasing posts now respond to all four action buttons.
- **Default-sender fields on customer detail header** ✅ Shipped this session. Three fields (Default From name, Default From email, Test send address) now inline-editable with debounced auto-save. New campaigns also default Reply-to from `default_from_email`.

Still NOT confirmed end-to-end:

- **Inbox reply send via SES with threading.** Code shipped, but no verified test of a real reply landing back in Gmail/Outlook with proper `In-Reply-To` and `References` headers. Worth testing with `Show original` next chat.
- **Campaigns view with real numbers.** Code shipped, depends on the customer having real `email_campaigns` rows on their linked email_client.
- **Per-step subject end-to-end.** No production multi-step send has happened yet — drip-ticker path with `subjectOverride` is unverified by real recipient inspection.
- **Logo trim-at-upload + proportional padding + Gemini halo fix.** Shipped this session (decisions #54/#55/#53). Wez confirmed the original variance is gone after the trim moved to upload time. Tower Leasing's regenerated Cube6-style cleared zone halo confirmed visually fixed by softening the prompt rule. Padding tuning landed on proportional 20% scaling after a brief detour through fixed 40 (too generous on Cube6) and fixed 20. Final visual confirmation across multiple customers' regens still pending.
- **Default-sender persistence + auto-fill on New Campaign.** Shipped this session (decision #51). Wez confirmed both the persistence and the auto-fill behaviour after deploy.
- **Auto-unsubscribe gate on `matched_campaign_id`.** Shipped this session (decision #52). Behaviour change is silent — no UI surface — so confirmation requires watching `[classifier]` log lines on Render: lines that previously read `auto-unsubscribed N subscriber(s) matching <addr>` should now only appear for sender addresses that genuinely sent into a campaign reply.

### 2. Active polish backlog

Items raised across recent chats that are real bugs or improvements but not yet shipped:

- **Gmail spam folder isn't polled.** `imap-poller.js` opens `INBOX` only. Real campaign replies that Gmail's spam filter shoves into `[Gmail]/Spam` are invisible to the portal. Worth adding a second pass that polls Spam and surfaces matches with a "Gmail thinks this is spam — but it's a reply to your campaign" indicator.
- **Sweetbyte's logo file is a JPEG renamed to .png.** With the always-white-panel path (decision #42) and the upload-time trim+flatten (decision #54), output is now clean. Real fix is to ask the customer to upload a proper transparent PNG. Console warning shipped to surface this for future cases.
- **Mock data constants left declared.** `mockReplies`, `mockCampaigns`, `mockClient` at the top of `PortalApp.jsx` are no longer referenced — harmless unused JS but worth a small cleanup.
- **Orphan `src/components/PortalApp.jsx` (no subfolder).** The active portal lives in `src/components/customer-portal/PortalApp.jsx`. The orphan is the misplaced original from a build-failure fix and nothing imports it. Wez to delete locally on Windows.
- **Rich-text editor still uses inline padding.** Recipient-side rendering in Outlook still depends on `wrapBodyWithEmailCss`. Decision unchanged from previous chats.
- **Old un-trimmed R2 logo objects.** The boot-time backfill (#56) leaves the original raw logo files in R2 in place (it points the DB at the new trimmed file but doesn't `DeleteObject` the old one — avoids race-with-stale-frontend-tab). Storage cost is negligible at current scale; an R2 lifecycle policy could clean these up if it ever matters.

### 3. Phase 4 multi-step follow-up sequences — what's still missing

Schema, runtime, and editor UI are all live (see "Phase 4 multi-step sequences" under Current state). What's left:

**Stop-condition filter.** The drip ticker doesn't yet halt the sequence for subscribers who replied with `positive` / `soft_negative` / `hard_negative`. They keep getting follow-ups. Fix is small: extend the candidate query in `services/drip-ticker.js` with `AND NOT EXISTS (SELECT 1 FROM email_replies WHERE matched_campaign_id = c.id AND from_subscriber_id = s.id AND classification IN ('positive','soft_negative','hard_negative'))`. This is the most consequential remaining piece — without it customers keep getting nudged after they've already said no.

**Per-step reporting in `CampaignRecipientsPanel`.** Recipients view doesn't yet show "last step sent" per row. Useful for operators to see how far through the sequence each subscriber has reached. Schema supports it (`email_sends.step_number` is populated correctly).

**Edit-warning toast.** State is wired (sent_count > 0 flag flows from backend to UI per step), but the modal doesn't yet show a confirmation gate before saving an edit to a step that's already been sent. Helper text appears on the step itself but doesn't block.

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
- **Stale-brief warning** is currently 14 days. May want tuning based on observed cadence.
- **Reply send retry on transient SES failure.** Currently fails fast with a 502 + error banner. Could add 1 retry with backoff for transient throttle errors.
- **Inbox infinite scroll / search.** Capped at 100 most-recent replies. If a customer has thousands, older ones are invisible.
- **Visible feedback when a service is set to "Not required"** — subtle warning text on the Manage panel.
- **Banner at top of Manage panel when zero services are subscribed:** "This customer has no services enabled — they'll see 'Not Subscribed' on every tab."
- **Greater visual distinction for the Save Services button when dirty** — currently relies on opacity change which can be missed.

---

## Database schema (current)

Migrations run on every boot in `server/db.js`. SQLite at `/var/data/studio.db` on Render.

### Core tables (Phase 1-2)
- `email_clients` — top-level grouping. Columns: `id, name, color, slug, default_from_email, default_from_name, portal_enabled, service_email_enabled, linkedin_client_id, logo_url, logo_processed_at, source, ...`
  - `source` (decision #41): one of `'aws_domain'` (auto-pulled from / matched to AWS verified domain), `'manual'` (operator-created with non-domain name), `'portal'` (auto-anchor for a LinkedIn-only customer's portal). The Email Campaigns Customers list filters out `'portal'` rows. Migration on first boot classified all 13 existing rows.
  - `logo_processed_at` (decision #54/#56): NULL for rows where the logo file in R2 is the raw uploaded form. Non-NULL ISO timestamp once `services/logo-prep.js` has trimmed the file and the canonical pre-trimmed version is what `logo_url` points at. Boot-time backfill (#56) walks NULL rows and processes them. New uploads stamp it on success.
- `clients` — LinkedIn-side customers (separate table from `email_clients`, see decision #11). Columns include the same `logo_url` and `logo_processed_at` pair (#54/#56). Also `content_rules TEXT` (decision #61) — JSON-encoded array of `{id, text}` customer-defined override rules for post generation. NULL or empty array = no rules. Read fresh on every AI call (no caching) so edits/deletes apply immediately. Also `logo_position` (default `'bottom-right'`), `logo_panel` (default `'white'`), `logo_size` (default `'small'`) — the per-customer Brand-panel settings from decision #64, added via additive boot migrations; all default to pre-#64 behaviour so existing customers are unchanged. `compositeLogo` in `gemini.js` reads these; the per-post overrides (decision #65) are stored in `posts_json` and fall back to these customer-level defaults when null.
- `email_brands`, `email_lists`, `email_subscribers`, `email_campaigns`, `email_sends`, `email_link_clicks`, `email_campaign_links`, `email_sns_events`

### Phase 3 tables
- `email_inboxes` — Gmail mailboxes, AES-256-GCM `app_password_encrypted`, `last_uid` for IMAP poll
- `email_replies` — every email fetched, with classification fields
- `email_audit_log`

### Phase 4 — multi-step sequences (BUILT and live)
- `email_campaign_steps(id, campaign_id, step_number, subject, html_body, delay_days, created_at)` — UNIQUE on `(campaign_id, step_number)`. `subject` is NULL for steps that should fall back to `email_campaigns.subject` at send time (decision #44). Step 1 always has its subject mirrored to `email_campaigns.subject`.
- `email_sends.step_number INTEGER NOT NULL DEFAULT 1` + index `(campaign_id, subscriber_id, step_number)`

### Customer portal (FULLY LIVE)
- `client_users (id, email_client_id, username, email, password_hash, role, created_at, last_login_at)` — UNIQUE on `(email_client_id, username)`
- `client_sessions (id [token], client_user_id, expires_at, created_at)` — idle 7d, absolute 30d
- `password_resets (id [token], client_user_id, expires_at [+1h], used_at, created_at)`
- `client_login_attempts (id, email_client_id, username, attempted_at)` — for brute-force lockout
- `client_post_regens (id, email_client_id, client_user_id, campaign_id, post_id, created_at)` — for daily 30/customer regen cap
- `email_outbound (id, email_client_id, in_reply_to_reply_id, client_user_id, from_address, to_address, cc_address, subject, body_text, body_html, message_id, in_reply_to_header, references_header, sent_at, error)` — outbound SES sends from the portal reply form
- `services (service_key, display_name, description, customer_pitch, state, link_table, link_label, sort_order, created_at)` — services catalogue, six rows seeded (linkedin/facebook/instagram/tiktok/facebook_pixels/email)
- `customer_services (id, email_client_id, service_key, linked_external_id, enabled_at, enabled_by)` — subscriptions, with two UNIQUE indexes (one full, one partial-and-self-link-exempt)
- `campaigns.deployed_by` column — `'admin'` or `'portal'`. Distinguishes admin-deployed campaigns from customer-portal-deployed ones. Drives the "Customer approved" pill + read-only banner in the admin UI.

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
| `IDYQ_BRIDGE_SECRET` | shared secret for IDYQ admin embed (decision #59). Must match `STUDIO_BRIDGE_SECRET` on IDYQ's Render service. Long random hex. |
| `IDYQ_BASE_URL` | optional override for the IDYQ target URL — defaults to `https://idoyourquotes.com`. Useful for staging environments. |
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
                                      /api/idyq-bridge   → idyq-bridge.js (admin-only, App integration)
                                    Process-level uncaughtException/unhandledRejection
                                    handlers belt-and-braces against ImapFlow event
                                    emitter quirks that would otherwise terminate the
                                    process.
                                    After app.listen, kicks off backfillLogos() fire-
                                    and-forget so any pre-#54 raw logo files in R2
                                    get re-trimmed in the background (decision #56).
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
                                    Logo upload now trims via prepareLogoForStorage
                                    BEFORE the R2 PutObject (decision #54) and stamps
                                    logo_processed_at on both clients + linked
                                    email_clients rows.
    campaigns.js                  — Supergrow campaigns (NOT email_campaigns)
    email.js                      — ALL email-side routes. 2050+ lines. POST /clients
                                    auto-generates slug via db._portalUniqueSlug AND classifies
                                    new rows as 'aws_domain' (matches verified domain) or
                                    'manual'. GET /clients filters out source='portal' rows.
                                    PUT /clients/:id accepts partial-body updates and
                                    returns the full row — used by the inline-editable
                                    header fields on the customer detail page (#50/#51).
                                    PUT /campaigns/:id/steps now accepts per-step subjects.
                                    NB: export default router appears mid-file with routes
                                    after it. Works (export-binding semantics) but confusing.
    algorithm.js                  — Supergrow algorithm
    portal-auth.js                — customer-portal auth + requirePortalSession middleware
                                    Exports requirePortalSession for use by portal.js.
    portal.js                     — customer-portal data routes. ALL OF CHUNK 3b SHIPPED.
                                    15 routes: GET /posts, PUT /posts/:id, POST /posts/:id/approve,
                                    POST /posts/:id/regenerate (legacy combined), POST /posts/:id/regenerate-text,
                                    POST /posts/:id/regenerate-image, POST /campaigns/:id/posts/approve-all,
                                    GET /campaigns-history, GET /inbox, GET /replies/:id,
                                    POST /replies/:id/send, GET /campaigns,
                                    GET /content-rules, PUT /content-rules (decision #61).
                                    Both regen paths run validatePostAgainstRules after
                                    rewriting — flagged posts get validation_warnings
                                    attached for portal UI display.
    portal-admin.js               — admin-side customer-portal management. POST /customers
                                    inserts new portal anchor rows with source='portal'.
                                    The shared uploadLogoToR2 helper trims via
                                    prepareLogoForStorage before PutObject (#54). The
                                    /customers/:id/logo route stamps logo_processed_at
                                    on both email_clients + linked clients rows.
                                    POST /users/:id/reset-password accepts optional
                                    {new_password} body — admin-chosen if supplied,
                                    random generated otherwise (decision #60). Response
                                    includes kind: 'admin_chosen' | 'random'.
    idyq-bridge.js                — App integration. GET /url mints a 60-second HMAC-signed
                                    ticket using IDYQ_BRIDGE_SECRET, returns full URL
                                    pointing at IDYQ's /admin-bridge endpoint. Requires
                                    requireAuth (admin Bearer). Decision #59.
  services/
    ses.js, tracking.js, touch-count.js, crypto-vault.js, imap-poller.js,
    name-parser.js,
    classify-replies.js          — three-pass reply classifier. Auto-unsubscribe
                                    path is now gated on reply.matched_campaign_id
                                    being non-null (decision #52) so non-campaign
                                    inbox traffic can never trigger it.
    drip-ticker.js               — extends candidate list with follow-up step sends; passes
                                    each step's subject + body through to sendCampaign as
                                    subjectOverride/bodyOverride.
    gemini.js                    — Nano Banana image gen + unified-panel logo compositor
                                    (decision #42). One panel path for every logo.
                                    No trim step — that lives in logo-prep.js (#54).
                                    Padding is proportional: 20% of the logo's
                                    smaller resized dimension, floor 8px (#55).
                                    The "BOTTOM RIGHT CORNER" prompt rule was
                                    softened to stop Gemini rendering a visible
                                    cleared zone behind the panel (#53).
    logo-prep.js                 — One-shot trim at upload time. Exported
                                    prepareLogoForStorage(buffer, mimetype) →
                                    {buffer, mimetype, ext}. Used by both
                                    upload routes BEFORE R2 PutObject. SVGs
                                    pass through untouched. Decision #54.
    logo-backfill.js             — Boot-time pass that re-trims every existing
                                    logo (clients + email_clients rows where
                                    logo_processed_at IS NULL). Idempotent.
                                    Fire-and-forget from server/index.js after
                                    app.listen. Decision #56.
    content-rules.js             — "Refine my posts" support. Three exports:
                                    parseRules(client), renderRulesPromptBlock(rules, {failedRules}),
                                    validatePostAgainstRules(postText, rules) → {ok, violations}.
                                    Uses Claude Haiku 4.5 for the validation pass.
                                    Fails open on errors. Decision #61.
    claude.js (DEAD — no imports), openai.js, supergrow.js, etc.
src/
  App.jsx                         — auth + dashboard mount; mounts PortalApp at /c/<slug>;
                                    fetch interceptor excludes /api/portal/* from admin Bearer
                                    AND adds Bearer to every /api/* request including /api/idyq-bridge/
  components/
    Sidebar.jsx                   — left nav. Sections: Social Media Posts, Email Campaigns,
                                    Customer Portal, App (IDYQ — decision #59).
                                    Mailboxes badge polls every 30s.
    Dashboard.jsx                 — view router. Handles view='apps-idyq' by mounting
                                    components/apps/IDYQAdmin.jsx. Coming-soon placeholder
                                    component AdminComingSoon renders FB/Insta/TikTok/FBPixels
                                    tabs until their admin UIs ship.
    apps/
      IDYQAdmin.jsx               — embeds idoyourquotes.com/admin via signed-ticket bridge.
                                    Fetches GET /api/idyq-bridge/url on mount, drops the
                                    returned URL into an iframe. Failure modes: yellow error
                                    card (Studio backend), blank iframe (frame-blocking on
                                    IDYQ side), IDYQ Access Denied card (cookie didn't stick).
                                    Decision #59.
    EmailSection.jsx              — THE BIG ONE. 3000+ lines. Email-related everything.
                                    CampaignModal contains the Phase 4 sequence editor:
                                    tab strip ("1st contact / 2nd contact / + Add contact"),
                                    per-step subject + body + delay-days. loadAll() syncs
                                    AWS verified domains into the customers list every time
                                    the page opens.
    ClientDetail.jsx              — LinkedIn-side client detail. Logo upload here cross-syncs
                                    to portal customers.
    PortalAdmin.jsx               — admin Customer Portal management (~1200 lines)
    customer-portal/
      PortalApp.jsx               — full customer-facing portal (~2000 lines)
                                    Includes login, reset password screen, all four tabs,
                                    settings, modal forms.
    RichTextEditor.jsx            — contentEditable wrapper. Defaults to Verdana 12pt
                                    (decision #45). Toolbar has font-family + font-size
                                    pickers; operator can override per selection.
```

---

## Things that have caused pain (lessons)

1. **Always parse-check before claiming success.** EmailSection.jsx is 3000+ lines, PortalApp.jsx is 2000+. str_replace can silently delete lines if context isn't unique. Path: `/home/claude/.npm-global/lib/node_modules/tsx/node_modules/esbuild/bin/esbuild --loader:.jsx=jsx --log-level=warning <file> > /dev/null && echo OK`. Same for Node files: `node --check <file>`.

2. **str_replace + similar code blocks** — when several modals all start the same way, str_replace refuses with "found multiple times". Add 2-3 lines of unique surrounding context to disambiguate.

3. **MIME encoding bugs are subtle** — declaring quoted-printable but not actually QP-encoding the body works for ASCII but corrupts URLs. Stick with base64.

4. **The user pushes via GitHub Desktop on Windows** — can't run `npm install` themselves. If you add a dep to package.json, Render auto-installs on deploy. Don't ask user to run commands.

5. **The user values honest pushback over agreement.** When a pre-decision turns out wrong once you're knee-deep (e.g. "no posts table exists, can't extend it"), surface it. Don't silently work around. The user explicitly asked for this throughout.

6. **Big design changes deserve mockups before code.** When user asks for new UI, build interactive HTML mockups first (`visualize:show_widget` tool). Confirm direction before writing React.

7. **Browser editor visual ≠ recipient visual.** RichTextEditor uses lineHeight 1.6 and `<p>` blocks. Recipients see Outlook's `<p>` margins on top of that. `wrapBodyWithEmailCss` in ses.js compensates server-side.

8. **SQLite timestamps need timezone treatment.** `datetime('now')` returns a UTC string with a space and no Z. Browsers parse that as local time. Fix: detect format, append `Z` before constructing Date.

9. **Tool reminders / yellow toast** in claude.ai sometimes fire after long tool calls. Conversation usually still completes correctly. Tell user to refresh if it blocks.

10. **Phantom `last_uid`** — mailboxes connected pre-3.1.5 had `last_uid` set to current. Resync button forces fresh 30-day backfill.

### Lessons specific to the customer-portal work (earlier chats)

11. **Don't confuse "admin can save it" with "deployed and tested."** When Wez saves a service config, the database changes — but the customer-side portal might be cached, signed in pre-config, etc. Always tell Wez to hard-refresh (Ctrl+F5) the customer side after admin changes, especially if testing in a different tab.

12. **The two `clients` tables are a fact, not a problem to solve.** `clients` (LinkedIn) and `email_clients` (cold email) are independent. The customer portal joins them via `customer_services.linked_external_id`. This is the correct design and should NOT be merged or "cleaned up" without a major refactor that's well outside the portal scope.

13. **Self-links on `customer_services` are normal.** When a cold-email customer's portal points at its own email_clients row, that's the natural default. Don't add UNIQUE constraints that block it. The fix shipped: partial UNIQUE with `email_client_id != linked_external_id`.

14. **Generic services beats per-service columns once you hit service #3.** Adding Facebook would have been "another column"; adding SEO, Google Ads, etc. would have multiplied the cost. The `services` + `customer_services` design is now the source of truth — adding a new service is a DB insert.

15. **Backfill self-links explicitly when migrating.** When we moved from `service_email_enabled` (bool) to `customer_services` (rows with picker), every existing email-enabled customer needed a `customer_services` row pointing at itself. Without that, they'd silently lose email service on the next save. The migration handles this with `INSERT OR IGNORE` + a one-shot UPDATE for any rows already inserted with NULL.

16. **Mounting two routers at the same prefix works in Express.** `app.use('/api/portal', authRouter)` and `app.use('/api/portal', dataRouter)` both apply at the same prefix; requests cascade through them and each only matches its declared routes. The middleware `requirePortalSession` on `dataRouter` only runs for requests routed to it, not auth routes. Correct mounting order: auth first, data second.

17. **Don't fake tool calls.** I made one mistake this chat where I wrote `[USl_replace]` and "Successfully replaced string" as plain text instead of actually calling tools. No edits happened. The user caught it. **Always use real tool calls; if you see plain-text "tool result" lines without a real tool call confirmation, redo the work.**

### Lessons specific to chunk 3b (earlier chat)

18. **Read the Render logs before guessing.** When the user reported HTTP 500 on GET /posts after chunk 3b-i deploy, I spent multiple turns inspecting code looking for an import error. The actual cause was a `SELECT id, title, ... FROM campaigns` — `title` doesn't exist as a column on the `campaigns` table — and was visible in the logs immediately. Lesson: when a 500 hits, **ask for the Render log first**, don't guess from the code.

19. **`useState` calls must be above all early returns.** When extending `PortalPosts` with new state for chunk 3b-i (busy map, expandedId, bulkBusy, etc.), I initially put the new `useState` calls below the loading/error/empty early returns. React's rules-of-hooks require hooks to run in the same order on every render — putting them after a `return` violates this. Fixed by moving all hook calls to the top of the function.

20. **`generatePosts` web search was the failure mode.** On 2026-05-07, Cube6's campaign failed with "Claude did not return valid JSON: I need to conduct the required research before generating the posts." The model decided to research first and emitted a text response instead of JSON. Web search has now been removed from `generatePosts` (decision #25). The LinkedIn algorithm context comes from the stored `algorithm_brief` instead. Both `generatePosts` and `regenerateSinglePost` also got automatic JSON-parse retry — up to 2 attempts.

21. **Sidebar colour consistency was a real issue, not just aesthetic.** Admin and customer portal sidebars used different greens (`#0F6E56` vs `#0e3b2d`). Customer noticed immediately when comparing screenshots. Lesson: "consistent branding" means literal colour values, not "they're both green-ish."

22. **Mirror-the-admin meant exactly that.** The customer-portal post card had been built independently with truncated text, force-cropped 1.91:1 images, two action buttons. The admin used full text + natural-aspect images + three action buttons. Customer's instruction was "mirror the admin exactly" — which surfaced a series of decisions (separate Rewrite/New image buttons, hide "View in Supergrow", combined or separate regen cap) that needed pre-confirmation before code. Building those mockups first, getting calls on each, then writing code in one shot was the right path.

### Lessons specific to this chat (campaign desync + logo handling + services expansion)

24. **Two stages doing the same job is one too many.** Customer-portal approve-all originally wrote `stage='deployed'`, while admin deploy wrote `stage='done'`. The admin's STAGES list only knew `done`. Result: opening a customer-deployed campaign showed broken UI with active regen buttons that could overwrite live posts. Lesson: when adding a workflow that ends in the same place an existing workflow ends, **use the same terminal value and add a discriminator column** (e.g. `deployed_by`) — don't create a parallel terminal value.

25. **Stage guards belong on every endpoint that mutates campaign state.** Once a campaign is deployed (live in Supergrow's queue), edit-post, regenerate-post, and regenerate-image all need to refuse. Easy to forget one. Wez surfaced this when he opened a deployed campaign and the UI offered regen buttons that would have blown away live posts.

26. **The IMAP poller bug had been there from day one.** ImapFlow emits `error` events on the EventEmitter that, without listeners, kill the Node process. Dropped seconds of sleeping connections all the way back to Phase 3.1. Render auto-restarts the process, masking the issue — but each crash also kills the drip ticker and reply classifier. Lesson: **when seeing process restarts in Render logs, look for unhandled emitter errors before assuming it's a deploy event.** Always `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` at boot — belt-and-braces.

27. **Auto-detect logo background, don't assume a single shape.** Three real customer cases fell out from "logos" being treated as one thing: transparent PNG (Cube6), opaque white-bg PNG (Tower Leasing), JPEG-renamed-to-PNG with dark fill (Sweetbyte). The original code added a contrast patch to all of them, which produced visible artifacts on Tower Leasing and a black rectangle on Sweetbyte. Lesson: when handling user-uploaded image assets, **inspect the actual pixel data and branch on what's actually there**, don't trust file extensions or assume one canonical shape.

28. **JPEG noise is a real concern for image compositing.** Sweetbyte's JPEG had pure-white corners (255,255,255) but JPEG compression introduces mild colour noise at flat-area boundaries — values like (252,253,255) right at the edge of the wordmark. Sharp's default trim threshold (10) was too tight to catch that noise; the trimmed result had near-but-not-exactly-white edges that read as a coloured tint when composited on a dark base. Lesson: **bump trim thresholds when working with JPEGs**, and `.flatten({ background: '#ffffff' })` after trimming to kill any residual transparency that'd let the dark base bleed through.

29. **Don't flatten transparent PNGs.** Initially shipped a "flatten everything onto white" step. That broke transparent PNG logos (Cube6) — flattening turned their transparent corners into white, which made my downstream auto-detect think "this logo has its own background, skip the patch." Result: Cube6's logo dropped onto a generated image with no contrast patch behind it. Fix: branch on `srcMeta.hasAlpha` — flatten only opaque sources.

30. **The "Coming soon" pill is the wrong story to tell customers.** When the customer portal showed Instagram/TikTok/Facebook Pixels with a "Coming soon" blue pill, customers (correctly) read it as "this is in development, you can't have it yet." Wrong story — the services ARE coming soon on the platform side, but from the customer's perspective the relevant question is "do I have it." So the customer portal collapses both `coming_soon` and `not_required` into a single "Not Subscribed" state. The DB-level `coming_soon` distinction still matters for the admin's Manage panel (no checkbox available) but the customer never sees that nuance.

31. **Adding services should be DB-driven and require minimal frontend churn.** When Wez asked for Instagram + TikTok + Facebook Pixels, three new services landed via `INSERT OR IGNORE` in the seed block. The admin's Manage panel automatically picked them up. The customer portal needed three new NavItems and three new render branches — five lines per service in PortalApp.jsx. Lesson confirmed from chunk 3a: the generic services design pays off every time we add a service.

32. **Mock fallback objects must match the real shape.** When I changed `/auth/check`'s services payload from bare strings to `{state, label, pitch}` objects, I missed a default-object fallback in PortalChrome that still had the old string shape. The chrome would crash on first render before `services` arrived from the server. Fix: kept the fallback in sync. Lesson: when changing the shape of an API payload, **grep for all fallbacks/defaults** that mock the same shape on the frontend.

### Lessons specific to this chat (logo unification + source column + Phase 4 corrections)

33. **The blueprint can be wrong about what's built.** This chat opened with the blueprint stating Phase 4 was "schema only — runtime + UI not yet built". A user screenshot of the campaign modal showed the tab strip was already live with bodies, delays, and a working drip-ticker extension. Lesson: **don't trust the blueprint's "what's done" claims without verifying.** When the user says "we have tabs setup to send a 2nd and a 3rd", believe what they're seeing and grep the code before assuming the blueprint is current. The blueprint is a snapshot, not a spec.

34. **"Auto-detect" branches multiply failure modes.** Decision #38 (auto-detect logo background type, three branches) tried to be smart about Tower Leasing's white-bg logo by skipping the contrast panel. It produced inconsistent output across runs because Sharp's `.trim()` is data-dependent — the same source file produced different post-trim corner pixels on consecutive generations, flipping the branch unpredictably. Lesson reversed this chat (decision #42): **when one path can produce multiple outcomes from the same input, the answer is one path for everyone, not better detection.** A consistent panel with 20px padding works for transparent PNGs (the panel provides contrast), white-bg PNGs (the panel blends with their background), and JPEG-as-PNG broken files (the panel covers the bad fill). Predictability beats cleverness.

35. **Don't conflate "row exists" with "row is meaningful for this view."** The `email_clients` table has been used for both real cold-email customers AND portal-anchor rows for LinkedIn-only customers. The Email Campaigns Customers page listed every row indiscriminately — including portal anchors with zero email activity (Cube6, Mansons, Tower Leasing). Wez correctly read this as "LinkedIn customers got mixed into email campaigns." Fix: a `source` column on email_clients (`'aws_domain'` / `'manual'` / `'portal'`) and a `WHERE source IN ('aws_domain', 'manual')` filter on the customers query. **Lesson: when one table serves two audiences, add a discriminator column instead of trying to filter by combinations of other state.** The diagnostic SQL run on Render confirmed the data shape before the migration shipped — running diagnostics on prod data before writing migration logic is much safer than writing-then-checking.

36. **`sqlite3 < file` doesn't work when the file isn't on the server.** Wez tried `sqlite3 /var/data/studio.db < /tmp/diagnose.sql` on Render shell — the file was on his laptop, not the container. The right pattern for one-off diagnostics is: open `sqlite3 /var/data/studio.db` interactively, then paste queries one at a time at the `sqlite>` prompt. Multi-line paste into bash breaks because bash sees `.headers` and `SELECT` as commands. Lesson: **when handing off SQL diagnostics, give one query per line and confirm the user is at the `sqlite>` prompt before the SELECT.**

37. **Per-step subjects unlock the actual purpose of multi-step sequences.** Phase 4 had been built with shared subject across all steps, which sounds like a tiny detail but breaks the use-case: "Quick question, {{first_name}}" → ... → "Quick question, {{first_name}}" three weeks later doesn't feel like a follow-up, it feels like a duplicate. The send pipeline already had `bodyOverride` for the body; mirroring the pattern with `subjectOverride` was a small surgical addition. Lesson: **when extending a sequence/multi-step feature, every text the recipient sees should be per-step-overridable, not just the body.**

38. **Operator-side default and recipient-side fallback are two different config points; change them together.** When changing the rich-text editor's default font, the recipient-side `wrapBodyWithEmailCss` had to match for recipients to see what the operator typed.

### Lessons specific to this chat (logo unification round 2 + portal post-action bugs + customer-detail UX)

39. **"Predictability beats cleverness" applies twice in the same chat.** First go at the logo compositor (decision #42 v1) kept a dark-corners override and an image-bottom-right brightness heuristic — both were branches that could pick the wrong panel colour for the wrong reason. Second go (decision #42 final) ripped both out: panel is always pure white. The first version was already an improvement, but each branch I left in was another scenario where one customer's logo would land on a panel that fights it. Lesson: **when consolidating "always do X", don't half-consolidate — finish the job in one go.** Each remaining branch is a future bug report waiting to happen.

40. **Read the network request before guessing what's broken.** When Tower Leasing's "New image" button returned "Post not found", the first fix I shipped tried to handle the case where post.id was missing — based on what I saw in the code. The actual cause (visible in the browser console you sent in the next message) was the URL containing `posts/1/regenerate-image` — i.e. the id was a literal `1`, not `post_1`. A 30-second look at the browser console would have shown me the wire format up front and I'd have written the right fix on the first try. **Always ask for the network call (URL + status + response body) before guessing the bug.** Same rule that came up earlier in the project for Render logs.

41. **Bugs cascade through helper functions.** After the number-vs-string fix landed, the very next request hit a different bug in the same helper: `findPostForPortalUser` ran a SELECT that omitted `client_id`, so the regen routes downstream got `undefined` and threw "Linked LinkedIn client not found". Two bugs in one helper, surfaced one at a time as each was unblocked. Lesson: **when fixing a helper that's broken, scan its full surface area before claiming the fix is complete.** Look at every column the SELECT returns vs every column the callers use. Look at every code path that hits the helper, not just the one that surfaced the bug.

42. **One latent bug can hide behind another customer's success.** The post-action 404 bug had been latent since chunk 3b shipped — but no customer had hit it because Cube6/Sweetbyte both went straight to "Approve all" (which uses a different helper). Tower Leasing was the first customer to click any of the four per-post buttons. **When a feature appears to be working for some customers but you've never seen it work end-to-end for the actual flow, treat that as untested rather than working.** Track verified-by-real-use distinctly from shipped.

43. **Numeric IDs in JSON columns will trip up URL-param comparisons every time.** Anything stored in `posts_json` with `"id": 1` (number) will be compared against an Express URL param (string) somewhere downstream. Strict `===` will return false. **Convention going forward: when comparing IDs across the JSON-blob/URL boundary, coerce both to `String()` before comparing.** This isn't just a portal.js concern — anywhere the codebase reads numeric IDs from `posts_json` and compares them to URL params has the same risk. Worth a grep next chat: `posts_json` references where the consumer compares ids.

44. **Latent partial-SELECTs cause subtle null-prop bugs in callers far from the helper.** `findPostForPortalUser` SELECTed `id, stage, posts_json, created_at` — three of the four regen routes then accessed `campaign.client_id`. With strict mode JS that'd throw; without it, `undefined` propagates through `WHERE id = undefined` and silently returns null. **Convention: when writing a row-returning helper used by multiple consumers, default to `SELECT *` unless there's a measurable reason not to.** The cost of the extra columns is negligible; the cost of one consumer breaking on a missing column is a 30-minute debug session.

45. **Inline-editable beats modal-edit for high-frequency operator fields.** The default-sender fields lived inside the Edit Client modal — meaning every new domain required: open Customers page → click customer → click Edit → fill three fields → save → close modal → start using. Hoisting them into the customer detail header (debounced auto-save, no save button) cut that to: open Customers page → click customer → fill fields. Same pattern would help anywhere else operator state lives behind a modal. Worth scanning the rest of the admin UI for similar opportunities.

### Lessons specific to this chat (persistence + logo trim-at-upload + proportional padding + auto-unsub gate)

46. **Inline-editable fields aren't "done" when they save to the DB — they're done when the parent's in-memory state matches.** Decision #50 shipped a debounced PUT that wrote correctly to the database. But the parent's `clients` array was loaded once at page mount and never refreshed, so the New Campaign modal and the re-mounted header on customer-switch both read stale empty values. **Lesson: when adding inline-edit-with-debounced-save anywhere, also wire a "splice the response back into the parent's list" callback.** Otherwise the field appears to "not persist" the moment the user navigates anywhere — even though the bytes are safe in the DB. Same trap could apply to any future inline-editable field that doesn't already trigger a `loadAll()`. Generic guidance: **save endpoint returns the row → parent merges that row into its in-memory list → all consumers re-render with fresh values, no extra fetch.**

47. **Placeholder text in tight inline inputs reads as a saved value.** "John Wicks" as a placeholder in the Default From name field looked indistinguishable from a real saved name on first glance — operator reasonably reported "the field has ghost text I don't want." Lesson: in a row of compact inline-editable fields with small/no labels, placeholders carry signal ("there's already a value here") that's hard to suppress visually. **Default to no placeholder unless there's a clear reason** (e.g. the field's purpose isn't obvious from the label alone). Modal-style fields with full labels above can keep the example placeholders — different visual context.

48. **Sharp's `.trim()` is not idempotent on the same source bytes.** Running trim twice on the same buffer can produce subtly different results due to anti-aliasing handling at the threshold boundary. This was the root cause of the Tower Leasing "Post 1's panel is bigger than Post 2's" bug — the variance was always trim variance, not Gemini canvas variance (both posts came back at identical 1024×1024). Lesson: **treat `.trim()` as a one-shot canonicalisation step, not as something safe to run inline on every consumer.** The fix (decision #54) is structurally simple — trim once at upload time and store the trimmed buffer as canonical — but it requires a backfill (#56) for existing customers' raw files. Same shape applies to any other Sharp/image-processing operation that's data-dependent: do it once at ingest time, not per-render.

49. **"Make it bigger to look like the good one" can be the wrong fix when the good one was just the same code with cleaner inputs.** When Wez said Tower's Post 1 panel was the look he wanted, my first move was to bump padding from 20 to 40px to "match" that visual. Wrong: the 320×116 panel he liked was just what 20px padding produced around Tower's natural ~280×76 wordmark. The variance on Posts 2/3/4 wasn't smaller padding — it was the trim landing in a different spot, leaving a smaller wordmark to pad around. Once trim was canonicalised, 20px padding would have produced the same 320×116 panel on every Tower post. **Lesson: before tuning a "looks right" knob, verify whether the original variance came from the knob OR from upstream input variance. The pixel-measurement diagnostic (Python script measuring saved files) was decisive — and would have prevented two rounds of padding tuning if I'd run it earlier.**

50. **Proportional > fixed when the same pixel rule has to land across customers with different logo proportions.** Fixed-20 was tight on Tower (after trim variance fixed: 280×76 wordmark + 20px padding = 320×116, comfortable). Fixed-40 was overgenerous on Cube6 (100×100 logo + 40px padding = 180×180, too much white). There's no fixed-pixel value that works for both — different shapes need different absolute padding to feel proportional. **Solution: padding = 20% of logo's smaller dimension, floor 8px.** Tower gets ~15px (smaller dim 76), Cube6 gets ~20px (smaller dim 100), each landing in the comfortable range for that shape. **Lesson generalises:** any layout pattern that needs to feel right across multiple sources of varying intrinsic size should derive its measurements from the source's own dimensions, not from a constant.

51. **Backend gating should match frontend storytelling.** The customer-portal inbox already showed a neutral "Normal email" badge for replies with `matched_campaign_id IS NULL` — telling customers "this isn't a campaign reply, the classification is meaningless for it." But the BACKEND was happily acting on that meaningless classification by auto-unsubscribing senders. **Lesson: when the UI tells the user "we're going to ignore this," the backend should genuinely ignore it.** The fix (decision #52) was a one-liner; the diagnostic was reading the frontend to find the equivalent gating condition that was already in place there. **Generic guidance:** if you have a "this thing isn't real / doesn't apply" UI badge, grep for actions in the backend that fire on the same row category — they probably need the same gate.

### Lessons from the 2026-05-12 session

52. **Heuristic-based migrations classify wrong when the data is dirtier than the heuristic assumed.** The `email_clients.source` migration (decision #41) classified rows as `'portal'` if `portal_enabled=1 AND hasActivity=false`, where activity meant "has any list, subscriber, campaign, or inbox row." Mansons had a single empty list created by an accidental `+ New client` click weeks earlier — no subscribers, no campaigns, no inbox, but one stray list row. The classifier read `lists > 0 → hasActivity=true → 'aws_domain'`, when the operator's mental model was clearly "Mansons is LinkedIn-only, no email." Fix was one-shot SQL on Render, not a smarter migration — re-running the migration won't help because once `source` is non-NULL the migration skips the row. **Generic guidance:** heuristic-based migrations should log per-row classifications at the time they run, so you can see which rows landed where without reverse-engineering the input from current state.

53. **A UI affordance that exists "in case we need it" but has only ever been used by accident is a foot-gun, not flexibility.** The `+ New client` button in EmailSection.jsx existed from Phase 1 when email customers were manually added. Phase 1.5 onwards introduced AWS-domain auto-sync, which made the button redundant for the real workflow. The button stayed because removing it felt like reducing flexibility — but the only thing that "flexibility" actually produced across the whole project was one accidental Mansons row that we then had to clean up by hand. **Lesson: remove unused UI surfaces; if the imagined use case ever materialises, it's a one-line restore from git history.** The architectural invariant that replaces it (decision #57's "Email Campaigns customer list ↔ AWS verified domains, period") is stronger and easier to reason about than a gated escape hatch.

54. **`scrollIntoView` walks up the DOM and scrolls every scrollable ancestor — including the page.** The campaign log terminal's auto-scroll `useEffect` was designed to "keep the log scrolled to the bottom during generation," but it had the side effect of yanking the entire page down whenever a new log line was pushed via SSE — most visibly when the customer regenerated an image and the log terminal at the bottom of the page emitted `✓ Image regenerated for post 4`. Tellingly, the code already had a comment noting that local `setLogs` calls were avoided "to prevent triggering scrollIntoView on the log terminal," but the SSE stream pushed log lines on a separate code path that the comment-author hadn't considered. **Generic guidance:** if you ever want to scroll only WITHIN a container, set `element.scrollTop = element.scrollHeight` on the container itself — never `scrollIntoView` on a child, which is a whole-DOM scroll request that browsers happily satisfy by scrolling whatever's between the element and the viewport.

55. **Shared-secret signed-ticket bridges are a low-dependency way to embed external admin panels with no double-login.** Decision #59 (IDYQ admin embed) ships the pattern: a short-lived HMAC-signed ticket minted by the embedding app, verified by the target app, exchanged for a session cookie on a dedicated bridge admin user. **Generic guidance for future App integrations:** the pattern requires three new pieces per integration — (a) a `<service>-bridge` route on Studio that mints the ticket using a per-integration secret, (b) a matching `/admin-bridge` endpoint on the target side that verifies the ticket and mints a session cookie, (c) a dedicated bridge admin user on the target side with a random bcrypt hash (so the user can never log in via the target's normal login form). Three known failure modes to design for: (i) Studio backend error → use a Studio-chrome error card that names the missing env var; (ii) target-side frame-blocking headers → blank iframe — fix is one CSP line on target; (iii) cookie-not-sticking (Safari ITP, Chrome partitioning) → target shows its own access-denied card. These distinct visual signatures are debuggable; design them in deliberately.

56. **Customer-portal passwords are bcrypt-hashed and unrecoverable — by design.** The user initially asked for a Render shell command to reveal a portal user's plaintext password. The answer (correctly) was "the system literally cannot do that — there is no decrypt path, only a one-way hash." The right operational alternative is admin-chosen password reset (decision #60). **Generic guidance:** never write a code path that stores or returns plaintext passwords beyond the one-time return at creation/reset. The "we literally cannot see your password" property is also a positive business asset for the portal — it's a stronger trust signal than "we try not to look." When tempted to add a "view this user's password" admin tool, pause and ask why; the answer is always "reset it instead, here's a temporary one."

57. **The non-cached prompt-block pattern is the canonical way to ensure customer edits invalidate Anthropic's prompt cache.** Decision #61 (Refine my posts) made this explicit: when a piece of prompt content must reflect the LATEST customer-controlled state on every API call, the content goes into its own user-message block with NO `cache_control: ephemeral` wrapper, while the genuinely-static surrounding content (system prompt, RAG document) keeps its cache. Anthropic's prompt-cache is keyed on the cached prefix's exact bytes — adding/removing/editing the non-cached block doesn't invalidate the cached prefix. Result: cache savings on the static content (~90% off on cached tokens) while the customer's latest rules are always read fresh, no 5-minute TTL to wait out. **Generic guidance:** any future feature where the customer can edit X and expect "the change applies immediately to the next AI call" needs the non-cached-block pattern. If you wrap the changing content in `cache_control`, edits that occur within the 5-minute window will silently apply the OLD content to the next call, and there is no way to surface this bug except by manually testing within-window edits.

58. **Image processing pipelines need an escape hatch for inputs that violate the pipeline's assumptions.** The logo trim pipeline (decision #54) assumed "logo backgrounds are light/transparent" — and it was right for 12 customers in a row. Then The Manson Group uploaded a dark-blue-background JPEG and the pipeline silently produced a mangled output: trim cropped into the wordmark, flatten painted what was left onto white. The customer's branding was destroyed without any error being thrown — Sharp succeeded, R2 upload succeeded, the column was set. The bug was only visible by looking at the rendered logo. **Generic guidance:** for any image processing pipeline, add a CHECK BEFORE the transformation that the input matches the pipeline's assumptions. If it doesn't, fall through to a "leave it alone" path rather than damage the file. The check needs to be designed BEFORE you have a customer file that breaks the assumption — otherwise you only learn about it from a complaint. In hindsight, decision #54's design phase should have included "what if the logo isn't light-background?" as an explicit question. The fix (decision #62, median-corner-luminance threshold check) is small but the protection it offers is large — it now covers any future dark-bg customer too, not just Manson. **Pattern to apply elsewhere:** any time you write a transformation that has an implicit "the input looks like X" assumption, name the assumption out loud in a code comment AND build a runtime check that falls through to no-op when the assumption fails.

59. **For LLM JSON output, prefer multi-strategy parsing + retry over assuming clean output.** The 2026-05-12 Manson campaign failed because Claude (with `stop_reason: end_turn`, i.e. claiming to have finished cleanly) emitted otherwise-valid JSON with a hallucinated `Menu` token between two key-value pairs. One-in-thousands anomaly, but it killed the entire 12-post generation. The original code had a two-strategy parser (direct + greedy regex) and threw on failure — no logging of the raw response, no retry. Both failure modes are now covered by decision #63's three-layer parser + automatic retry with strengthened instruction + full-raw-response logging on failure. **Generic guidance:** LLM-generated structured output should always assume the LLM will occasionally produce a malformed response, even when the model claims `stop_reason: end_turn`. Three layers minimum: (1) direct parse, (2) cleanup-and-extract (markdown fences, surrounding prose), (3) one automatic retry with the response shown back to the model and a stricter instruction. And log the FULL raw response on every parse failure — debugging future cases is essentially impossible from a 300-character slice. The cost of one retry call is negligible against the cost of a failed customer-facing operation. **Pattern is also why `tryParseClaudeJSON` was hoisted to module scope** — once you have a robust parser, every JSON-consuming Claude call in the codebase should use it, not just the one that hit the bug.

### Lessons from the 2026-05-19 session

60. **"Stepping off a locked-in decision" is allowed when a real customer ask makes the decision's premise no longer hold — but the decision's *reasoning* must survive the step.** Decision #42 ("always-white panel, one unified path") and #39 ("predictability beats cleverness, finish the consolidation") were locked in hard. The Manson dark-blue-background logo gave a legitimate reason to add a non-white panel option — but the way it was done (decision #64: a stored per-customer setting, operator-controlled, defaulting to the old behaviour) preserves #42's actual reasoning. #42 was never "white is the only correct colour"; it was "one input must not yield multiple outputs from a per-render heuristic." A stored setting is still one-input-one-output — the same customer always renders the same panel. **Generic guidance:** before overriding a locked-in decision, separate the decision's *conclusion* ("panel is white") from its *reasoning* ("no per-render branching"). If the customer ask only conflicts with the conclusion, you can satisfy it with a mechanism that still honours the reasoning. If it conflicts with the reasoning itself, that's a real relitigation and needs explicit operator sign-off, not a quiet workaround. Record the step-off in the decision log either way so the next chat knows the earlier decision was deliberately amended, not forgotten.

61. **"The operator says it didn't save" can mean "the operator didn't wait for the debounce," not "the save is broken."** The Brand-panel dropdowns auto-save on a 1-second debounce. Early operator reports of "it didn't save" were the operator changing a dropdown and navigating away inside that 1-second window before the PUT fired. The save logic was correct the whole time. This is the inline-edit-debounce trap from lesson #46 wearing a different hat: #46 was "saved to DB but parent state stale"; this is "looked unsaved because the write hadn't been issued yet." **Generic guidance:** any debounced auto-save needs a *visible* state machine the operator can read — "Saving…" the instant the value changes (not when the debounce fires), then "✓ Saved" on success. If the indicator only appears when the network call starts, a fast navigate-away looks identical to a broken save. When an operator reports an inline-edit field "doesn't persist," first question is "did the indicator reach ✓ Saved before you left?" before touching any code.

62. **"Shipped and parse-checked" is not "verified" — and this session shipped an unusually large batch of the former.** Seven decisions (#64–#70) all landed parse-checked and logically reviewed, but a large fraction have explicit pending-verification flags: the per-post recomposite end-to-end flow, the no-brand-mark prompt's actual effect on Gemini output, the sanitiser's real-world log frequency, the auto-grow scrollbar behaviour. This is the lesson #42 trap ("one latent bug hides behind another customer's success") at batch scale. **Generic guidance:** when a session ships many interdependent changes touching the same customer (Manson, here), the verification surface is the *product* of the changes, not the sum — the recomposite flow depends on the two-stage split AND the R2 pre-logo upload AND the projectPost override exposure AND the portal UI, any one of which silently failing breaks the feature with no error. Track each pending item as its own line and confirm them individually against real operator use; do not collapse "all seven shipped" into "the Manson logo work is done."

63. **A new, larger RAG changed the failure characteristics of an old, "fixed" bug — fixes are validated against inputs, and the input moved.** Decision #63's `tryParseClaudeJSON` repair pass was verified against the *2026-05-12* Manson failure (stray `Menu` between key-value pairs, specific placement). This session's failure is the *same family* of anomaly (stray `Menu` token in long structured output) but the new weprintcatalogues.com RAG is much larger, producing longer 12-post JSON, and the stray token is landing in a placement the #63 regex doesn't catch — and it fails on BOTH attempts because the contamination is input-stable (same big RAG + prompt reliably reproduces it, so the retry produces the same broken output; re-running will not help). **Generic guidance:** a parser/repair fix is only proven for the input distribution it was tested against. When a major input (RAG, prompt template, model version) changes, treat every input-shape-sensitive fix as *unverified again*, not as still-solved. AND — the decisive point for the next chat — **do not extend the #63 repair regex from the truncated error message.** The thrown error only contains the first 1000 chars (clean JSON, then a cut-off). The `console.warn` at the parse-fail branch (~line 497 of this session's `openai.js`) logs the ENTIRE raw response and is the only thing that shows *where* the stray token sits — and the correct fix differs by placement (stray bare word *between* JSON tokens → strip-bare-token repair pass; stray word *inside* a string value breaking escaping → an escaping-repair pass, a completely different fix). Measure before tuning: get the full line-497 log from Render first. This is the project's oldest working principle and it applies with full force here.

---

## What to do first in next chat

0. **HIGHEST PRIORITY — the unresolved text-only Manson LinkedIn campaign JSON-parse failure (`Claude did not return valid JSON after 2 attempts`).** Symptom: campaign UI shows "Campaign failed" at ~5% ("Writing posts"). Root cause is confirmed (not guessed): the same stray-token hallucination family as decision #63, but the larger new weprintcatalogues.com RAG produces longer 12-post JSON and the stray token is landing in a placement the #63 repair regex doesn't catch. It is **input-stable** — same big RAG + Manson prompt reliably reproduces it on BOTH attempts, so the automatic retry produces the same broken output and re-running will NOT help. The 12 posts are generated fully and correctly (content is on-brand for the new RAG); only the JSON envelope fails. **Do this in strict order:**
   - **(a) DO NOT build the fix from the thrown error.** The thrown `Error` only contains the first 1000 chars (clean JSON, then a cut-off) — that is NOT enough to locate the stray token. The `console.warn` at the parse-fail branch (~line 497 of `server/services/openai.js`) logs the ENTIRE raw response: `[claude] generatePosts attempt 2 — JSON parse failed. Raw response (NNNNN chars):`. Get that FULL line from Render first. This is the project's oldest working principle — measure before tuning (lesson #18, lesson #63).
   - **(b) The fix differs by placement.** Stray bare word *between* JSON tokens (e.g. `"Text Post"Menu, "suggested_day"`) → extend `tryParseClaudeJSON` (~line 43) with a repair pass that strips bare alphabetic tokens sitting outside string values. Stray word *inside* a string value breaking escaping → a different fix entirely (an escaping-repair pass). Identify which from the full log before writing anything.
   - **(c) Practical unblock for Manson in the meantime (NOT a real fix).** Because the failure is input-stable, re-running won't help — but the anomaly correlates with output length. Either trim the Manson RAG slightly OR generate fewer posts per batch (e.g. 6 instead of 12). Shorter output makes the anomaly far less likely to trigger and gets Manson's campaign out the door while the proper `tryParseClaudeJSON` fix is built. Relevant constants: `callClaudeForPosts` ~line 413, `max_tokens: 64000`, `POSTS_PER_CAMPAIGN = 12` (~line 28 of `openai.js`).

1. **Read this whole blueprint.** The decisions list now goes up to #70 (2026-05-19 session added #64–#70). The lessons list goes up to #63 (2026-05-19 session added #60–#63). Decisions #38 and #39 are explicitly marked superseded — read #54 and #42 (final form) for the live behaviour. Decision #61's customer-visible validation warning is now hidden-but-intact (decision #68) — the server-side half still runs; only the UI is suppressed by operator choice. Decision #64 deliberately steps off #42's always-white-panel rule via an operator-controlled per-customer setting (see lesson #60 for why that's allowed without relitigating #42's reasoning). Don't trust any "20px padding" or "always white panel" mention without checking it's not from a stale comment block.

2. **Files Wez pushed at the end of the 2026-05-12 AND 2026-05-19 sessions that are awaiting end-to-end verification in production.** The files were all parse-checked and logically reviewed but real-world confirmation is still pending for several. Ask Wez which ones he tested and what worked:

   **2026-05-19 session pending verification (cluster E — verify these first, they all touch Manson):**
   - **Per-customer Brand panel (#64)** — `db.js`, `routes/clients.js`, `gemini.js`, `ClientDetail.jsx`. Admin LinkedIn customer "Overview" tab, Supergrow card, "Brand panel" section: three dropdowns (Position / Background / Size), 1-second debounced auto-save, "Saving… / ✓ Saved" indicator. **Operator-verified working** (earlier "didn't save" reports were navigating away before the debounce — see lesson #61). Confirm the three new `clients` columns migrated (`logo_position`/`logo_panel`/`logo_size`) and pre-existing customers are visually unchanged.
   - **Per-post logo controls + recomposite (#65)** — `gemini.js`, `routes/portal.js`, `routes/campaigns.js`, `PortalApp.jsx`. Customer portal post card: 3-column Position/Size/Background dropdown row above the four green buttons. Click a dropdown on a post WITH a stored pre-logo image → "Updating logo… Repositioning logo — no charge." → logo moves, no AI cost, no regen-cap hit. Posts generated before this shipped show the row disabled with "Click New image to enable" and the endpoint returns `400 {error:'pre_logo_unavailable'}`. Confirm dropdowns initialise from the customer-level defaults; confirm any full regen resets the three per-post overrides to null.
   - **No-AI-brand-mark Gemini prompt (#66)** — `gemini.js`. Generate a fresh Manson image → confirm NO AI-drawn fake "MANSON" wordmark anywhere (only the real composited logo). Compliance is probabilistic; an occasional slip is a Gemini quirk, not a rule error.
   - **AI output sanitiser (#67)** — `openai.js`. Watch Render logs over a few campaigns for `[sanitize] stripped N non-Latin char(s) …` lines. Occasional = working as intended. Frequent = the contamination is widespread and worth deeper investigation (same anomaly family as the priority-0 bug).
   - **Hidden validation warning (#68)** — `PortalApp.jsx`. Confirm the yellow "may conflict with one of your rules" box no longer appears in the customer portal, but Render logs still show the validation pass running and `validation_warnings` still stored/audited server-side. Re-enable is a one-word change (`{false &&` → remove).
   - **Auto-grow refine-rule textareas (#69)** — `PortalApp.jsx`. Open "✦ Refine my posts", add many/long rules → each textarea grows to fit its content; a single outer scrollbar engages once the list passes the modal's 80vh (not one scrollbar per row).
   - **Brand-panel dropdown label cleanup (#70)** — `ClientDetail.jsx`. Cosmetic; confirm "No panel" / "Small" / "Large (≈ 2× small)" labels read correctly and don't imply a saved value.

   **Earlier fixes from the 2026-05-12 session (cluster A):**
   - **`+ New client` button removal + Mansons SQL fix (#57)** — Email Campaigns customer list should not show Mansons. Mansons portal at `/c/<slug>` still works (only `source` flipped to `'portal'`, anchor row stayed). Wez confirmed working at the time.
   - **Campaign log no longer auto-scrolls (#58)** — Click "New image" on any post → page stays put.

   **Earlier fixes from the same session (cluster A):**
   - **`+ New client` button removal + Mansons SQL fix (#57)** — Email Campaigns customer list should not show Mansons. Mansons portal at `/c/<slug>` still works (only `source` flipped to `'portal'`, anchor row stayed). Wez confirmed working at the time.
   - **Campaign log no longer auto-scrolls (#58)** — Click "New image" on any post → page stays put.

   **Mid-session integrations (cluster B):**
   - **IDYQ admin embed (#59)** — 3 env vars across both services + 1 SQL on IDYQ + 5 files on Studio + 1 file on IDYQ. Click `App > IDYQ` in Studio sidebar → should land on IDYQ admin panel without a login prompt. The four distinct failure-mode signatures are documented in #59 so debugging is straightforward.
   - **Admin reset-password modal (#60)** — Click Reset password on any portal user → modal with password input + Show/Hide toggle + "Generate random instead" button. Min 8 chars matches portal signup.

   **Big feature from this session (cluster C):**
   - **Refine my posts (#61)** — 5 files (db.js, content-rules.js, openai.js, portal.js, PortalApp.jsx). Open any LinkedIn-enabled customer's portal. "✦ Refine my posts" button in header next to logo. Click → modal with numbered rules, add/edit/delete, Save. Add a rule like "Don't mention machinery breakdowns" → click Rewrite post → confirm rewrite doesn't violate. Render logs should show `Validating posts against your refine-my-posts rules…` and either `✓ All posts pass` or `⚠ N post(s) flagged after validation`. Flagged posts show an amber card with rule text + reason.

   **Late-session fixes triggered by the Manson Group upload (cluster D):**
   - **Dark-background logo detection (#62)** — `logo-prep.js`. Re-upload The Manson Group logo via admin Brand logo button → should arrive in customer portal and admin preview at its full original aspect ratio with "GROUP" subtitle intact. Render logs should show `[logo-prep] Dark background detected (median corner luminance N < 120) — skipping trim, preserving original.` Any future dark-background customer (military, luxury, security branding) will also benefit automatically.
   - **Robust JSON parsing + retry (#63)** — `openai.js`. Re-run the failed Manson campaign generation. Should succeed first time because the repair regex handles the `Menu`-style stray token. If a different failure type appears, the FULL raw response is now logged on parse failure (decision #63) so the next chat can see exactly what the model produced and tune the repair regex if needed.

   **Older still-unconfirmed from previous sessions:** logo backfill on first deploy (`[logo-backfill] Done. Succeeded=N` line in logs); proportional padding visual on Tower Leasing vs Cube6; Gemini halo prompt fix on Cube6; auto-unsubscribe gate (no rogue `[classifier] auto-unsubscribed` lines for non-campaign senders).

3. **The biggest remaining Phase 4 gap is the stop-condition filter.** Drip ticker keeps sending follow-ups to subscribers who already replied positive/soft_negative/hard_negative. Fix is a single `AND NOT EXISTS` clause in the candidate query in `services/drip-ticker.js`. With per-step subjects (#44) and the auto-unsub gate (#52) shipped, this is the last functional gap before Phase 4 is truly done.

4. **End-to-end verification of inbox reply-send threading.** Code shipped in chunk 3b-ii but no real reply has been verified to land back in Gmail/Outlook with proper `In-Reply-To` and `References` headers. Worth a `Show original` test next chat.

5. **Domain reputation / list verification.** During the 2026-05-12 session Wez asked about protecting domain reputation when sending to bought lists. Discussed at length — proposed priority order: (1) pre-send list verification via ZeroBounce/NeverBounce/Kickbox API at import time, (2) engagement-based suppression (auto-flag subscribers with zero opens after step 3), (3) Google Postmaster Tools enrolment + Domain Health page hardening, (4) cold-send subdomain strategy, (5) warm-up logic for new customer domains, (6) GlockApps inbox-placement testing. Nothing built yet — Wez deferred. Pick up if Wez asks; biggest single win is item 1 (list verification).

6. **Dark-background logos — the "Option 3" deferral was PICKED UP this session (decision #64), but only the operator-controlled half.** #62 preserves dark-bg logos; #64 now lets the operator choose `logo_panel = 'none'` per customer so a dark logo with its own background lands without a fighting white panel. What's still NOT built: automatic detection of the logo's own background colour to paint a *matching-colour* panel (rather than white-or-none). That fully-automatic colour-matching path remains deferred and should not be picked up without a real customer ask — and #39/#42's "no per-render heuristic" reasoning still applies if it ever is (a detected-and-painted colour is exactly the kind of per-render branching those decisions warned about; prefer extending the stored-setting model from #64 instead).

7. **Smaller backlog items** (see "What's NOT done" §2 and §7) are polish — don't pick those up before bigger pieces unless Wez asks.

8. **Operating note on the dead `services/claude.js` file.** It's no longer imported anywhere (confirmed via grep during #61 work). Leaving it in place because changing dead code only introduces risk, but if you're ever asked to "remove unused services," it's a safe deletion target — just re-run the grep first to confirm no new caller has appeared.

---

## Final word

The user is patient, curious, and a great collaborator. They put genuine effort into testing each phase and report back with screenshots + Render logs + browser console output. They want this to be a real product they could one day sell to other companies. Treat the project that way — quality matters more than speed. When in doubt, ask.

— Claude (end-of-chat handoff after the 2026-05-12 session: Email Campaigns customer list locked to AWS-verified-domains-only with `+ New client` button removed and Mansons SQL cleanup (#57); campaign-log auto-scroll removed (#58); IDYQ admin embed via signed-ticket bridge as reusable App-integration pattern (#59); admin reset-password supports admin-chosen passwords with random fallback (#60); "Refine my posts" — customer-facing override rules with non-cached prompt-block injection and Haiku validation pass (#61); dark-background logo detection escape hatch triggered by The Manson Group upload (#62); robust JSON parsing + automatic retry triggered by the same customer's campaign generation failure (#63). Blueprint updated with decisions #57-#63 and lessons #52-#59.)
