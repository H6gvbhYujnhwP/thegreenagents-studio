# WorkTrackr ↔ IdoYourQuotes (IDYQ) — data integration brief

Portable spec for connecting **WorkTrackr** (the puller) to **IdoYourQuotes / IDYQ**
(`https://idoyourquotes.com`, the source). Goal: WorkTrackr pulls, server-to-server,
**read-only**: (1) quotes with line items + customer, (2) the product catalogue.

This is a NEW data API, separate from the existing Studio↔IDYQ admin **iframe** bridge
(that one is a signed-ticket login bridge, not a data API — leave it untouched).

Paste the relevant prompt into each app's Claude chat. Keep this file as the single
source of truth for the contract so both sides line up.

---

## Shared security model (reuse Studio's pattern)

- A new shared secret env var on **both** apps: `WORKTRACKR_BRIDGE_SECRET` (long random hex).
  **Separate from** Studio's `IDYQ_BRIDGE_SECRET` — different relationship, different secret.
  Never hardcode; env vars only.
- WorkTrackr signs every request to IDYQ:
  - payload = `"<expiryUnixSeconds>.<nonce>.<METHOD>.<PATH>"`
  - `sig = HMAC-SHA256(WORKTRACKR_BRIDGE_SECRET, payload)` (hex)
  - header: `X-WT-Signature: <expiry>.<nonce>.<sig>`
  - expiry ≈ 60–120s out (same idea as Studio's 60s bridge ticket).
- IDYQ verifies: recompute the HMAC, constant-time compare, reject if mismatched or expired.
- `IDYQ_BASE_URL` env on WorkTrackr (default `https://idoyourquotes.com`).

## API contract (IDYQ exposes, WorkTrackr calls — all GET, read-only)

- `GET /api/external/catalogue?since=<ISO>&page=<n>`
  → `{ products: [{ id, sku, name, description, unit_price, currency, category, active, updated_at }], next_page }`
- `GET /api/external/quotes?since=<ISO>&status=&page=<n>`
  → `{ quotes: [{ id, quote_number, status, currency, total, customer:{name,email,company}, line_items:[{ product_id, sku, description, qty, unit_price, line_total }], created_at, updated_at }], next_page }`
- `GET /api/external/quotes/:id`
  → `{ quote: { …full quote as above… } }`

`since` = incremental pull (only rows changed after that time). Upsert by IDYQ `id`
so re-pulling is idempotent. Paginate via `next_page`.

> ⚠️ Field names above are a PROPOSED shape. Confirm IDYQ's real quote/catalogue
> fields and adjust this contract before either side finalises parsing.

---

## Prompt for the WORKTRACKR chat

```
I want to connect this app (WorkTrackr) to my other app, IdoYourQuotes (IDYQ, at
https://idoyourquotes.com), so WorkTrackr can PULL two things from IDYQ,
server-to-server (read-only): (1) Quotes with line items + customer details,
(2) the product catalogue.

Before writing any code:
1) Read WorkTrackr's blueprint/working notes and tell me its stack (server framework,
   DB) and where pulled data should live. Don't assume.
2) Reuse this security model (matches my Studio↔IDYQ setup): a new env var
   WORKTRACKR_BRIDGE_SECRET (long random hex, shared with IDYQ; do NOT reuse Studio's
   IDYQ_BRIDGE_SECRET). Plus IDYQ_BASE_URL (default https://idoyourquotes.com). Sign
   every request to IDYQ: payload "<expiryUnixSeconds>.<nonce>.<METHOD>.<PATH>",
   HMAC-SHA256 with the shared secret, send header
   X-WT-Signature: <expiry>.<nonce>.<hmac-hex>  (expiry 60–120s out). Never hardcode secrets.
3) Build the WorkTrackr side only: a small "idyq client" module that signs + fetches;
   a catalogue sync (on-demand + periodic) and a quotes pull (on-demand by quote number
   + incremental via ?since=<ISO>); upsert by IDYQ id (idempotent); handle pagination;
   map into WorkTrackr's own models and show me where it lands.
4) Endpoints WorkTrackr will call on IDYQ (I'll have these built on the IDYQ side —
   confirm exact response shapes with me before finalising parsing):
   - GET /api/external/catalogue?since=&page=
       → products: { id, sku, name, description, unit_price, currency, category, active, updated_at }
   - GET /api/external/quotes?since=&status=&page=
       → quotes: { id, quote_number, status, currency, total, customer:{name,email,company},
         line_items:[{product_id,sku,description,qty,unit_price,line_total}], created_at, updated_at }
   - GET /api/external/quotes/:id  → one full quote
Propose the approach, the files you'd add, and any questions, BEFORE writing code.
Keep secrets in env vars. Tell me anything you need from the IDYQ side.
```

## Prompt for the IDYQ chat

```
I want IdoYourQuotes (IDYQ) to expose a small READ-ONLY data API so my other app,
WorkTrackr, can pull: (1) Quotes with line items + customer, (2) the product
catalogue — server-to-server.

Before writing code:
1) Read IDYQ's blueprint/working notes; tell me the stack and where quotes and products
   live (tables/models). Don't assume.
2) Security: add env var WORKTRACKR_BRIDGE_SECRET (long random hex, shared with
   WorkTrackr; SEPARATE from the existing Studio admin-bridge secret — do not reuse it).
   Verify every request to the new endpoints: read header
   X-WT-Signature: <expiry>.<nonce>.<hmac-hex>; recompute HMAC-SHA256 over
   "<expiry>.<nonce>.<METHOD>.<PATH>" with WORKTRACKR_BRIDGE_SECRET; reject on mismatch
   or past expiry (allow ~120s); constant-time compare.
3) Build these READ-ONLY endpoints (no writes), mapping from IDYQ's real data — confirm
   field names with me:
   - GET /api/external/catalogue?since=&page=
       → { products:[{ id, sku, name, description, unit_price, currency, category, active, updated_at }], next_page }
   - GET /api/external/quotes?since=&status=&page=
       → { quotes:[{ id, quote_number, status, currency, total, customer:{name,email,company},
         line_items:[{product_id,sku,description,qty,unit_price,line_total}], created_at, updated_at }], next_page }
   - GET /api/external/quotes/:id  → { quote: {…full…} }
   Support ?since=<ISO> incremental + pagination. Read-only; never expose write/delete.
4) Do NOT touch the existing Studio admin-bridge (/admin-bridge). This is a new, separate surface.
Propose approach + files + questions BEFORE coding. Secrets in env only.
```

---

## Open items to confirm
- Real IDYQ data shapes for quotes + catalogue (the field lists above are proposed).
- Generate `WORKTRACKR_BRIDGE_SECRET` once; set the SAME value on both apps' Render envs.
- Decide WorkTrackr's pull cadence (catalogue periodic + quotes on-demand vs scheduled).
