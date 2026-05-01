/**
 * tracking.js — Own-domain open/click tracking, exactly like Sendy.
 *
 * Sendy approach:
 *   - Open: injects <img src="t.php?i=subId&e=campId"> at end of HTML body
 *   - Click: rewrites every <a href> to l.php?i=...&campaign=...&url=...
 *   - Both endpoints live on the user's own domain (no awstrack.me)
 *
 * Our approach is identical, with one improvement:
 *   - Click links use a hash of (campaignId, url) so the email URLs stay short
 *     and the destination URL is looked up server-side. Sendy puts the full
 *     URL in the query string which makes emails ugly and can break with
 *     special characters.
 *
 * IMPORTANT: All tracking endpoints must be PUBLIC (no auth) — they're hit by
 * the recipient's email client, not the logged-in user.
 */

import crypto from 'crypto';
import db from '../db.js';

// ── Link hash (deterministic, short) ─────────────────────────────────────────
// Same campaign + same URL = same hash, so we don't bloat the links table.
function linkHash(campaignId, url) {
  return crypto.createHash('sha1').update(`${campaignId}|${url}`).digest('hex').slice(0, 12);
}

// ── Register a link in the campaign's link table ─────────────────────────────
// Returns the hash. Inserts only if not already present for this campaign.
function registerLink(campaignId, url) {
  const hash = linkHash(campaignId, url);
  db.prepare(`INSERT OR IGNORE INTO email_campaign_links (hash, campaign_id, url, created_at)
              VALUES (?, ?, ?, datetime('now'))`).run(hash, campaignId, url);
  return hash;
}

// ── Open tracking pixel ──────────────────────────────────────────────────────
// Injected just before </body>, or appended if no </body> tag.
export function buildOpenPixel({ baseUrl, campaignId, subscriberId }) {
  const url = `${baseUrl}/api/email/track/open/${campaignId}/${subscriberId}.gif`;
  // 1x1, alt empty, hidden styles for picky clients (still triggers on load)
  return `<img src="${url}" width="1" height="1" border="0" alt="" style="height:1px !important;width:1px !important;border-width:0 !important;margin:0 !important;padding:0 !important;display:block;" />`;
}

// ── Inject open pixel into HTML body ─────────────────────────────────────────
function injectOpenPixel(html, pixel) {
  if (!html) return pixel;
  // Prefer just before </body> for max compatibility
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${pixel}</body>`);
  // Otherwise just append
  return html + pixel;
}

// ── Rewrite all <a href="..."> links to tracking URLs ────────────────────────
// Skips: mailto:, tel:, # anchors, javascript:, our own unsubscribe link,
// and any URL already pointing at our tracking endpoints (defensive).
function rewriteLinks(html, { baseUrl, campaignId, subscriberId }) {
  if (!html) return html;

  return html.replace(/<a\s+([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>/gi,
    (full, before, quote, url, after) => {
      // Skip non-trackable schemes
      if (/^(mailto:|tel:|#|javascript:|data:)/i.test(url)) return full;
      // Skip empty
      if (!url.trim()) return full;
      // Skip our own tracking + unsubscribe URLs
      if (url.includes('/api/email/track/') || url.includes('/api/email/unsubscribe')) return full;

      // Decode any HTML entities in the URL before hashing/storing
      const cleanUrl = url.replace(/&amp;/g, '&');
      const hash = registerLink(campaignId, cleanUrl);
      const tracked = `${baseUrl}/api/email/track/click/${campaignId}/${subscriberId}/${hash}`;
      return `<a ${before}href=${quote}${tracked}${quote}${after}>`;
    });
}

// ── Append unsubscribe footer ────────────────────────────────────────────────
// Header-only mode: we rely on the List-Unsubscribe MIME headers (RFC 8058)
// to provide the unsubscribe path. Gmail and modern Outlook render their own
// native "Unsubscribe" button next to the sender name when those headers are
// present, so a visible footer is no longer added. The legal/RFC obligation
// is satisfied by the headers alone. If you need a visible footer back for
// B2C lists where some recipients use older clients without header support,
// flip the flag below to true.
const SHOW_VISIBLE_UNSUB_FOOTER = false;

function appendUnsubFooter(html, { baseUrl, campaignId, subscriberId }) {
  if (!html) return html;
  if (!SHOW_VISIBLE_UNSUB_FOOTER) return html;
  // If campaign HTML already contains an unsubscribe link, leave it alone
  if (/unsubscribe/i.test(html)) return html;

  const unsubUrl = `${baseUrl}/api/email/unsubscribe?sid=${subscriberId}&cid=${campaignId}`;
  const footer = `<p style="margin-top:32px;font-size:11px;color:#999;text-align:center;"><a href="${unsubUrl}" style="color:#999;">Unsubscribe</a></p>`;

  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${footer}</body>`);
  return html + footer;
}

// ── Main: prepare HTML for tracked send ──────────────────────────────────────
// This is what ses.js calls before SES SendRawEmail.
// Each tracking signal (open pixel / click rewrite / unsub footer) is opt-in
// via its own boolean flag — caller decides per-recipient which to apply.
//
// Note: the visible unsub footer is OFF by default at the module level
// (SHOW_VISIBLE_UNSUB_FOOTER=false). Even with track_unsub=true here we only
// inject the visible footer when that constant is on. The List-Unsubscribe
// MIME header is added separately in ses.js based on the same track_unsub flag.
export function applyTracking(html, opts) {
  const { baseUrl, campaignId, subscriberId,
          track_opens = false, track_clicks = false, track_unsub = false } = opts;
  if (!campaignId || !subscriberId) return html; // safety — no tracking on test sends
  let out = html || '';
  if (track_unsub)  out = appendUnsubFooter(out, { baseUrl, campaignId, subscriberId });
  if (track_clicks) out = rewriteLinks(out, { baseUrl, campaignId, subscriberId });
  if (track_opens) {
    const pixel = buildOpenPixel({ baseUrl, campaignId, subscriberId });
    out = injectOpenPixel(out, pixel);
  }
  return out;
}

// ── Look up the destination URL for a click hash ─────────────────────────────
export function getLinkUrl(campaignId, hash) {
  const row = db.prepare(`SELECT url FROM email_campaign_links WHERE campaign_id=? AND hash=?`)
    .get(campaignId, hash);
  return row ? row.url : null;
}

// ── 1x1 transparent GIF as a Buffer (cheap, no disk IO) ──────────────────────
export const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);
