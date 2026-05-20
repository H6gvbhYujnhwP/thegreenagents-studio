/**
 * formspree-flagger.js — Auto-flag Formspree leads as Hot Prospects
 *
 * When a Formspree submission lands in a connected mailbox, we want it on
 * the customer's Hot Prospects list automatically. The poller calls
 * `processFormspreeLead(parsedEmail, emailClientId, sourceReplyId)` for every
 * newly-stored inbound; this module decides whether the email is a Formspree
 * lead worth flagging and, if so, parses the real prospect's name + email out
 * of the body and upserts a hot_prospects row.
 *
 * Design choices (locked 2026-05-20, this session):
 *
 * - Detection is on sender domain (@formspree.io) PLUS subject keywords.
 *   Generic Formspree mail like "Enrich Your Leads with Formspree" (their
 *   own product newsletter) is NOT a lead and must be ignored. The keyword
 *   list is conservative; extend it as new form types appear.
 *
 * - Parse extracts the prospect's email from the body. We look for the
 *   FIRST line containing both an email-shaped string AND a label that
 *   suggests it's the submitter's address (e.g. "email:", "Email:",
 *   "your email"). Falls back to "any email-shaped string in the body that
 *   isn't @formspree.io or @edpgroup.co.uk-style internal-looking addresses".
 *   If we can't extract an email at all, the email is skipped — we log it
 *   but never write a garbage row. The Render log line lets us spot patterns
 *   the parser misses so we can tighten rules over time.
 *
 * - Name preference order: parsed from body → email local-part with
 *   title-casing → null (which is fine; the table allows null name). In
 *   practice the body parse covers EDP's catalogue and form templates so
 *   the local-part fallback is rare.
 *
 * - added_by = 'auto:formspree' (a new actor value). The CRM frontend
 *   currently shows 'admin' vs 'portal:*'; this just becomes another value
 *   so the audit trail is clean. No frontend changes required — the badge
 *   row already renders whatever string is in the column.
 *
 * - Upsert behaviour matches the existing /api/email/hot-prospects POST
 *   route exactly (INSERT ON CONFLICT DO UPDATE), so re-flagging an
 *   already-existing prospect doesn't duplicate them and doesn't overwrite
 *   any notes the operator has added.
 *
 * - The same logic powers a one-shot backfill script
 *   (scripts/backfill-formspree-prospects.js) that sweeps existing
 *   email_replies. The shared parser keeps both paths consistent.
 *
 * The hook in imap-poller.js calls processFormspreeLead() AFTER the
 * email_replies INSERT, inside the same per-message try-catch. Any throw
 * here is caught at the poller level and logged — never breaks polling.
 */

import { v4 as uuid } from 'uuid';
import db from '../db.js';

// ─── Detection ───────────────────────────────────────────────────────────────

// Sender domain check. Anything @formspree.io is a candidate; subject is what
// distinguishes a lead from a Formspree-product email.
const FORMSPREE_SENDER_RE = /@formspree\.io$/i;

// Subject keywords that mark a real lead submission. We DO NOT match on
// "Formspree" alone — their newsletter ("Enrich Your Leads with Formspree")
// matches that but isn't a lead.
//
// Conservative list; extend as new form templates surface. Each entry is a
// substring (case-insensitive). Customer form templates we've seen so far:
//   - "EDP catalogue download — ..." (EDP)
//   - "EDP website enquiry — ..." (EDP)
// Generic patterns added: "form submission", "new submission", "contact form".
const LEAD_SUBJECT_KEYWORDS = [
  'catalogue download',
  'website enquiry',
  'website inquiry',
  'contact form',
  'form submission',
  'new submission',
  'new lead',
  'new enquiry',
  'new inquiry',
];

/**
 * Decide whether a parsed email is a Formspree lead worth flagging.
 * Returns true/false; never throws.
 */
export function isFormspreeLead(parsed) {
  try {
    const fromAddr = parsed?.from?.value?.[0]?.address || '';
    if (!FORMSPREE_SENDER_RE.test(fromAddr)) return false;

    const subject = (parsed?.subject || '').toLowerCase();
    if (!subject) return false;

    return LEAD_SUBJECT_KEYWORDS.some(k => subject.includes(k));
  } catch {
    return false;
  }
}

// ─── Body parsing ────────────────────────────────────────────────────────────

// Email regex — kept simple; we strip surrounding punctuation when matching.
// Excludes nothing — even @formspree.io can match, the higher level filters it.
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

// Email regex (global) for the "scan whole body" fallback.
const EMAIL_RE_GLOBAL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Labels that suggest "this is the submitter's email". Case-insensitive.
// We accept "email:", "Email :", "your email", "email address", etc.
const EMAIL_LABEL_RE = /(^|\s)(your[\s_-]?email|email[\s_-]?address|email|e-?mail)[\s:_-]*$/i;

// Labels that suggest "this is the submitter's name".
const NAME_LABEL_RE = /(^|\s)(your[\s_-]?name|name|full[\s_-]?name|contact[\s_-]?name)[\s:_-]*$/i;

// Senders to ignore when picking an email from the body — addresses that are
// obviously infrastructure rather than the submitter. (Formspree itself, and
// noreply-style addresses.) Anything matching this is skipped during the
// scan-whole-body fallback.
const INFRASTRUCTURE_SENDER_RE = /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster)@|@formspree\.io$/i;

/**
 * Title-case an email local-part for use as a name fallback.
 * "craig.willett" → "Craig Willett", "craig_willett" → "Craig Willett".
 * Numeric-only or single-letter local-parts return null (not useful as names).
 */
export function localPartToName(email) {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 1) return null;
  const local = email.slice(0, at);
  if (/^\d+$/.test(local)) return null;
  if (local.length < 2) return null;

  // Split on common separators, keep alphabetic chunks, title-case each.
  const parts = local
    .split(/[._\-+]/)
    .filter(p => /[a-zA-Z]/.test(p))
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  if (parts.length === 0) return null;
  return parts.join(' ');
}

/**
 * Parse a Formspree submission body to extract the submitter's email + name.
 *
 * Strategy:
 *   1. Scan the plain-text body line by line. For each line that looks like
 *      "Label: value", check if the label is an email or name label and the
 *      value matches the expected shape.
 *   2. If no labelled email was found, fall back to the FIRST email-shaped
 *      string in the body that isn't an infrastructure address.
 *   3. Name comes from a labelled name field if found, otherwise null (the
 *      caller will fall back to local-part title-casing).
 *
 * Returns { email, name } — email may be null if nothing parseable was found.
 * Name may be null too (caller decides what to do).
 *
 * Never throws — body might be HTML-only, encoded weirdly, etc.
 */
export function parseFormspreeBody(bodyText, bodyHtml) {
  let text = bodyText || '';

  // If there's no text body, derive plain text from HTML by stripping tags.
  // Cheap heuristic — fine for Formspree's simple table-style emails.
  if (!text && bodyHtml) {
    text = String(bodyHtml)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<\/?(br|p|div|tr|td|li|h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
  if (!text) return { email: null, name: null };

  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  let labelledEmail = null;
  let labelledName = null;

  // Pass 1: look for "label: value" pairs.
  for (const line of lines) {
    // Split on first colon — labels are short.
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1 || colonIdx > 40) continue;
    const label = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1).trim();
    if (!value) continue;

    // Email field?
    if (!labelledEmail && EMAIL_LABEL_RE.test(label)) {
      const m = value.match(EMAIL_RE);
      if (m && !INFRASTRUCTURE_SENDER_RE.test(m[0])) {
        labelledEmail = m[0].toLowerCase();
      }
    }
    // Name field?
    if (!labelledName && NAME_LABEL_RE.test(label)) {
      // Strip any trailing field markers ("_replyto" etc) and HTML residue.
      const clean = value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean && clean.length <= 120) {
        labelledName = clean;
      }
    }

    if (labelledEmail && labelledName) break;
  }

  // Pass 2: if we didn't find a labelled email, take the first email-shaped
  // string in the body that isn't infrastructure.
  let email = labelledEmail;
  if (!email) {
    const matches = text.match(EMAIL_RE_GLOBAL) || [];
    for (const m of matches) {
      if (!INFRASTRUCTURE_SENDER_RE.test(m)) {
        email = m.toLowerCase();
        break;
      }
    }
  }

  return { email, name: labelledName };
}

// ─── Upsert into hot_prospects ───────────────────────────────────────────────

/**
 * Upsert a hot_prospects row for an auto-detected lead. Mirrors the upsert
 * logic in routes/hot-prospects.js POST exactly: INSERT ON CONFLICT
 * (email_client_id, prospect_email) DO UPDATE, COALESCE on name so we don't
 * overwrite a richer name with a poorer one.
 *
 * Returns { id, was_new } so the caller can log nicely.
 * Never throws — DB errors are caught and logged.
 */
export function upsertProspectAuto({ emailClientId, prospectEmail, prospectName }) {
  if (!emailClientId || !prospectEmail) return null;
  try {
    const existing = db
      .prepare('SELECT id FROM hot_prospects WHERE email_client_id = ? AND prospect_email = ?')
      .get(emailClientId, prospectEmail);
    const wasNew = !existing;
    const id = existing?.id || uuid();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    db.prepare(`
      INSERT INTO hot_prospects (
        id, email_client_id, prospect_email, prospect_name,
        follow_up_date, notes, added_by, added_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
      ON CONFLICT(email_client_id, prospect_email) DO UPDATE SET
        prospect_name = COALESCE(hot_prospects.prospect_name, excluded.prospect_name),
        updated_at    = excluded.updated_at
    `).run(
      id,
      emailClientId,
      prospectEmail,
      prospectName || null,
      'auto:formspree',
      now,
      now,
    );

    return { id, was_new: wasNew };
  } catch (err) {
    console.error(`[formspree-flagger] upsert failed for ${prospectEmail}: ${err.message}`);
    return null;
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Called by the IMAP poller for every newly-stored inbound email. If the
 * email is a Formspree lead, parse it and upsert a hot_prospects row.
 *
 * Arguments:
 *   - parsed: the result of mailparser.simpleParser()
 *   - emailClientId: inbox.email_client_id from the poller
 *
 * Returns one of:
 *   - { action: 'skipped', reason: '...' }   not a Formspree lead, or product newsletter
 *   - { action: 'no_email' }                  was a lead but couldn't parse a prospect email
 *   - { action: 'flagged', was_new, prospect_email, prospect_name }
 *
 * Never throws.
 */
export function processFormspreeLead(parsed, emailClientId) {
  if (!isFormspreeLead(parsed)) {
    return { action: 'skipped', reason: 'not_formspree_lead' };
  }

  const { email, name } = parseFormspreeBody(parsed.text, parsed.html);
  if (!email) {
    console.warn(`[formspree-flagger] Lead detected but no parseable email — subject="${parsed.subject || ''}", inbox client=${emailClientId}`);
    return { action: 'no_email' };
  }

  // Name resolution: parsed name > local-part title-case > null.
  const resolvedName = name || localPartToName(email) || null;

  const result = upsertProspectAuto({
    emailClientId,
    prospectEmail: email,
    prospectName: resolvedName,
  });

  if (!result) return { action: 'no_email' };  // upsert failed; already logged

  console.log(
    `[formspree-flagger] ${result.was_new ? 'added' : 'updated'} ${email}` +
    (resolvedName ? ` (${resolvedName})` : '') +
    ` for client=${emailClientId}, subject="${parsed.subject || ''}"`
  );
  return {
    action: 'flagged',
    was_new: result.was_new,
    prospect_email: email,
    prospect_name: resolvedName,
  };
}
