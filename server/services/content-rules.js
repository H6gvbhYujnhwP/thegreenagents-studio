/**
 * content-rules.js — Customer-defined override rules for LinkedIn post generation
 *
 * "Refine my posts" is a portal-side feature: customers add numbered rules
 * (e.g. "Don't mention machinery breakdowns", "Don't talk about stress") that
 * override both the LinkedIn algorithm and the RAG document. This module is
 * the single place that:
 *
 *   1. Parses the JSON-encoded rules array out of clients.content_rules
 *   2. Renders the rules as a non-cached prompt block for post generation
 *      (deliberately NOT inside cache_control: ephemeral blocks — when the
 *      customer edits or deletes a rule we want the next call to use the
 *      fresh value, not whatever Anthropic cached up to 5 minutes ago)
 *   3. Validates a generated post against the rules using Claude Haiku 4.5
 *      (cheap fast classification — yes/no + list-of-violated-rules)
 *
 * Validation strategy:
 *   - Generate post normally with rules injected into the prompt
 *   - Pass post + rules to Haiku 4.5 → returns { ok: bool, violations: [{ ruleId, ruleText, reason }] }
 *   - If violations found, regenerate ONCE with the violated rules called out specifically
 *   - Validate again. If still failing, return the second attempt anyway and
 *     attach `validation_warnings` to the post so the customer can see which
 *     rule was likely violated and adjust their rules accordingly.
 *
 * Cost:
 *   - Haiku 4.5 at ~$1/MTok input / $5/MTok output. A typical validation call
 *     is <2000 input tokens (post + rules + instructions) and <500 output
 *     tokens (small JSON). So ~$0.0025 worst case per post, $0.030 per
 *     12-post campaign. Negligible against the ~$0.50-1.50 a Sonnet generation
 *     run costs.
 */

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Max validation attempts per post before giving up. Two attempts means at
// worst the customer sees a flagged post they can investigate themselves —
// better than a runaway loop bleeding tokens.
export const MAX_VALIDATION_ATTEMPTS = 2;

// Limits applied at the API layer (PUT /content-rules). Defined here so the
// API and the UI can share them.
export const RULE_MAX_LENGTH    = 500;
export const RULES_MAX_COUNT    = 50;

// ── Parse rules from the client row ──────────────────────────────────────────
// Returns an array of { id, text } objects. Defensive against the column being
// NULL, '', invalid JSON, or arrays containing non-string entries.
export function parseRules(client) {
  if (!client?.content_rules) return [];
  try {
    const parsed = JSON.parse(client.content_rules);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(r => r && typeof r.text === 'string' && r.text.trim().length > 0)
      .map(r => ({
        id:   String(r.id || ''),
        text: String(r.text).trim(),
      }));
  } catch (_) {
    return [];
  }
}

// ── Render rules as a prompt block ───────────────────────────────────────────
// Returns null if no rules — callers should skip pushing the block entirely
// in that case rather than send "no rules" noise. The block is deliberately
// NOT wrapped in cache_control because the whole point is that edits to the
// rules take effect immediately.
//
// `failedRules` is optional — when set (during a re-attempt after validation
// failed), those rules get extra emphasis so the model takes them seriously
// on the second try.
export function renderRulesPromptBlock(rules, { failedRules = [] } = {}) {
  if (!rules || rules.length === 0) return null;

  const numbered = rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
  const failedSection = failedRules.length > 0
    ? `\n\nYOUR PREVIOUS DRAFT VIOLATED THESE RULES — DO NOT VIOLATE THEM AGAIN:\n${failedRules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')}`
    : '';

  return {
    type: 'text',
    text: `CUSTOMER OVERRIDE RULES — these take absolute priority over the RAG document, the LinkedIn algorithm, and any other guidance. The customer has explicitly told you NOT to do these things. Treat them as hard constraints. If a topic from the RAG would violate a rule, pick a different topic from the RAG. Never argue with or work around these rules.

${numbered}${failedSection}

Re-read each rule above before writing. Every sentence you produce must obey every rule.`,
  };
}

// ── Validate a post against the rules using Haiku ────────────────────────────
// Returns { ok: bool, violations: [{ ruleId, ruleText, reason }] }
//
// On any error (network, model, parse), returns { ok: true, violations: [] }
// — i.e. fails open, so a transient API hiccup doesn't block post generation.
// The validation pass is an extra safety net, not a hard gate.
export async function validatePostAgainstRules(postText, rules) {
  if (!rules || rules.length === 0) return { ok: true, violations: [] };
  if (!postText || typeof postText !== 'string') return { ok: true, violations: [] };

  const numbered = rules.map((r, i) => `${i + 1}. [id=${r.id}] ${r.text}`).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: `You are a content compliance checker. You are given (1) a LinkedIn post draft and (2) a list of customer rules the post must obey. Your job is to flag any rule the post violates.

RULES:
${numbered}

POST DRAFT:
"""
${postText}
"""

Respond ONLY with valid JSON, no preamble, no markdown fences:
{
  "ok": true_or_false,
  "violations": [
    { "ruleId": "<the id of the violated rule>", "reason": "<one short sentence explaining what in the post triggered this>" }
  ]
}

If the post does not violate any rule, return {"ok": true, "violations": []}.
Be strict — if the post even references a forbidden topic in passing, flag it.
Do not invent violations for rules that aren't actually violated. False positives are worse than false negatives here.`,
        },
      ],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) return { ok: true, violations: [] };

    const raw = textBlock.text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    const parsed = JSON.parse(raw);
    if (typeof parsed?.ok !== 'boolean') return { ok: true, violations: [] };

    // Hydrate violations with the rule text from our rule list (so the caller
    // doesn't have to re-look-up by id when surfacing the warning to the UI).
    const ruleById = new Map(rules.map(r => [r.id, r.text]));
    const violations = (Array.isArray(parsed.violations) ? parsed.violations : [])
      .filter(v => v && typeof v.ruleId === 'string')
      .map(v => ({
        ruleId:   v.ruleId,
        ruleText: ruleById.get(v.ruleId) || '(unknown rule)',
        reason:   typeof v.reason === 'string' ? v.reason.slice(0, 300) : '',
      }));

    return { ok: parsed.ok && violations.length === 0, violations };
  } catch (err) {
    console.warn('[content-rules] Validation pass failed (failing open):', err.message);
    return { ok: true, violations: [] };
  }
}
