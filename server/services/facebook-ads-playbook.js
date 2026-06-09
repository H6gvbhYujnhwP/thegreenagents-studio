// ─────────────────────────────────────────────────────────────────────────────
// Facebook Ads — agency playbook (decision #106).
//
// This is the agency-wide strategy that applies to EVERY client, distilled from
// the Master Facebook Ads RAG Knowledge Base + Masterclass that the operator
// supplied. It steers the AD COPY generation (the campaign-architecture and
// budgeting parts of the RAG drive stage 3, not copy, so they're not here).
//
// Per-client voice, offers, pains, and banned words come from that client's
// OWN uploaded RAG (facebook_ads.rag_content) — layered on top of this at
// generation time. This constant is baked in (ships via deploy); making it
// editable in-app is a possible later enhancement, not needed now.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENCY_COPY_PLAYBOOK = `
You are writing Facebook/Meta ad copy for a UK SME, in 2026. Follow this agency playbook:

CORE PRINCIPLE — THE CREATIVE IS THE TARGETING.
Targeting is kept deliberately broad (age + location only). That means the COPY
itself must call out the exact person who should buy. Name their situation, their
job, their pain — so the right person stops scrolling and feels "this is about me".

THE AD COPY FORMULA (use this structure for the primary text):
1. Hook — grab attention in the first line; lead with the pain or a sharp truth.
2. Call out the target audience — make it obvious who this is for.
3. Feature — what the product actually does.
4. Benefit — the outcome they get.
5. Light scarcity or a reason to act now (only if it's honest — no fake urgency).
6. A clear call to action.

CREATIVE DIVERSITY:
Each variation must take a genuinely DIFFERENT angle/hook — a different pain, a
different moment, a different framing. Do not produce three rewrites of the same
sentence. Variety is what lowers cost per lead.

VOICE & QUALITY:
- Match the client's brand voice from their RAG below. If the RAG lists banned
  words or risky claims, NEVER use them.
- Specific beats generic. Concrete beats clever. No hype, no empty adjectives.
- Primary text: ~2–4 short sentences/lines. Headline: under ~40 characters,
  punchy. Keep it scannable on a phone.
- Optimise for LEADS (enquiries, quotes, calls, sign-ups) — not clicks or "reach".

IMAGE BRIEF:
For each variation also write a short, literal image brief describing a clean,
on-brand, legible visual that supports the hook. Do NOT put the company name,
logo, watermark, or long text in the image — a logo is added afterwards in
post-processing. Describe the scene/subject and mood, not text overlays.
`.trim();

// Meta call-to-action button enums we allow Studio to choose from. Lead-gen
// oriented. Stored as the enum; the UI shows the friendly label. Stage 3 passes
// the enum straight to the Meta Marketing API.
export const ALLOWED_CTAS = {
  LEARN_MORE:  'Learn more',
  SIGN_UP:     'Sign up',
  GET_QUOTE:   'Get quote',
  CONTACT_US:  'Contact us',
  SUBSCRIBE:   'Subscribe',
  DOWNLOAD:    'Download',
  BOOK_NOW:    'Book now',
  GET_OFFER:   'Get offer',
  SEND_MESSAGE:'Send message',
};

export function normalizeCta(value) {
  if (!value) return 'LEARN_MORE';
  const up = String(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (ALLOWED_CTAS[up]) return up;
  // tolerate friendly labels ("Get quote" → GET_QUOTE)
  const byLabel = Object.entries(ALLOWED_CTAS)
    .find(([, label]) => label.toLowerCase() === String(value).toLowerCase());
  return byLabel ? byLabel[0] : 'LEARN_MORE';
}

// ── Pure copy helpers (no network — unit-testable) ───────────────────────────

// Build the copy prompt: agency playbook + this customer's RAG + a strict
// instruction to return ONLY a JSON array of `count` variations.
export function buildCopyPrompt(ragContent, count = 3) {
  return `${AGENCY_COPY_PLAYBOOK}

────────────────────────────────────────
THIS CLIENT'S RAG (their voice, offers, audience, pains, banned words — obey it):
────────────────────────────────────────
${(ragContent || '').trim()}

────────────────────────────────────────
TASK
────────────────────────────────────────
Write ${count} DIFFERENT Facebook ad variations for this client, each taking a
distinct angle/hook (different pain or moment — not rewrites of one another).

Return ONLY a JSON array of exactly ${count} objects, no preamble, no markdown
fences. Each object must have exactly these keys:
  "hook_label"   — 3–6 word internal label for the angle (e.g. "the quote that goes quiet")
  "primary_text" — the main ad copy, following the formula, ~2–4 short lines
  "headline"     — under ~40 characters, punchy
  "cta"          — one of: LEARN_MORE, SIGN_UP, GET_QUOTE, CONTACT_US, SUBSCRIBE, DOWNLOAD, BOOK_NOW, GET_OFFER, SEND_MESSAGE
  "image_brief"  — a short literal description of the supporting visual (no text/logo in the image)`;
}

// Robustly parse the model's reply into an array of raw variation objects.
// Tolerates code fences and leading/trailing prose; returns [] on failure.
export function parseVariations(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let t = raw.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!t.startsWith('[')) {
    const a = t.indexOf('[');
    const b = t.lastIndexOf(']');
    if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
  }
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Clamp one raw variation to a clean, stored shape.
export function normalizeCreative(v) {
  v = v || {};
  const s = (x) => (x === null || x === undefined) ? '' : String(x).trim();
  return {
    hook_label:   s(v.hook_label) || 'Untitled angle',
    primary_text: s(v.primary_text),
    headline:     s(v.headline),
    cta:          normalizeCta(v.cta),
    image_brief:  s(v.image_brief),
  };
}
