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

// ── Append unsubscribe footer if not already present ─────────────────────────
// Mirrors Sendy: every campaign email gets an unsubscribe link.
function appendUnsubFooter(html, { baseUrl, campaignId, subscriberId }) {
  if (!html) return html;
  // If campaign HTML already contains an unsubscribe link, leave it alone
  if (/unsubscribe/i.test(html)) return html;

  const unsubUrl = `${baseUrl}/api/email/unsubscribe?sid=${subscriberId}&cid=${campaignId}`;
  const footer = `<p style="margin-top:32px;font-size:11px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:16px;">You are receiving this because you subscribed to our list. <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a></p>`;

  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${footer}</body>`);
  return html + footer;
}

// ── Main: prepare HTML for tracked send ──────────────────────────────────────
// This is what ses.js calls before SES SendRawEmail.
// Returns the modified HTML with open pixel + rewritten click links + unsub footer.
export function applyTracking(html, { baseUrl, campaignId, subscriberId }) {
  if (!campaignId || !subscriberId) return html; // safety — no tracking on test sends
  let out = html || '';
  out = appendUnsubFooter(out, { baseUrl, campaignId, subscriberId });
  out = rewriteLinks(out, { baseUrl, campaignId, subscriberId });
  const pixel = buildOpenPixel({ baseUrl, campaignId, subscriberId });
  out = injectOpenPixel(out, pixel);
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
