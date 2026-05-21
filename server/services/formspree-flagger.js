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
 * - PARSER IS LABELLED-ONLY — no bare-email fallback. (Tightened 2026-05-20
 *   fifth session after the bare fallback grabbed `mailbox: kevin@...` on
 *   the EDP website-enquiry template — the form's own destination mailbox,
 *   not the submitter. See blueprint lesson #68: "the bare-fallback in a
 *   parser is where junk creeps in.") If we can't find a properly-labelled
 *   email field we skip the row and log it — better to miss than to add
 *   wrong. The log line lets us notice new templates that need parser
 *   support.
 *
 * - LABEL/VALUE CAN BE SAME-LINE OR TWO-LINE. EDP's catalogue-download
 *   template is "name: Wez" on one line. EDP's website-enquiry template
 *   has the label on its own line and the value on the next. Both forms
 *   are accepted.
 *
 * - OWN-MAILBOX / OWN-DOMAIN FILTER as a second defence. Even if a parser
 *   bug ever resurrects the wrong-field problem, we won't write a junk row
 *   for the customer's own mailbox address or any sending domain they own.
 *   See `isOwnAddress()` below.
 *
 * - Name preference order: parsed from body → email local-part with
 *   title-casing → null (which is fine; the table allows null name).
 *
 * - added_by = 'auto:formspree' (a new actor value). The CRM frontend
 *   currently shows 'admin' vs 'portal:*'; this just becomes another value
 *   so the audit trail is clean.
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
// Conservative list; extend as new form templates surface. Customer form
// templates we've seen so far:
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
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

// Labels that mean "this is the SUBMITTER's email" — the prospect we want
// to flag. We deliberately do NOT include "mailbox" (that's the form's
// destination address, i.e. the customer's own inbox) or "_replyto" alone
// (Formspree config field that can echo the form owner's address).
//
// Accepted forms include "email:", "Email :", "your email", "email address".
const EMAIL_LABEL_RE =
  /^\s*(your[\s_-]?email|email[\s_-]?address|email|e-?mail|from[\s_-]?email)\s*:?\s*$/i;

// Labels that suggest "this is the submitter's name".
const NAME_LABEL_RE =
  /^\s*(your[\s_-]?name|name|full[\s_-]?name|contact[\s_-]?name|from[\s_-]?name)\s*:?\s*$/i;

// Addresses to ignore even if labelled — infrastructure / sender-side noise.
const INFRASTRUCTURE_SENDER_RE =
  /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster)@|@formspree\.io$/i;

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
 * Strategy — LABELLED ONLY, no bare-email fallback:
 *   1. Split into trimmed non-empty lines.
 *   2. For each line, treat it as a potential label/value pair in either of:
 *        (a) SAME-LINE  — "label: value"     (catalogue-download template)
 *        (b) TWO-LINE   — "label:" or "label" on one line, value on the next
 *                         (website-enquiry template)
 *      An email field is only accepted if its label matches EMAIL_LABEL_RE
 *      (deliberately excludes "mailbox" — that's the destination, not the
 *      submitter). Same for name labels.
 *   3. If no labelled email is found, return { email: null, name: null } —
 *      the caller will skip and log. We prefer missing a row to writing
 *      a wrong one.
 *
 * Returns { email, name }. Email is lowercased. Name may be null.
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

  /**
   * Try to read a label off a line. Returns 'email' | 'name' | null.
   * Accepts the label with or without a trailing colon, since the two-line
   * template has the colon on the label line ("email:") OR sometimes not.
   */
  const labelKind = (line) => {
    if (EMAIL_LABEL_RE.test(line)) return 'email';
    if (NAME_LABEL_RE.test(line)) return 'name';
    return null;
  };

  /**
   * Attempt to read a same-line "label: value". Returns { kind, value } or null.
   * Only fires when there's a colon AND something non-empty after it.
   */
  const readSameLine = (line) => {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1 || colonIdx > 40) return null;
    const label = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!value) return null;
    if (EMAIL_LABEL_RE.test(label)) return { kind: 'email', value };
    if (NAME_LABEL_RE.test(label)) return { kind: 'name', value };
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // First, try same-line "label: value".
    const sameLine = readSameLine(line);
    if (sameLine) {
      if (sameLine.kind === 'email' && !labelledEmail) {
        const m = sameLine.value.match(EMAIL_RE);
        if (m && !INFRASTRUCTURE_SENDER_RE.test(m[0])) {
          labelledEmail = m[0].toLowerCase();
        }
      } else if (sameLine.kind === 'name' && !labelledName) {
        const clean = sameLine.value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (clean && clean.length <= 120) labelledName = clean;
      }
      if (labelledEmail && labelledName) break;
      continue;
    }

    // Second, try two-line: this line is a bare label, value is the next line.
    const kind = labelKind(line);
    if (!kind) continue;
    const next = lines[i + 1];
    if (!next) continue;

    if (kind === 'email' && !labelledEmail) {
      const m = next.match(EMAIL_RE);
      if (m && !INFRASTRUCTURE_SENDER_RE.test(m[0])) {
        labelledEmail = m[0].toLowerCase();
      }
    } else if (kind === 'name' && !labelledName) {
      const clean = next.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean && clean.length <= 120) labelledName = clean;
    }
    if (labelledEmail && labelledName) break;
  }

  return { email: labelledEmail, name: labelledName };
}

// ─── Own-mailbox / own-domain filter ─────────────────────────────────────────

/**
 * Returns true if `prospectEmail` is one of the customer's own addresses
 * — either an exact match for a connected `email_inboxes` address, or its
 * domain matches a domain the customer sends from (the host portion of any
 * `email_brands.from_email` or `email_lists.from_email` row tied to the
 * same email_client_id).
 *
 * Used as a second defence in case the parser ever picks the wrong field
 * again. Returns true to mean SKIP THIS EMAIL.
 *
 * Never throws — on any DB error, returns false (fail open, prefer false
 * negatives to crashing the poller). Logs the error.
 */
export function isOwnAddress(emailClientId, prospectEmail) {
  if (!emailClientId || !prospectEmail) return false;
  try {
    const lower = String(prospectEmail).toLowerCase();
    const at = lower.indexOf('@');
    if (at < 1) return false;
    const domain = lower.slice(at + 1);

    // Exact match: any connected mailbox address for this email_client_id.
    const inbox = db
      .prepare(
        'SELECT 1 FROM email_inboxes WHERE email_client_id = ? AND LOWER(email_address) = ? LIMIT 1'
      )
      .get(emailClientId, lower);
    if (inbox) return true;

    // Domain match: any send-from address tied to this email_client_id.
    // Look at both email_brands and email_lists. Compare on the host portion.
    const fromRows = db
      .prepare(`
        SELECT from_email FROM email_brands WHERE email_client_id = ?
        UNION
        SELECT from_email FROM email_lists  WHERE email_client_id = ?
      `)
      .all(emailClientId, emailClientId);

    for (const row of fromRows) {
      const fe = String(row.from_email || '').toLowerCase();
      const feAt = fe.indexOf('@');
      if (feAt < 0) continue;
      const feDomain = fe.slice(feAt + 1);
      if (feDomain && feDomain === domain) return true;
    }
    return false;
  } catch (err) {
    console.error(`[formspree-flagger] isOwnAddress check failed: ${err.message}`);
    return false;
  }
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
export function upsertProspectAuto({ emailClientId, prospectEmail, prospectName, sourceReplyId }) {
  if (!emailClientId || !prospectEmail) return null;
  try {
    const existing = db
      .prepare('SELECT id FROM hot_prospects WHERE email_client_id = ? AND prospect_email = ?')
      .get(emailClientId, prospectEmail);
    const wasNew = !existing;
    const id = existing?.id || uuid();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // source_reply_id is updated ONLY when it's currently NULL on the row —
    // we never overwrite an earlier link. If the same prospect was already
    // flagged via a previous Formspree submission, that earlier submission's
    // id stays as the source. The thread merger picks up the linked row
    // regardless of which submission is "the" source — so this is purely
    // about not thrashing a value that was already correct.
    db.prepare(`
      INSERT INTO hot_prospects (
        id, email_client_id, prospect_email, prospect_name,
        follow_up_date, notes, added_by, added_at, updated_at,
        source_reply_id
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(email_client_id, prospect_email) DO UPDATE SET
        prospect_name   = COALESCE(hot_prospects.prospect_name, excluded.prospect_name),
        source_reply_id = COALESCE(hot_prospects.source_reply_id, excluded.source_reply_id),
        updated_at      = excluded.updated_at
    `).run(
      id,
      emailClientId,
      prospectEmail,
      prospectName || null,
      'auto:formspree',
      now,
      now,
      sourceReplyId || null,
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
 *   - sourceReplyId: the id of the email_replies row we just inserted for
 *     this message. Stored on the hot_prospects row so the thread merger
 *     can pull this row in even though its from_address (Formspree's
 *     noreply@) doesn't match the prospect's actual email address. Optional
 *     — older deploys that haven't been updated to pass this argument will
 *     simply create a hot_prospects row with NULL source_reply_id (the
 *     thread will fall back to the address-match path, which for Formspree
 *     leads will be empty).
 *
 * Returns one of:
 *   - { action: 'skipped', reason: '...' }   not a Formspree lead, or product newsletter,
 *                                             or own mailbox/domain
 *   - { action: 'no_email' }                  was a lead but couldn't parse a labelled email
 *   - { action: 'flagged', was_new, prospect_email, prospect_name }
 *
 * Never throws.
 */
export function processFormspreeLead(parsed, emailClientId, sourceReplyId) {
  if (!isFormspreeLead(parsed)) {
    return { action: 'skipped', reason: 'not_formspree_lead' };
  }

  const { email, name } = parseFormspreeBody(parsed.text, parsed.html);
  if (!email) {
    console.warn(
      `[formspree-flagger] Lead detected but no LABELLED email — subject="${parsed.subject || ''}", inbox client=${emailClientId}. ` +
      `Parser only accepts labelled email fields (no bare-email fallback). Check whether this is a new template that needs label support.`
    );
    return { action: 'no_email' };
  }

  // Second defence: never flag the customer's own mailbox or a domain they
  // send from. If the parser ever picks the wrong field again, this catches it.
  if (isOwnAddress(emailClientId, email)) {
    console.log(
      `[formspree-flagger] Skipping own-address ${email} for client=${emailClientId} ` +
      `(matches a connected mailbox or sending domain — not a real prospect).`
    );
    return { action: 'skipped', reason: 'own_address' };
  }

  // Name resolution: parsed name > local-part title-case > null.
  const resolvedName = name || localPartToName(email) || null;

  const result = upsertProspectAuto({
    emailClientId,
    prospectEmail: email,
    prospectName: resolvedName,
    sourceReplyId: sourceReplyId || null,
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
