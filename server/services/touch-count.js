/**
 * touch-count.js — Smart tracking decision logic.
 *
 * Counts how many sent emails a subscriber has received from us within a
 * given window. Used by sendCampaign to decide per-recipient whether to
 * inject open/click tracking, based on the campaign's tracking_mode and
 * tracking_threshold settings.
 *
 * "Sent" is the operational definition: rows in email_sends with status
 * other than 'failed' or 'bounced'. A bounce means the email never reached
 * the recipient, so it doesn't count toward warming them up.
 */

import db from '../db.js';

// Count sent emails to a subscriber within the last N months.
// windowMonths = 0 → unbounded (all time).
// Excludes bounced and failed sends.
export function getTouchCount(subscriberId, windowMonths = 6) {
  const sql = windowMonths > 0
    ? `SELECT COUNT(*) as c FROM email_sends
       WHERE subscriber_id = ?
         AND status NOT IN ('failed', 'bounced')
         AND sent_at >= datetime('now', '-' || ? || ' months')`
    : `SELECT COUNT(*) as c FROM email_sends
       WHERE subscriber_id = ?
         AND status NOT IN ('failed', 'bounced')`;
  const row = windowMonths > 0
    ? db.prepare(sql).get(subscriberId, windowMonths)
    : db.prepare(sql).get(subscriberId);
  return row ? row.c : 0;
}

// Bulk version — given an array of subscriber IDs, return a Map of id → count.
// Avoids N+1 queries when sending a campaign to thousands of recipients.
export function getTouchCountsBulk(subscriberIds, windowMonths = 6) {
  if (!subscriberIds || subscriberIds.length === 0) return new Map();

  // SQLite's IN clause needs a placeholder per id
  const placeholders = subscriberIds.map(() => '?').join(',');
  const sql = windowMonths > 0
    ? `SELECT subscriber_id, COUNT(*) as c FROM email_sends
       WHERE subscriber_id IN (${placeholders})
         AND status NOT IN ('failed', 'bounced')
         AND sent_at >= datetime('now', '-' || ? || ' months')
       GROUP BY subscriber_id`
    : `SELECT subscriber_id, COUNT(*) as c FROM email_sends
       WHERE subscriber_id IN (${placeholders})
         AND status NOT IN ('failed', 'bounced')
       GROUP BY subscriber_id`;

  const args = windowMonths > 0
    ? [...subscriberIds, windowMonths]
    : subscriberIds;
  const rows = db.prepare(sql).all(...args);
  const map = new Map(subscriberIds.map(id => [id, 0]));
  for (const r of rows) map.set(r.subscriber_id, r.c);
  return map;
}

// Decide whether tracking should be applied to a specific recipient.
// touchCount = how many emails they've already received (0 = first contact).
// This is "first contact" because the current send hasn't happened yet — once
// it sends, they'll be at touchCount+1.
//
// Rules:
//   mode 'off'   → never track
//   mode 'all'   → always track
//   mode 'smart' → track only if (touchCount + 1) >= threshold
//                  e.g. threshold=3 means tracking starts on the 3rd email,
//                  so if they've already received 2 (touchCount=2), this
//                  send is their 3rd → track.
//   alwaysWarm   → list-level override forces 'all' behaviour
export function shouldTrackRecipient({ mode, threshold, touchCount, alwaysWarm }) {
  if (alwaysWarm) return true;
  if (mode === 'off')   return false;
  if (mode === 'all')   return true;
  if (mode === 'smart') return (touchCount + 1) >= (threshold || 3);
  return false; // unknown mode → safest default
}
