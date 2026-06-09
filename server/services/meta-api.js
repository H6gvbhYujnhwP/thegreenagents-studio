// ─────────────────────────────────────────────────────────────────────────────
// Meta Marketing API — the ONE place in Studio that talks to Facebook.
//
// Everything else (routes, the boot-time connection check, later stages that
// read ads / write budgets / push creatives) goes through this file. Keeping
// all Meta calls in one module means there's a single place to handle auth,
// request signing, the API version, and error shaping.
//
// Credentials live ONLY in Render env vars (never in code, never in chat):
//   META_ACCESS_TOKEN   — long-lived system-user token (set to never expire)
//   META_APP_SECRET     — used to sign every call with an appsecret_proof
//   META_APP_ID         — Meta app id (not secret)
//   META_BUSINESS_ID    — the Green Agents business id (not secret)
//   META_API_VERSION    — graph version, e.g. 'v25.0' (override when v26 lands)
//   META_AD_ACCOUNT_ID  — OPTIONAL override. Defaults to the WDYQ test account
//                         below, which is the account the test ads live in.
//
// Money note for later stages: Meta amounts are in MINOR units (pence for GBP).
// We store budgets as whole pence in the DB; the customer screen converts to £.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

// The Green Agents ad account where the WDYQ test ads currently live. It isn't
// a secret (only the token + app secret are), so a sensible default lives here
// and can be overridden per-environment via META_AD_ACCOUNT_ID without a deploy.
const DEFAULT_AD_ACCOUNT_ID = '1754809155683350';

// Read env fresh each call rather than caching at import time, so a Render env
// change followed by a restart is always picked up (and tests can override).
function cfg() {
  return {
    accessToken: process.env.META_ACCESS_TOKEN || '',
    appSecret:   process.env.META_APP_SECRET || '',
    appId:       process.env.META_APP_ID || '',
    businessId:  process.env.META_BUSINESS_ID || '',
    apiVersion:  process.env.META_API_VERSION || 'v25.0',
    adAccountId: process.env.META_AD_ACCOUNT_ID || DEFAULT_AD_ACCOUNT_ID,
  };
}

// A small read-only snapshot of the non-secret config, handy for routes/logs.
// Deliberately does NOT expose the token or the app secret.
export const META = {
  get apiVersion() { return cfg().apiVersion; },
  get appId()      { return cfg().appId; },
  get businessId() { return cfg().businessId; },
  get adAccountId(){ return cfg().adAccountId; },
};

// Configured = we at least have a token to call with. Without it, every Meta
// call is pointless, so callers short-circuit on this.
export function metaConfigured() {
  return !!cfg().accessToken;
}

// appsecret_proof is Meta's tamper-check: an HMAC-SHA256 of the access token
// keyed by the app secret, sent alongside the token. Only added when the app
// secret is present (it's strongly recommended by Meta, not strictly required).
export function appsecretProof(token, appSecret) {
  if (!appSecret) return null;
  return crypto.createHmac('sha256', appSecret).update(token).digest('hex');
}

// Core request helper. Builds the Graph API URL for the given version, attaches
// the access token + appsecret_proof, sends the request, and returns parsed
// JSON. Throws an Error carrying Meta's own error message on any failure, so
// callers and the Render log get a useful line rather than a bare 400.
//
//   path   — graph path WITHOUT a leading slash, e.g. 'act_123?fields=name'
//            (or pass `params` instead of inlining a query string)
//   method — 'GET' (default), 'POST', 'DELETE'
//   params — object of query-string params (merged with token + proof)
//   body   — object sent as form-encoded body for POST (Meta expects form, not JSON)
export async function metaRequest(path, { method = 'GET', params = {}, body = null } = {}) {
  const c = cfg();
  if (!c.accessToken) throw new Error('META_ACCESS_TOKEN is not set');

  const base = `https://graph.facebook.com/${c.apiVersion}/`;
  const url = new URL(path.replace(/^\//, ''), base);

  // Auth params on every request.
  const query = { access_token: c.accessToken, ...params };
  const proof = appsecretProof(c.accessToken, c.appSecret);
  if (proof) query.appsecret_proof = proof;
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const init = { method };
  if (body && (method === 'POST' || method === 'DELETE')) {
    // Meta's Graph API takes form-encoded POST bodies. The token + proof stay
    // in the query string (where Meta reads them from regardless of method).
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null) form.set(k, String(v));
    }
    init.body = form;
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  }

  let res, json;
  try {
    res = await fetch(url, init);            // Node 22 has global fetch — no dependency
  } catch (netErr) {
    throw new Error(`network error reaching Facebook: ${netErr && netErr.message ? netErr.message : netErr}`);
  }

  const text = await res.text();
  try { json = text ? JSON.parse(text) : {}; }
  catch { json = { _raw: text }; }

  // Meta signals errors either via a non-2xx status or an `error` object in the
  // body (sometimes both). Surface its message verbatim.
  if (!res.ok || (json && json.error)) {
    const e = (json && json.error) || {};
    const msg = e.message || `HTTP ${res.status}`;
    const detail = e.error_user_msg ? ` (${e.error_user_msg})` : '';
    throw new Error(`${msg}${detail}`);
  }

  return json;
}

// Fetch one ad account by id. Used by the connection test and later stages.
// Pass the bare numeric id; the `act_` prefix is added here.
export async function getAdAccount(adAccountId = cfg().adAccountId) {
  const id = String(adAccountId).replace(/^act_/, '');
  return metaRequest(`act_${id}`, {
    params: { fields: 'name,account_status,currency,amount_spent,timezone_name' },
  });
}

// List the ad accounts on the configured business. Not used by the Stage-1
// connection test (we test the specific account instead), but handy for later.
export async function listAdAccounts() {
  const c = cfg();
  if (!c.businessId) throw new Error('META_BUSINESS_ID is not set');
  return metaRequest(`${c.businessId}/owned_ad_accounts`, {
    params: { fields: 'id,name,account_status,currency', limit: 100 },
  });
}

// The connection test the boot log and /connection-status both use. It fetches
// the specific ad account we'll actually run ads in — proving in one call that
// (a) the token works, (b) it has ads access, and (c) it can see that account.
// Returns a plain result object; never throws (failures come back as ok:false).
export async function testConnection() {
  try {
    const acct = await getAdAccount();
    return {
      ok: true,
      account: {
        id: `act_${cfg().adAccountId}`,
        name: acct.name || '(unnamed account)',
        account_status: acct.account_status,
        currency: acct.currency || null,
      },
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}
