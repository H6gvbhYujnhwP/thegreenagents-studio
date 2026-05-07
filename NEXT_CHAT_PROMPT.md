I'm continuing work on studio.thegreenagents.com. Two attachments:
BLUEPRINT.md — full state of the system. **Read it start to finish before writing any code.**
The repo zip — current code.

The customer portal is now functionally complete. Chunks 3b-i (post mutations + Supergrow approve-all push), 3b-ii (inbox + reply send), and 3b-iii (campaigns view) are all shipped. Past-campaign history is shipped. The customer-portal post card mirrors the admin layout exactly. Sidebar branding is unified across admin and portal. Logo lives at `public/tga-logo.png`. The post-generation reliability fix (no web search, JSON-parse retry, stale-brief warning) is shipped.

**Don't add features. Start by asking what's been tested.**

The previous chat ended after writing parse-clean code for everything above, but real-world end-to-end smoke tests of each piece may not have completed. Your first job is to ask Wez exactly what's been verified and what hasn't. Likely candidates that need testing:

- **Approve all → Supergrow live queue.** The customer clicks "Approve all remaining" → all posts push to Supergrow as live `queue_post` calls in posts_json order → campaign stage flips to `deployed` → posts appear in Supergrow's scheduled queue.
- **Inbox reply send.** Customer reads a received reply → clicks Reply → composes → SES sends from the mailbox the original arrived on → recipient gets a properly-threaded reply (visible via Gmail/Outlook "show original": `In-Reply-To` and `References` headers should reference the inbound `message_id`).
- **Campaigns view with real data.** Customer sees their actual email campaigns with sent/opens/clicks/replies counts, status badges, tracking-off indicator.
- **Past campaigns history.** Customer sees deployed campaigns below the current-batch grid; clicking expands to show all posts read-only.
- **Post regeneration cycle.** Customer clicks "Rewrite post" → spinner overlay → new text appears, approval dropped. Same for "New image". Both count toward the same 30/day cap.

If anything's broken, fix that before considering new work.

**If everything's working, the next priority is Phase 4 multi-step follow-up sequences.** Schema is in (`email_campaign_steps` table + `email_sends.step_number`). Runtime + UI are not built. Four pre-decisions need confirming with Wez before writing code (see "Phase 4 multi-step sequences" in the blueprint). Build a mockup of the sequence editor first per the lessons-learned guidance — don't write React until Wez has seen and confirmed the layout.

**A few things already locked in — don't re-ask:**

- Per-post approval state lives INSIDE `posts_json` (`client_approved_at`, `client_approved_by_user_id` on each post object).
- Customer Approve-all → Supergrow live `queue_post`, not draft.
- Regen rate limit: combined 30/customer/day across both text and image regens (same `client_post_regens` table).
- Customer-portal reply send uses the mailbox the original arrived on as the From address.
- Web search has been removed from `generatePosts` — algorithm context comes from the stored `algorithm_brief` (admin "LinkedIn Algorithm" button).
- Customer portal mirrors admin post-card layout exactly. Don't simplify or "improve" it without re-asking.
- "View in Supergrow" links are hidden from customers everywhere.
- Sidebar background is `#0F6E56` on both admin and customer portal — they should look visually identical at the top-left.

**Honest pushback is welcome.** If a pre-decision turns out wrong once you're knee-deep in the code, say so — don't silently work around. Wez pushes code via GitHub Desktop on Windows so don't ask him to run npm. If you add a dep to package.json, Render will auto-install on next deploy.

**Always tell Wez the destination folder for each file you produce in plain text.** He asked for this in the previous chat. Don't make him guess where `portal.js` goes vs `PortalApp.jsx` vs `tga-logo.png`.

Read BLUEPRINT.md first, then ask Wez what's been tested before writing any code.
