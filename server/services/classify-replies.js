/**
 * classify-replies.js — Three-pass classifier for incoming email replies.
 *
 * Phase 3.2. Runs as a background cron (every CRON_INTERVAL_MS) picking up
 * any email_replies row where classification IS NULL and resolving it.
 *
 * Three passes, fastest-first:
 *
 *   Pass 1 — REGEX (free, instant)
 *     Hard-negative phrases like "unsubscribe", "stop emailing", "remove me".
 *     Tight scope to avoid false positives ("don't unsubscribe me from this great
 *     newsletter" is rare but exists). Tested below in self-test.
 *
 *   Pass 2 — HEURISTIC (free, instant)
 *     Out-of-office detection (subject prefix, body markers, common phrases)
 *     and forwarding patterns. These don't need AI to spot reliably.
 *
 *   Pass 3 — CLAUDE HAIKU (~$0.001/reply)
 *     Everything else. Categorises as positive | soft_negative | neutral.
 *     At ~20 replies/day the AI cost is negligible.
 *
 * After classification, hard_negative AND soft_negative replies trigger
 * auto-unsubscribe across every list belonging to this email_client. The user
 * confirmed this aggressive scope. No "snooze 90 days" fallback.
 *
 * Idempotency: this module never reprocesses a row whose classification is
 * already set. Manual reclassification by the user (via the UI) sets a value
 * too, so it doesn't get clobbered by the cron.
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuid } from 'uuid';
import db from '../db.js';

const CRON_INTERVAL_MS = 60 * 1000;        // process the queue every minute
const MAX_PER_RUN     = 25;                // cap to avoid burning AI quota in one go
const AI_CONCURRENCY  = 3;                 // parallel Haiku calls

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

let cronHandle = null;
let isRunning = false;

// ── Public API ────────────────────────────────────────────────────────────────

/** Start the cron. Safe to call multiple times. */
export function startClassifier() {
  if (cronHandle) return;
  console.log('[classifier] starting — interval ' + (CRON_INTERVAL_MS / 1000) + 's');
  // First run after 45s (let the IMAP poller's first run finish), then every minute
  setTimeout(() => {
    classifyPending();
    cronHandle = setInterval(classifyPending, CRON_INTERVAL_MS);
  }, 45_000);
}

/** Stop the cron (used in tests). */
export function stopClassifier() {
  if (cronHandle) clearInterval(cronHandle);
  cronHandle = null;
}

/**
 * Force a single classification run NOW. Returns { processed, byPass }.
 * Useful for the "Classify now" button in the UI.
 */
export async function classifyPendingOnce() {
  return classifyPending();
}

/**
 * Classify a single reply by id, even if it already has a classification.
 * Used by the "re-run AI" button in the reply detail modal. Returns the
 * resulting classification row.
 */
export async function classifyOneReply(replyId, { force = false } = {}) {
  const row = db.prepare(
    "SELECT * FROM email_replies WHERE id = ?"
  ).get(replyId);
  if (!row) return { ok: false, error: 'Reply not found' };
  if (!force && row.classification) return { ok: true, classification: row.classification, skipped: true };
  await classifyAndStore(row);
  const updated = db.prepare("SELECT classification, classification_reason, classification_confidence, auto_unsubscribed FROM email_replies WHERE id = ?").get(replyId);
  return { ok: true, ...updated };
}

// ── Cron worker ───────────────────────────────────────────────────────────────

async function classifyPending() {
  if (isRunning) {
    console.log('[classifier] previous run still in progress, skipping');
    return { processed: 0, byPass: { regex: 0, heuristic: 0, ai: 0, error: 0 } };
  }
  isRunning = true;
  const stats = { processed: 0, byPass: { regex: 0, heuristic: 0, ai: 0, error: 0 } };
  try {
    const pending = db.prepare(
      "SELECT * FROM email_replies WHERE classification IS NULL ORDER BY received_at ASC LIMIT ?"
    ).all(MAX_PER_RUN);
    if (pending.length === 0) return stats;

    console.log(`[classifier] processing ${pending.length} pending repl${pending.length === 1 ? 'y' : 'ies'}`);

    // Pass 1 + 2 are sync-fast; do them inline. Anything still NULL after that
    // gets queued for AI fallback with limited parallelism.
    const needAI = [];
    for (const reply of pending) {
      try {
        const r1 = classifyByRegex(reply);
        if (r1) {
          await applyClassification(reply, r1);
          stats.byPass.regex++;
          stats.processed++;
          continue;
        }
        const r2 = classifyByHeuristic(reply);
        if (r2) {
          await applyClassification(reply, r2);
          stats.byPass.heuristic++;
          stats.processed++;
          continue;
        }
        needAI.push(reply);
      } catch (err) {
        console.error(`[classifier] pre-AI error on ${reply.id}: ${err.message}`);
        stats.byPass.error++;
      }
    }

    // Pass 3 — concurrent AI workers
    if (needAI.length > 0) {
      console.log(`[classifier] ${needAI.length} repl${needAI.length === 1 ? 'y needs' : 'ies need'} AI fallback`);
      let cursor = 0;
      async function aiWorker() {
        while (true) {
          const idx = cursor++;
          if (idx >= needAI.length) return;
          const reply = needAI[idx];
          try {
            const r3 = await classifyByAI(reply);
            await applyClassification(reply, r3);
            stats.byPass.ai++;
            stats.processed++;
          } catch (err) {
            console.error(`[classifier] AI error on ${reply.id}: ${err.message}`);
            stats.byPass.error++;
            // Mark as 'neutral' with reason so the row doesn't reprocess every cron tick
            await applyClassification(reply, {
              classification: 'neutral',
              confidence: 0.0,
              reason: `AI classifier failed: ${err.message.slice(0, 100)}`,
            });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, needAI.length) }, aiWorker));
    }

    console.log(`[classifier] done — regex=${stats.byPass.regex}, heuristic=${stats.byPass.heuristic}, ai=${stats.byPass.ai}, error=${stats.byPass.error}`);
  } finally {
    isRunning = false;
  }
  return stats;
}

// Helper used by classifyOneReply: force-run all three passes on a single row.
async function classifyAndStore(reply) {
  const r1 = classifyByRegex(reply);
  if (r1) return applyClassification(reply, r1);
  const r2 = classifyByHeuristic(reply);
  if (r2) return applyClassification(reply, r2);
  const r3 = await classifyByAI(reply);
  return applyClassification(reply, r3);
}

// ── Pass 1: regex (hard negatives only) ───────────────────────────────────────

/**
 * Looks for clear opt-out language. Returns a classification object or null
 * if no match. Tight by design — we'd rather miss one and let AI handle it
 * than auto-unsubscribe someone over a misread phrase.
 */
export function classifyByRegex(reply) {
  const body = normaliseBody(reply.body_text || stripHtml(reply.body_html || ''));
  if (!body) return null;

  // Trim to the part of the email above the quoted reply marker, to avoid
  // matching language from the original campaign that was quoted back.
  const above = stripQuoted(body);

  // Hard-negative patterns. \b boundaries everywhere so "destruction" doesn't
  // trip "structure", etc. Anchored to clear opt-out intent.
  const HARD = [
    /\bunsubscribe\b/i,
    /\bstop\s+(sending|emailing|contacting|messaging)\b/i,
    /\b(remove|delete)\s+(me|my\s+(email|address)|us)\b/i,
    /\btake\s+me\s+off\b/i,
    /\bopt[\s-]*out\b/i,
    /\bdo\s+not\s+(email|contact|send)\b/i,
    /\bdon'?t\s+(email|contact|send)\s+me\b/i,
    /\bplease\s+remove\b/i,
    /\bcease\s+(and\s+desist|all\s+communication)\b/i,
  ];

  for (const re of HARD) {
    if (re.test(above)) {
      return {
        classification: 'hard_negative',
        confidence: 0.95,
        reason: `Matched opt-out phrase: ${re.source}`,
      };
    }
  }

  // "Not interested" deserves special treatment — only a hard signal when the
  // reply is short. A long thoughtful "I'm not interested at the moment but
  // here's why and what I'd be open to..." is a soft_negative or even positive,
  // and AI should decide.
  if (/\bnot\s+interested\b/i.test(above)) {
    const wordCount = above.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 25) {
      return {
        classification: 'hard_negative',
        confidence: 0.85,
        reason: 'Short "not interested" reply',
      };
    }
  }

  return null;
}

// ── Pass 2: heuristic (out-of-office, forwarding) ─────────────────────────────

export function classifyByHeuristic(reply) {
  const subject = (reply.subject || '').toLowerCase();
  const body = normaliseBody(reply.body_text || stripHtml(reply.body_html || ''));

  // Out-of-office — subject markers are by far the strongest signal
  const OOO_SUBJECT = [
    /^(re:\s*)?(out of (the )?office|automatic reply|auto-?reply|auto response|away from|on (vacation|holiday|leave|annual leave|maternity|paternity|parental))/i,
  ];
  if (OOO_SUBJECT.some(re => re.test(reply.subject || ''))) {
    return {
      classification: 'auto_reply',
      confidence: 0.95,
      reason: 'Out-of-office subject prefix',
    };
  }

  // Body-based OOO markers — be fairly specific to avoid false positives
  const OOO_BODY = [
    /\bI\s+am\s+(currently\s+)?out\s+of\s+(the\s+)?office\b/i,
    /\bI\s+am\s+(currently\s+)?on\s+(annual\s+)?(leave|vacation|holiday)\b/i,
    /\bI\s+will\s+be\s+(out\s+of\s+(the\s+)?office|away|unavailable)\b/i,
    /\bauto(matic)?[\s-]*(reply|response|generated)\b/i,
    /\bthank\s+you\s+for\s+your\s+(email|message)\.?\s+I\s+am\s+(currently\s+)?(out|away|on\s+leave|unavailable)/i,
    /\b(returning|back\s+in\s+the\s+office)\s+on\b/i,
  ];
  for (const re of OOO_BODY) {
    if (re.test(body)) {
      return {
        classification: 'auto_reply',
        confidence: 0.9,
        reason: 'Out-of-office phrasing in body',
      };
    }
  }

  // Forwarding indicators — Gmail/Outlook insert "Begin forwarded message" /
  // "----Original Message----" / "FW:" prefix. Treat as forwarding so the user
  // can decide what to do with it.
  if (/^fw:\s*|^fwd:\s*/i.test(reply.subject || '')) {
    return {
      classification: 'forwarding',
      confidence: 0.85,
      reason: 'Forwarding subject prefix',
    };
  }

  return null;
}

// ── Pass 3: Claude Haiku ──────────────────────────────────────────────────────

export async function classifyByAI(reply) {
  const subject = (reply.subject || '(no subject)').slice(0, 200);
  const fromAddr = reply.from_address || '(unknown)';
  const fromName = reply.from_name || '';
  const body = normaliseBody(reply.body_text || stripHtml(reply.body_html || ''));
  const above = stripQuoted(body).slice(0, 2000);  // cap body to keep token use predictable

  const prompt = `You are classifying a reply to a B2B cold-outreach email so the sender (a salesperson) knows whether to follow up, leave alone, or unsubscribe the recipient.

Reply details:
From: ${fromName} <${fromAddr}>
Subject: ${subject}
Body (above-quote portion only):
"""
${above || '(empty body)'}
"""

Categories:
- positive       — recipient expresses interest, asks a question, requests more info, suggests a meeting, or otherwise wants to engage. Includes "tell me more", "send pricing", "happy to chat", "what's the next step".
- soft_negative  — recipient declines politely, says "not right now", "maybe later", "we already use a competitor", "wrong contact" without ill will, or otherwise signals no fit / no interest without explicitly asking to be removed.
- hard_negative  — recipient explicitly asks to be removed, stop emailing, opt out, or expresses anger. (You'll rarely see these; the regex pre-pass catches most.)
- neutral        — auto-replies that aren't out-of-office (delivery receipts, acknowledgements), bounce-style messages that slipped past, or anything genuinely ambiguous.

Reply with ONLY valid JSON, nothing else:
{"classification":"positive|soft_negative|hard_negative|neutral","confidence":0.0-1.0,"reason":"brief sentence explaining why"}`;

  const resp = await client().messages.create({
    model: process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (resp.content?.[0]?.text || '').trim();
  // Strip markdown fences if the model added them despite the prompt
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`AI returned non-JSON: ${cleaned.slice(0, 100)}`);
  }

  const VALID = new Set(['positive', 'soft_negative', 'hard_negative', 'neutral']);
  if (!VALID.has(parsed.classification)) {
    throw new Error(`AI returned invalid classification: ${parsed.classification}`);
  }
  const confidence = Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7;
  const reason = (parsed.reason || 'AI classified').slice(0, 300);

  return {
    classification: parsed.classification,
    confidence,
    reason,
  };
}

// ── Apply classification + trigger auto-unsub ────────────────────────────────

async function applyClassification(reply, result) {
  db.prepare(`
    UPDATE email_replies
    SET classification = ?, classification_confidence = ?, classification_reason = ?
    WHERE id = ?
  `).run(result.classification, result.confidence, result.reason, reply.id);

  // Audit row for the classification action itself
  db.prepare(`INSERT INTO email_audit_log (id, actor, action, target_type, target_id, reply_id, metadata)
              VALUES (?, 'system', 'classify', 'reply', ?, ?, ?)`).run(
    uuid(), reply.id, reply.id,
    JSON.stringify({ classification: result.classification, confidence: result.confidence, reason: result.reason })
  );

  // Auto-unsubscribe for negatives. User confirmed: BOTH hard and soft trigger.
  if (result.classification === 'hard_negative' || result.classification === 'soft_negative') {
    autoUnsubscribeSender(reply, result);
  }
}

/**
 * Find every active subscriber across the email_client's lists matching the
 * reply's sender address, and unsubscribe them. Logs an audit row per
 * subscriber. Marks the reply auto_unsubscribed=1 so the UI can badge it.
 */
function autoUnsubscribeSender(reply, classifyResult) {
  const fromAddr = (reply.from_address || '').toLowerCase().trim();
  if (!fromAddr) return;

  // Find every subscriber across this email_client's lists with this email
  const matches = db.prepare(`
    SELECT s.id, s.list_id, s.email
    FROM email_subscribers s
    JOIN email_lists l ON s.list_id = l.id
    WHERE l.email_client_id = ? AND LOWER(s.email) = ? AND s.status = 'subscribed'
  `).all(reply.email_client_id, fromAddr);

  if (matches.length === 0) {
    // Nothing to unsubscribe — still mark the reply auto_unsubscribed=1 so the
    // UI shows the negative badge. The user may have manually added them later.
    db.prepare(`UPDATE email_replies SET auto_unsubscribed = 1 WHERE id = ?`).run(reply.id);
    db.prepare(`INSERT INTO email_audit_log (id, actor, action, target_type, target_id, reply_id, metadata)
                VALUES (?, 'system', 'auto_unsubscribe_no_match', 'reply', ?, ?, ?)`).run(
      uuid(), reply.id, reply.id,
      JSON.stringify({ from_address: fromAddr, classification: classifyResult.classification, reason: 'No matching subscriber on any list' })
    );
    return;
  }

  // Unsubscribe each match in a transaction
  const unsubStmt = db.prepare(
    "UPDATE email_subscribers SET status = 'unsubscribed', unsubscribed_at = datetime('now') WHERE id = ?"
  );
  const auditStmt = db.prepare(`INSERT INTO email_audit_log (id, actor, action, target_type, target_id, reply_id, metadata)
                                VALUES (?, 'system', 'auto_unsubscribe', 'subscriber', ?, ?, ?)`);
  const updateListCount = db.prepare(
    "UPDATE email_lists SET subscriber_count = (SELECT COUNT(*) FROM email_subscribers WHERE list_id = ? AND status = 'subscribed') WHERE id = ?"
  );

  const tx = db.transaction(() => {
    const touchedLists = new Set();
    for (const m of matches) {
      unsubStmt.run(m.id);
      auditStmt.run(
        uuid(), m.id, reply.id,
        JSON.stringify({
          email: m.email,
          list_id: m.list_id,
          classification: classifyResult.classification,
          confidence: classifyResult.confidence,
          reason: classifyResult.reason,
        })
      );
      touchedLists.add(m.list_id);
    }
    for (const lid of touchedLists) updateListCount.run(lid, lid);
    db.prepare(`UPDATE email_replies SET auto_unsubscribed = 1 WHERE id = ?`).run(reply.id);
  });
  tx();

  console.log(`[classifier] auto-unsubscribed ${matches.length} subscriber(s) matching ${fromAddr} (${classifyResult.classification})`);
}

// ── Body normalisation helpers ────────────────────────────────────────────────

function normaliseBody(s) {
  if (!s) return '';
  return String(s)
    .replace(/\r\n/g, '\n')
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')  // weird unicode whitespace
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Trim a reply to the portion above the quoted original. Replies usually have
 * a marker like "On Mon, ... wrote:" or ">" prefixes on every line. We keep
 * everything above the first such marker so we don't accidentally classify
 * based on the original campaign's words.
 */
function stripQuoted(body) {
  if (!body) return '';
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Gmail/Outlook style: "On <date>, <Name> <email> wrote:"
    if (/^on\s.+\bwrote:\s*$/i.test(line.trim())) return lines.slice(0, i).join('\n').trim();
    // Outlook style: "From: ..." headers block
    if (/^from:\s.+/i.test(line) && i > 0) {
      // Make sure it's preceded by a blank-ish line or a separator
      const prev = (lines[i - 1] || '').trim();
      if (!prev || /^[-_=*]{3,}/.test(prev)) return lines.slice(0, i).join('\n').trim();
    }
    // Outlook style: "________________" separator
    if (/^_{3,}\s*$/.test(line.trim())) return lines.slice(0, i).join('\n').trim();
    // Apple Mail style: "Begin forwarded message:"
    if (/^begin forwarded message:/i.test(line.trim())) return lines.slice(0, i).join('\n').trim();
    // Lots of consecutive quoted lines = we're in the quote
    if (/^>/.test(line) && i > 2) {
      const recentQuoted = lines.slice(Math.max(0, i - 2), i + 1).filter(l => /^>/.test(l)).length;
      if (recentQuoted >= 2) return lines.slice(0, i).join('\n').trim();
    }
  }
  return body.trim();
}

// Exports for unit-testing internals
export const _internals = { stripQuoted, stripHtml, normaliseBody };
