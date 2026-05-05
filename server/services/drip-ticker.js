/**
 * drip-ticker.js — Scheduled-send executor.
 *
 * Phase 4. Runs every TICK_INTERVAL_MS picking up any campaign with
 * status='scheduled' and figuring out whether to send any of its remaining
 * subscribers right now.
 *
 * Per campaign, on every tick:
 *   1. Has the start date arrived (in the campaign's timezone)?
 *   2. Is today one of the chosen send days?
 *   3. Is the current wall-clock time inside the chosen window?
 *   4. If we've crossed a calendar boundary, reset the per-day counter.
 *   5. How many of today's quota are still owed?
 *   6. How much window time is left? Pace the remaining quota across that
 *      time with random jitter (±30%) so it doesn't feel mechanical.
 *
 * When all subscribers have been sent, status flips to 'sent'. If the user
 * cancels mid-drip, the campaign moves to 'cancelled' and the ticker leaves
 * it alone. If the user pauses, status moves to 'paused' and we resume on
 * the next tick that catches it back at 'scheduled'.
 *
 * Everything stored in UTC — we use Intl.DateTimeFormat to compute "what
 * date/time is it in Europe/London right now" so DST handles itself.
 *
 * Crash recovery: drip_today_sent is persisted, and we never send the same
 * subscriber twice (email_sends has a unique-ish row per send). On restart
 * the next tick simply continues where things left off.
 */

import db from '../db.js';
import { sendCampaign } from './ses.js';

const TICK_INTERVAL_MS = 60 * 1000;   // every minute
let tickerHandle = null;
let isTicking = false;

// In-memory map of activeBurst handles per campaign id, so we can cancel
// pending setTimeouts if the campaign is paused/cancelled mid-burst.
const activeBursts = new Map();

export function startDripTicker() {
  if (tickerHandle) return;
  console.log('[drip] starting — interval ' + (TICK_INTERVAL_MS / 1000) + 's');
  // First tick after 60s (let everything else boot), then every minute
  setTimeout(() => {
    tickAll();
    tickerHandle = setInterval(tickAll, TICK_INTERVAL_MS);
  }, 60_000);
}

export function stopDripTicker() {
  if (tickerHandle) clearInterval(tickerHandle);
  tickerHandle = null;
  for (const burst of activeBursts.values()) burst.cancel();
  activeBursts.clear();
}

async function tickAll() {
  if (isTicking) {
    console.log('[drip] previous tick still running, skipping');
    return;
  }
  isTicking = true;
  try {
    const scheduled = db.prepare(
      "SELECT * FROM email_campaigns WHERE status = 'scheduled' AND daily_limit > 0"
    ).all();
    if (scheduled.length === 0) return;

    for (const campaign of scheduled) {
      try {
        await tickOneCampaign(campaign);
      } catch (err) {
        console.error(`[drip] ${campaign.id}: ${err.message}`);
        db.prepare("UPDATE email_campaigns SET drip_last_tick_at = datetime('now') WHERE id = ?").run(campaign.id);
      }
    }
  } finally {
    isTicking = false;
  }
}

// Internals exposed so a future test/debug tool can inspect them
export const _internals = { tickAll, tickOneCampaign };

async function tickOneCampaign(campaign) {
  // Stamp the tick — diagnostic only, doesn't gate logic
  db.prepare("UPDATE email_campaigns SET drip_last_tick_at = datetime('now') WHERE id = ?").run(campaign.id);

  // If we're already actively bursting for this campaign, leave the burst alone.
  // The next tick will catch up if needed.
  if (activeBursts.has(campaign.id)) {
    return;
  }

  const tz = campaign.drip_timezone || 'Europe/London';
  const now = new Date();
  const localParts = getLocalParts(now, tz);  // { date: 'YYYY-MM-DD', time: 'HH:MM', dayOfWeek: 0..6 }

  // 1. Has start date arrived?
  if (campaign.drip_start_at) {
    const startUtc = new Date(campaign.drip_start_at);
    if (now < startUtc) return;  // not yet
  }

  // 2. Is today an active send day?
  const sendDays = (campaign.drip_send_days || '1,2,3,4,5').split(',').map(s => parseInt(s.trim(), 10));
  if (!sendDays.includes(localParts.dayOfWeek)) return;

  // 3. Is the current local time inside the window?
  const windowStart = campaign.drip_window_start || '09:00';
  const windowEnd   = campaign.drip_window_end   || '11:00';
  if (localParts.time < windowStart || localParts.time >= windowEnd) return;

  // 4. Reset per-day counter if we've crossed a date boundary
  if (campaign.drip_today_date !== localParts.date) {
    db.prepare("UPDATE email_campaigns SET drip_today_date = ?, drip_today_sent = 0 WHERE id = ?")
      .run(localParts.date, campaign.id);
    campaign.drip_today_date = localParts.date;
    campaign.drip_today_sent = 0;
  }

  // 5. How many to send right now?
  const dailyLimit = campaign.daily_limit || 0;
  const todayLeft  = Math.max(0, dailyLimit - (campaign.drip_today_sent || 0));
  if (todayLeft === 0) return;  // already done for today

  // 6. How many subscribers haven't been sent yet on this campaign?
  // We re-fetch on every tick so newly-added subs (rare) get picked up,
  // and so cancellations/unsubs since the last tick are respected.
  const order = campaign.send_order === 'random' ? 'RANDOM()' : 's.created_at ASC';
  const remainingSubs = db.prepare(`
    SELECT s.* FROM email_subscribers s
    WHERE s.list_id = ?
      AND s.status = 'subscribed'
      AND NOT EXISTS (
        SELECT 1 FROM email_sends es WHERE es.campaign_id = ? AND es.subscriber_id = s.id
      )
    ORDER BY ${order}
  `).all(campaign.list_id, campaign.id);

  if (remainingSubs.length === 0) {
    // Nothing left — campaign is done
    db.prepare("UPDATE email_campaigns SET status = 'sent', sent_at = datetime('now'), sent_count = drip_sent WHERE id = ?")
      .run(campaign.id);
    console.log(`[drip] ${campaign.id}: complete — marking sent`);
    return;
  }

  const toSendNow = remainingSubs.slice(0, todayLeft);

  // 7. Pace across the remaining window time with random jitter.
  // Compute average gap = (window time remaining in ms) / batchSize.
  // Jitter each delay by ±30%. Minimum gap of 1 second to avoid SES throttling.
  const windowEndMs = localTimeToUtcMs(localParts.date, windowEnd, tz);
  const msRemaining = Math.max(0, windowEndMs - now.getTime());
  const batchSize = toSendNow.length;
  // If the window is closing imminently and we have a lot to send, fall back
  // to "send as fast as throttle allows" rather than missing the window.
  const avgGap = batchSize > 0 ? Math.max(1000, msRemaining / batchSize) : 0;

  console.log(`[drip] ${campaign.id}: bursting ${batchSize} email(s) over ~${Math.round(msRemaining/60000)}min, avgGap ${Math.round(avgGap/1000)}s`);

  // Mark this campaign as bursting
  let cancelled = false;
  const burst = {
    cancel() { cancelled = true; }
  };
  activeBursts.set(campaign.id, burst);

  // Send one at a time. Between sends, jitter the gap. Re-check campaign status
  // before each send so paused/cancelled flips take effect immediately.
  (async () => {
    try {
      const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`;
      const list = db.prepare("SELECT * FROM email_lists WHERE id = ?").get(campaign.list_id);
      const alwaysWarm = !!(list && list.always_warm);

      for (let i = 0; i < toSendNow.length; i++) {
        if (cancelled) break;

        // Re-check campaign status — cheap read on each iteration
        const fresh = db.prepare("SELECT status FROM email_campaigns WHERE id = ?").get(campaign.id);
        if (!fresh || fresh.status !== 'scheduled') {
          console.log(`[drip] ${campaign.id}: status changed to ${fresh?.status}, halting burst`);
          break;
        }

        const sub = toSendNow[i];
        // Send a "campaign" of one — sendCampaign handles personalisation, tracking,
        // and the email_sends row insertion. We give it a single subscriber.
        const result = await sendCampaign({
          campaign,
          subscribers: [sub],
          baseUrl,
          alwaysWarm,
        });

        // Update counters atomically
        db.prepare(`
          UPDATE email_campaigns
          SET drip_today_sent = COALESCE(drip_today_sent, 0) + ?,
              drip_sent       = COALESCE(drip_sent, 0) + ?,
              sent_count      = COALESCE(sent_count, 0) + ?
          WHERE id = ?
        `).run(result.sent, result.sent, result.sent, campaign.id);

        // Pace before next send (skip on the last one)
        if (i < toSendNow.length - 1 && avgGap > 0) {
          const jitter = avgGap * (0.7 + Math.random() * 0.6);  // ±30%
          await sleep(jitter);
        }
      }

      // After burst — was that the last send? If so mark as 'sent'
      const remaining = db.prepare(`
        SELECT COUNT(*) as c FROM email_subscribers s
        WHERE s.list_id = ? AND s.status = 'subscribed'
        AND NOT EXISTS (SELECT 1 FROM email_sends es WHERE es.campaign_id = ? AND es.subscriber_id = s.id)
      `).get(campaign.list_id, campaign.id);

      if (remaining.c === 0) {
        db.prepare("UPDATE email_campaigns SET status = 'sent', sent_at = datetime('now') WHERE id = ?")
          .run(campaign.id);
        console.log(`[drip] ${campaign.id}: complete — marking sent`);
      }
    } catch (err) {
      console.error(`[drip] ${campaign.id}: burst error: ${err.message}`);
    } finally {
      activeBursts.delete(campaign.id);
    }
  })();
}

// ── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Get current local-time parts in a given IANA timezone using Intl.
 * Returns { date: 'YYYY-MM-DD', time: 'HH:MM', dayOfWeek: 0..6 (Sun..Sat) }
 *
 * Why Intl: it correctly handles DST transitions for any zone with no
 * external dependencies, no zone data files, and works in Node 18+.
 */
export function getLocalParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    dayOfWeek: dayMap[parts.weekday] ?? 0,
  };
}

/**
 * Given a date string YYYY-MM-DD and time HH:MM, both interpreted in `timeZone`,
 * return the corresponding UTC ms timestamp.
 *
 * No clean stdlib for this, but binary-search on a small range works because
 * the "this UTC instant displays as <local time> in <tz>" function is monotonic
 * (and only differs from naive UTC by ±26 hours for any zone, including DST gaps).
 */
export function localTimeToUtcMs(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm]   = timeStr.split(':').map(Number);
  // Naive UTC guess (treat the inputs as if they were already UTC)
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  // What does that UTC instant display as in this tz?
  const back = getLocalParts(new Date(naive), timeZone);
  const backMs = Date.UTC(
    Number(back.date.slice(0, 4)),
    Number(back.date.slice(5, 7)) - 1,
    Number(back.date.slice(8, 10)),
    Number(back.time.slice(0, 2)),
    Number(back.time.slice(3, 5))
  );
  // Offset = how much our naive guess was ahead/behind. Subtract that to get the
  // true UTC instant whose tz-local display equals the requested wall clock.
  const offset = backMs - naive;
  return naive - offset;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
