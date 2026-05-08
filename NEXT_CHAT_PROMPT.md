# Next chat — start here

I'm continuing work on `studio.thegreenagents.com`. Two attachments are with this message: `BLUEPRINT.md` and a fresh zip of the repo.

**Read `BLUEPRINT.md` start-to-finish before doing anything else.** It captures the full architecture, every locked-in decision (50 of them), the database schema, the file map, what's been tested vs what hasn't, and the lessons learned across previous chats. Without reading it you'll waste turns re-deriving things or re-litigating decisions that have already been settled.

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
- **Mockups before code on bigger UI changes.** Before writing React for any new screen, build an interactive HTML mockup with `visualize:show_widget` and confirm direction with me. The blueprint covers when to do this and when to skip it.
- **Confirm decisions before building.** When a feature requires multiple choices (e.g. how to label states, where to put nav items, what wording to use on a sales pitch), present the options and let me pick. Don't just build something and ask if it's right.
- **Parse-check every file before claiming success.** Before telling me a file is ready, run a parse check. The blueprint has the exact commands. `EmailSection.jsx` is 3000+ lines and `PortalApp.jsx` is 2000+ — `str_replace` can silently delete content if context isn't unique.
- **When fixing a helper, scan its full surface area.** Lessons #41 and #44 are about latent bugs in `findPostForPortalUser` that surfaced one at a time. If you're fixing a SQL helper, look at every column the SELECT returns vs every column its callers use, before claiming the fix is complete.

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

1. **Read `BLUEPRINT.md` end-to-end.** Don't skip it.
2. **After reading, give me a short summary of where you think things stand and what you think the priority is.** Don't write code yet. Don't ask vague clarifying questions. Tell me your read on the project so I can correct any misunderstanding before we start.
3. **Then ask me what's been tested since the last blueprint update.** Specifically the items in the blueprint's "Still NOT confirmed end-to-end" section. There are several things shipped at the end of the previous session that haven't been verified in production yet — including the most recent active issue (logo panel size variance on Tower Leasing's regenerated posts).
4. **If I surface a bug or new task, work through it methodically.** Read the relevant files, walk me through the options, get confirmation, build, parse-check, deliver.

If you start writing code or generating files before doing steps 1–3, you've moved too fast. Slow down.
