# Next chat — customer portal backend

Save this and use it as the opening message of the next chat. Attach `BLUEPRINT.md` and a fresh zip of the repo.

---

## The prompt to paste into the next chat

> I'm continuing work on studio.thegreenagents.com. Two attachments:
>
> BLUEPRINT.md — full state of the system. Read it start to finish.
> The repo zip — current code.
>
> The frontend for a customer-login portal is already shipped at `src/components/customer-portal/PortalApp.jsx`. It mounts when the URL matches `/c/<slug>`. Right now everything is mocked — login accepts any input, posts and inbox use hardcoded data, save/approve/regen/reply only update local state. Every spot that needs a real API has a `// TODO(backend):` comment.
>
> Your job in this chat is to wire up the entire backend. Specifically:
>
> **Schema (in `server/db.js`):**
> - `client_users` table: `id, client_id, username, email, password_hash, role ('admin' or 'viewer'), created_at, last_login_at`. Unique index on `(client_id, username)` — usernames are scoped per client so two clients can both have a user called "admin".
> - `client_sessions` table: `id` (the session token), `client_user_id, expires_at, created_at`. Idle timeout 7 days, absolute timeout 30 days.
> - `password_resets` table: `id` (the reset token), `client_user_id, expires_at` (1 hour), `used_at, created_at`.
> - `client_post_approvals` or similar: tracks per-post approval state for the customer portal. Or extend the existing posts table with `client_approved_at` and `client_approved_by_user_id`.
> - Slug column on the existing `email_clients`: unique, URL-safe, auto-generated from the company name on insert.
>
> **Auth routes (`server/routes/portal-auth.js`):**
> - `GET /api/portal/by-slug/:slug` — public, returns `{ client_name, slug }` so the login page knows what name to show. Returns 404 if no client matches.
> - `POST /api/portal/auth/login` — body `{ slug, username, password }`. Returns `{ ok, user, token }` on success. Sets HttpOnly cookie. Returns generic error on failure (don't leak whether username or password was wrong).
> - `POST /api/portal/auth/logout` — clears session.
> - `GET /api/portal/auth/check` — validates the cookie, returns `{ user, client }`.
> - `POST /api/portal/auth/change-password` — body `{ old, new }`. Requires session. Hash with bcrypt.
> - `POST /api/portal/auth/forgot-password` — body `{ slug, email }`. Always returns 200 (don't leak whether email exists). Sends reset email via SES.
> - `POST /api/portal/auth/reset-password` — body `{ token, new }`.
>
> **Portal data routes (`server/routes/portal.js`):** Every endpoint MUST resolve `client_id` from the session and filter every query by it. Do not trust any `client_id` from the URL or body. Return 404 (not 403) for resources that don't belong to the caller.
> - `GET /api/portal/posts` — list of posts in the client's current campaign awaiting approval, ordered by sequence.
> - `PUT /api/portal/posts/:id` — body `{ title, body }`. Marks `approved=true` on save (per spec).
> - `POST /api/portal/posts/:id/approve` — just marks `approved=true`.
> - `POST /api/portal/posts/:id/regenerate` — calls Gemini to regen text + image. Soft cap of 30 regens per client per day.
> - `POST /api/portal/campaigns/:id/posts/approve-all` — marks every post in the campaign approved. When all posts in a campaign are approved, push them to Supergrow in the order they appear in the portal (post 1 first into Supergrow's queue, post 2 second, etc).
> - `GET /api/portal/inbox` — replies for this client's mailboxes, with classifier badges.
> - `GET /api/portal/replies/:id` — single reply detail.
> - `POST /api/portal/replies/:id/send` — body `{ cc, body }`. Sends via SES with proper `In-Reply-To` and `References` headers. Stores in a new `email_outbound` table or extend an existing one.
> - `GET /api/portal/campaigns` — read-only list of campaigns for this client with stats. Mark `tracking_off: true` on campaigns where `track_opens && track_clicks` are both false.
> - `GET /api/portal/users` — list users in this client (admin only). `POST /api/portal/users` to add. `DELETE /api/portal/users/:id` to remove.
>
> **Critical security notes:**
> - The fetch interceptor in `src/App.jsx` already excludes `/api/portal/*` from the admin token. Don't break that.
> - Every portal route should have a session middleware. Build it once, apply via `router.use(requirePortalSession)`.
> - Tenant filter on EVERY query — it's not a "if I have time" thing, it's the only thing standing between customer A seeing customer B's mailbox.
> - Use bcrypt with cost factor 12+ for password hashing.
> - Generate session tokens with `crypto.randomBytes(32).toString('base64url')`.
>
> **Pre-decisions already confirmed in the previous chat — do NOT re-ask:**
>
> 1. **Slug generation:** strip non-ASCII, lowercase, replace whitespace/non-alphanumeric runs with single dash, trim leading/trailing dashes. On collision, auto-append `-2`, `-3`, etc. (Wez accepted the trade-off that customer-facing URLs may end up looking versioned. Don't try to "improve" this.)
>
> 2. **Session storage:** SQLite, not in-memory Map. Idle 7 days, absolute 30 days.
>
> 3. **Logout scope:** current-session-only. Two refinements:
>    - Change-password (while signed in): kill all OTHER sessions, keep current.
>    - Reset-password (via email link): kill ALL sessions including the new one — the user has to sign in fresh after reset.
>
> 4. **Customer "Approve all" → Supergrow:** push as live `queue_post` (NOT `create_post`/draft). The customer's approval IS the green light — no second approval inside Supergrow. This differs from the admin-side `deployToDrafts` flow.
>
> 5. **Password reset emails:** sent via existing AWS SES setup (no new dependency), From `studio@thegreenagents.com`.
>
> **Locked-in defaults (also confirmed):**
> - Brute-force lockout: 10 failed login attempts within a 15-min window locks the username for 15 minutes.
> - Password minimum: 8 characters, no other complexity rules.
> - New customer-user provisioning: admin (Wez) sets the password via the admin UI and tells the customer out-of-band. Portal shows a "Your password is temporary — please change it" banner on first sign-in. No invite-link flow.
>
> **Build order:**
> 1. Schema first (db.js migrations — additive only, never DROP). Stop after this and let me push + verify the migrations apply cleanly to the live DB on Render before continuing.
> 2. Auth routes (`portal-auth.js`). Stop after this and verify login + logout + change-password work end-to-end.
> 3. Portal data routes (`portal.js`). Stop after each resource (posts, then inbox, then campaigns, then users) so I can push and verify each chunk.
> 4. Mount both routers in `server/index.js` and verify the existing fetch interceptor exclusion of `/api/portal/*` from the admin Bearer token still works.
>
> Don't try to do all of it in one push. The point of stopping is so I can catch a deploy failure early instead of unwinding 600 lines of changes.
>
> Also — please add `bcrypt` to package.json. Render will auto-`npm install` on next deploy.
>
> Read BLUEPRINT.md and the portal frontend file before writing any code, then start with the schema migration.

---

## Notes for the chat that opens this prompt

- The frontend file at `src/components/customer-portal/PortalApp.jsx` is the source of truth for API shapes. Every `// TODO(backend):` comment specifies exactly what the React expects. Match those shapes exactly — don't invent new ones.
- Wez pushes code via GitHub Desktop on Windows. Don't ask him to run npm commands; Render auto-installs.
- Wez values honest pushback. If a pre-decision turns out to be wrong once you're knee-deep in the code, say so — don't silently work around it.
- `bcrypt` is the one new dependency you'll need. It compiles native code so add it to `package.json`'s `dependencies` and let Render's build step install it; don't try anything fancy with `bcryptjs` (the pure-JS port) unless `bcrypt` itself fails to build.
