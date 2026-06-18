/**
 * brand-extract.js — Pull a structured visual-brand block out of a client's
 * RAG document so image generation can follow the brand instead of inventing
 * colours.
 *
 * WHY THIS EXISTS
 * The RAG document is already the source of truth for post TEXT (voice, offers,
 * audience). It now also carries a visual-brand section (colours, logo,
 * typography, ad layout, what-to-avoid). This module reads that prose ONCE and
 * turns it into four short, machine-usable fields stored on the clients row:
 *
 *   brand_colors      — the palette + how to use it (e.g. dark background + green accent + white text)
 *   logo_description  — what the logo looks like (NOT used to draw a logo — the
 *                       real uploaded file is always composited; this is context)
 *   type_style        — typography style in plain words (no exact font names needed)
 *   visual_style      — layout / photography / mood + an explicit AVOID list
 *
 * Those four fields then feed BOTH image engines (gemini.js plain path and
 * openai-image.js designed-ad path). One source (the RAG), one extracted block,
 * every generated image follows it.
 *
 * SAFETY
 * - Never throws. If there's no API key, no RAG, or the model returns junk, it
 *   returns an object of nulls. Callers treat null fields as "leave unchanged".
 * - Uses Haiku (cheap, fast) — a single call per RAG upload, not per image.
 * - Asks for JSON only and parses defensively (strips code fences, finds the
 *   first {...} block) so a stray sentence from the model can't break it.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.BRAND_EXTRACT_MODEL || 'claude-haiku-4-5-20251001';

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// The shape every caller can rely on. All-null = "found nothing usable".
const EMPTY = {
  brand_colors:     null,
  logo_description: null,
  type_style:       null,
  visual_style:     null,
};

const SYSTEM = `You read a company's marketing/brand RAG document and extract ONLY its visual branding so an image generator can match the brand.

Return a single JSON object and nothing else. No prose, no markdown, no code fences. Start with { and end with }.

Keys (every value is a SHORT plain-text string, or null if the document does not say):
- "brand_colors": the colour palette AND how to use it. Include hex codes when present and the primary combination rule. One or two sentences. Example: "Dark graphite #1a1a1a background, vivid green #77A734 accent, white #FFFFFF text. Primary combination: graphite background + green accent + white text."
- "logo_description": what the logo looks like, in plain words. One sentence.
- "type_style": the typography style in plain words (e.g. "bold condensed all-caps headlines, clean sans-serif body"). Do not worry about exact font names.
- "visual_style": the overall creative direction for adverts/social images — layout, photography/mood, headline and call-to-action style — PLUS an explicit list of what to AVOID if the document states it. Two or three sentences.

Rules:
- Use ONLY what the document actually says. Do not invent colours or rules.
- If the document has a dedicated visual-brand or ad-creative section, base your answer on it.
- If the document says nothing about a key, set that key to null. Do not guess.
- Keep each value short — these go straight into an image prompt.`;

// Strip code fences and isolate the first balanced-looking JSON object.
function safeParseJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = s.slice(start, end + 1);
  try { return JSON.parse(slice); } catch (_) { return null; }
}

// Normalise one extracted field: trim, collapse whitespace, null out empties
// and obvious "not found" sentinels the model sometimes emits anyway.
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === 'null' || low === 'none' || low === 'n/a' || low === 'not specified' || low === 'not stated') return null;
  // Keep it sane for an image prompt — hard cap so a runaway answer can't bloat it.
  return s.slice(0, 600);
}

/**
 * Extract the visual-brand block from a RAG document.
 * @param {string} ragContent - the full RAG text stored on the clients row.
 * @returns {Promise<{brand_colors,logo_description,type_style,visual_style}>}
 *          Each field is a short string or null. Never throws.
 */
export async function extractBrandFromRag(ragContent) {
  const text = (ragContent || '').trim();
  if (!text) return { ...EMPTY };
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[brand-extract] ANTHROPIC_API_KEY not set — skipping brand extraction.');
    return { ...EMPTY };
  }

  // The RAG can be long; the visual-brand section is what we need. Send a
  // generous slice (most RAGs are well under this) — Haiku handles it cheaply.
  const ragForModel = text.slice(0, 60000);

  try {
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `RAG DOCUMENT:\n\n${ragForModel}\n\nExtract the visual branding as the JSON object described.`,
      }],
    });

    const raw = (resp.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    const parsed = safeParseJson(raw);
    if (!parsed) {
      console.warn('[brand-extract] Model response was not parseable JSON — returning nulls.');
      return { ...EMPTY };
    }

    const out = {
      brand_colors:     clean(parsed.brand_colors),
      logo_description: clean(parsed.logo_description),
      type_style:       clean(parsed.type_style),
      visual_style:     clean(parsed.visual_style),
    };

    const found = Object.values(out).filter(Boolean).length;
    console.log(`[brand-extract] Extracted ${found}/4 brand fields from RAG (model ${MODEL}).`);
    return out;
  } catch (err) {
    console.warn(`[brand-extract] Extraction failed (non-fatal): ${err.message}`);
    return { ...EMPTY };
  }
}
