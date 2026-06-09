// ─────────────────────────────────────────────────────────────────────────────
// Facebook Ads — creative generation (decision #106, stage 2).
//
// Studio generates ad creatives for a customer: ad COPY via Claude (in the
// customer's RAG voice + the agency playbook) and an IMAGE via the same Gemini
// pipeline used for LinkedIn posts (with the customer's logo composited on),
// hosted in R2. NOTHING here touches Facebook — that's stage 3.
//
// Reuses the proven LinkedIn building blocks:
//   - generateImage()    from services/gemini.js  (image + logo composite)
//   - uploadImageToR2()   from services/r2.js
// Copy uses the Anthropic SDK directly (same pattern as the other services).
//
// Pure helpers (buildCopyPrompt / parseVariations / normalizeCreative) are
// exported so they can be unit-tested without any network calls.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { generateImage } from './gemini.js';
import { uploadImageToR2 } from './r2.js';
import { buildCopyPrompt, parseVariations, normalizeCreative } from './facebook-ads-playbook.js';

const COPY_MODEL = process.env.FB_ADS_COPY_MODEL || 'claude-sonnet-4-5';

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Build the copy prompt, parse the model's JSON, and normalize each variation —
// all live in facebook-ads-playbook.js (pure, unit-testable) and are imported above.

// Internal: one Claude call returning the raw text. `jsonOnly` adds an
// aggressive system override used on a retry if the first parse failed.
async function callClaude(prompt, jsonOnly = false) {
  const system = jsonOnly
    ? 'You output ONLY a valid JSON array. No prose, no markdown, no code fences. Start with [ and end with ].'
    : 'You are an expert UK direct-response Facebook ads copywriter. Follow the playbook and the client RAG exactly.';
  const resp = await client().messages.create({
    model: COPY_MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

// Build the client-shaped object the Gemini pipeline expects. Reads the
// customer's saved Brand Panel defaults (position/panel/size) — falling back to
// bottom-right / white / small (the LinkedIn defaults). If the customer has no
// logo_url, generateImage simply skips compositing.
function clientObjFor(customer) {
  return {
    id:            customer.id,
    name:          customer.name || 'Brand',
    brand:         customer.name || 'Brand',
    logo_url:      customer.logo_url || null,
    logo_position: customer.logo_position || 'bottom-right',
    logo_panel:    customer.logo_panel    || 'white',
    logo_size:     customer.logo_size     || 'small',
  };
}

// Generate one image for a variation and host it in R2. Returns
// { image_url, pre_logo_image_url }. Image failure is non-fatal — the creative
// is still saved with copy and a null image (the UI shows "New image" to retry).
async function makeImage(customer, v) {
  const brief = v.image_brief || v.headline || v.primary_text || `${customer.name} advert`;
  const post = { format: 'image', topic: v.hook_label, angle: v.headline, buyer_segment: '' };
  const img = await generateImage(brief, clientObjFor(customer), post);
  const image_url = await uploadImageToR2(img.data, img.mimeType, customer.id, 'fbad');
  let pre_logo_image_url = null;
  if (img.preLogoData) {
    try { pre_logo_image_url = await uploadImageToR2(img.preLogoData, img.preLogoMime, customer.id, 'fbad-prelogo'); }
    catch (e) { console.warn('[fb-ads-gen] pre-logo upload failed (non-fatal):', e.message); }
  }
  return { image_url, pre_logo_image_url };
}

// MAIN: generate `count` creatives for a customer.
//   customer  — { id (email_client_id), name, logo_url }
//   ragContent — the customer's stored RAG text (required)
// Returns an array of creative objects (copy + image_url + pre_logo_image_url).
export async function generateAdCreatives(customer, ragContent, { count = 3 } = {}) {
  if (!ragContent || !ragContent.trim()) {
    throw new Error('No RAG document uploaded for this customer');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const prompt = buildCopyPrompt(ragContent, count);
  let raw = await callClaude(prompt);
  let variations = parseVariations(raw);
  if (variations.length === 0) {
    // one retry with the JSON-only override (same belt-and-braces as LinkedIn)
    raw = await callClaude(prompt, true);
    variations = parseVariations(raw);
  }
  if (variations.length === 0) {
    throw new Error('Could not parse ad copy from the model after a retry');
  }

  variations = variations.slice(0, count).map(normalizeCreative);

  const out = [];
  for (const v of variations) {
    let image = { image_url: null, pre_logo_image_url: null };
    try {
      image = await makeImage(customer, v);
    } catch (e) {
      console.warn('[fb-ads-gen] image generation failed (non-fatal):', e.message);
    }
    out.push({ ...v, ...image });
  }
  return out;
}

// Rewrite the COPY of one existing creative (keeps the image). Returns
// { hook_label, primary_text, headline, cta, image_brief }.
export async function regenerateAdCopy(ragContent, existing = {}) {
  if (!ragContent || !ragContent.trim()) throw new Error('No RAG document uploaded for this customer');
  const prompt = `${buildCopyPrompt(ragContent, 1)}

Make this clearly DIFFERENT from the current version below:
hook: ${existing.hook_label || ''}
headline: ${existing.headline || ''}
primary_text: ${existing.primary_text || ''}`;
  let variations = parseVariations(await callClaude(prompt));
  if (variations.length === 0) variations = parseVariations(await callClaude(prompt, true));
  if (variations.length === 0) throw new Error('Could not parse rewritten copy');
  return normalizeCreative(variations[0]);
}

// Make a fresh IMAGE for one existing creative (keeps the copy). Returns
// { image_url, pre_logo_image_url }.
export async function regenerateAdImage(customer, creative) {
  return makeImage(customer, {
    image_brief: creative.image_brief,
    headline: creative.headline,
    primary_text: creative.primary_text,
    hook_label: creative.hook_label,
  });
}
