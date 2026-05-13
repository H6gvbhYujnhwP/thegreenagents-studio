# Next chat — start here

I'm continuing work on `studio.thegreenagents.com`. Two attachments are with this message: `BLUEPRINT.md` and a fresh zip of the repo.

**Read `BLUEPRINT.md` start-to-finish before doing anything else.** It captures the full architecture, every locked-in decision (63 of them), the database schema, the file map, what's been tested vs what hasn't, and the lessons learned across previous chats (59 of them). Without reading it you'll waste turns re-deriving things or re-litigating decisions that have already been settled. Decisions #38 and #39 are explicitly marked SUPERSEDED with pointers to the live behaviour — don't act on those without checking the pointer first.

After you've read the blueprint, walk through this prompt before suggesting any first move.

---

## How we work together

**About me (Wez):**
- I'm not a coder. I'm technical for ops (AWS, DNS, Google Workspace, IMAP, SES) but I don't read or write code directly.
- I push code to production by you generating files → I download them → I drop them into the repo via GitHub Desktop on Windows → Render auto-deploys.
- I can't run `npm install` or any other command. If you add a dependency to `package.json`, Render auto-installs on deploy.
- I can run SQL diagnostics on Render's shell when you give me copy-paste commands. The trick: I have to be inside `sqlite3` (prompt shows `sqlite>`), not bash (prompt shows `render@...$`). Give me ONE query per line, and confirm I'm at the `sqlite>` prompt before pasting SELECTs.
- I communicate through screenshots — Render logs, the studio UI, AWS console, error messages, browser DevTools console. Read what I send carefully and engage with what's actually shown rather than guessing.
- **Always tell me which folder a file goes in when you give me a file.** Use plain language ("goes in folder `server/services`") not technical jargon ("`./server/services/`").
- **Speak in app terms, not code jargon.** "The customer portal sidebar" not "the React NavItem component." When you do need to mention specific code (function names, file names), surround it with plain-language context.

**What I value from you:**
- **Honest pushback over agreement.** If I'm proposing something risky or a pre-decision turns out wrong once you're knee-deep in implementation, surface it. Don't sugar-coat. Don't silently work around bad assumptions. Multiple lessons in the blueprint are about times when honest pushback would have saved a turn.
- **Read the network call / Render log / browser console BEFORE guessing the bug.** When I report a 500 or a "thing not found" error, ask for the wire-level detail (URL, status code, response body, the actual error in the log) before reading code. The blueprint has lessons #18 and #40 about this — both times I burned a turn guessing what code was wrong when the network/log would have told me directly.
- **Measure before tuning.** When I report something looks "off" — too big, too small, wrong colour, wrong position — don't immediately start adjusting the knob. Measure the actual output first (pixel dimensions of saved image files, actual DOM measurements, actual byte sizes). Lesson #49 in the blueprint is about exactly this: I burned two rounds of padding tuning on the logo bug because I didn't measure the saved files until forced to. The Python-script-on-the-actual-file approach was decisive — and would have saved time if used earlier.
- **Don't bump a value to "match" a good output without checking whether the good output was just the same code with cleaner inputs.** Same lesson, different angle. If one customer's regen looks good and another's looks bad, the variance might be in the input (logo file, source data, prompt seed) rather than the parameter. Check before twisting the knob.
- **Mockups before code on bigger UI changes.** Before writing React for any new screen, build an interactive HTML mockup with `visualize:show_widget` and confirm direction with me. The blueprint covers when to do this and when to skip it.
- **Confirm decisions before building.** When a feature requires multiple choices (e.g. how to label states, where to put nav items, what wording to use on a sales pitch), present the options and let me pick. Don't just build something and ask if it's right.
- **Parse-check every file before claiming success.** Before telling me a file is ready, run a parse check. The blueprint has the exact commands. `EmailSection.jsx` is 3000+ lines and `PortalApp.jsx` is 2000+ — `str_replace` can silently delete content if context isn't unique.
- **When fixing a helper, scan its full surface area.** Lessons #41 and #44 are about latent bugs in `findPostForPortalUser` that surfaced one at a time. If you're fixing a SQL helper, look at every column the SELECT returns vs every column its callers use, before claiming the fix is complete.
- **When the UI says "we're ignoring this," the backend should genuinely ignore it.** Lesson #51 — the auto-unsubscribe gate. If there's a "Normal email" / "not applicable" / "draft" / "ignored" indicator in the frontend, grep for backend actions that fire on the same row category. They probably need the same gate.
- **Inline-edit-with-debounced-save isn't done when it saves to the DB — it's done when the parent's in-memory state matches.** Lesson #46. Any new inline-editable field needs a "splice the response back into the parent's list" callback or it'll appear to "not persist" the moment I navigate anywhere.

**How I want suggestions framed:**
- Lay out the options with their trade-offs, then say which you'd pick and why.
- One question per turn where possible. Two or three is OK if they're tightly related (A/B/C/D bullets work well). More than that and I lose track.
- Don't ask for clarification on things you can infer from the blueprint or from context I've already given. Ask only what genuinely changes the answer.

**About the work:**
- The product is studio.thegreenagents.com — a two-product platform (cold-outreach email + LinkedIn post generation) with a per-customer portal at `/c/<slug>`.
- I want this to be a real product I could one day sell to other companies. Treat the project that way — quality matters more than speed.
- Stack: Node.js + Express, React, better-sqlite3, Render hosting.

---

## What to do first

1. **Read `BLUEPRINT.md` end-to-end.** Don't skip it. Pay particular attention to the "Still NOT confirmed end-to-end" subsection — that's the live work pending verification, and it's where the most recent shipped-but-unconfirmed items live.
2. **After reading, give me a short summary of where you think things stand and what you think the priority is.** Don't write code yet. Don't ask vague clarifying questions. Tell me your read on the project so I can correct any misunderstanding before we start.
3. **Then ask me what's been tested since the last blueprint update.** The blueprint's "What to do first in next chat" section has a verification checklist organised in four clusters (A through D) from the 2026-05-12 session. The biggest cluster is **C — Refine my posts (#61)** which is a customer-facing feature affecting every LinkedIn-enabled customer portal. Cluster **D — Manson Group fixes (#62/#63)** is the most recent: dark-background logo detection in `logo-prep.js` and robust JSON parsing + retry in `openai.js`, both triggered by issues with one specific customer upload. If those work for Manson, they protect every future similar customer too. The IDYQ admin embed (#59) needs 3 env vars + SQL on a separate service before the Studio-side files do anything useful — confirm the env vars are set before assuming a bug is in the code.
4. **The biggest live functional gap is the Phase 4 stop-condition filter.** Drip ticker keeps sending follow-ups to subscribers who already replied positive/soft_negative/hard_negative. With per-step subjects (#44) and the auto-unsubscribe gate (#52) shipped, this is the last functional gap before Phase 4 is properly done. Fix is a single `AND NOT EXISTS` clause in the candidate query in `services/drip-ticker.js`. Worth tackling first unless I surface something more urgent.
5. **If I surface a bug or new task, work through it methodically.** Read the relevant files, walk me through the options, get confirmation, build, parse-check, deliver.

If you start writing code or generating files before doing steps 1–3, you've moved too fast. Slow down.
