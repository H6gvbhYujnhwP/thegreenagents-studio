// ─────────────────────────────────────────────────────────────────────────────
// Facebook Ads — creative generation (decision #106, REVIVED + upgraded).
//
// Studio generates ad creatives for a customer: ad COPY via Claude (in the
// customer's RAG voice + the agency playbook) and a designed-ad IMAGE via
// gpt-image-2 (the same engine LinkedIn uses), on the customer's brand colours,
// with the customer's logo composited on, hosted in R2. NOTHING here touches
// Facebook — pushing approved ads to Facebook is the next stage.
//
// Reuses the proven building blocks:
//   - generateGptImage()  from services/openai-image.js  (designed ad + logo)
//   - uploadImageToR2()    from services/r2.js
// Copy uses the Anthropic SDK directly (same pattern as the other services).
//
// Standalone from LinkedIn: the brand block (colours, type, visual style) comes
// from the customer's FACEBOOK row (facebook_ads.*), passed in on `customer`.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { generateGptImage } from './openai-image.js';
import { uploadImageToR2 } from './r2.js';
import { buildCopyPrompt, parseVariations, normalizeCreative, ALLOWED_CTAS } from './facebook-ads-playbook.js';

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

// Build the client-shaped object the image pipeline expects. Carries the
// customer's FACEBOOK brand block (colours/type/visual style — extracted from
// the Facebook RAG) so gpt-image-2 renders on-brand, plus the logo + saved
// Brand Panel defaults (position/panel/size). If there's no logo_url, the
// compositor simply skips compositing.
function clientObjFor(customer) {
  return {
    id:            customer.id,
    name:          customer.name || 'Brand',
    brand:         customer.brand || customer.name || 'Brand',
    brand_colors:     customer.brand_colors     || null,
    type_style:       customer.type_style       || null,
    visual_style:     customer.visual_style     || null,
    logo_description: customer.logo_description  || null,
    logo_url:      customer.logo_url || null,
    logo_position: customer.logo_position || 'bottom-right',
    logo_panel:    customer.logo_panel    || 'white',
    logo_size:     customer.logo_size     || 'small',
  };
}

// Generate one designed ad for a variation and host it in R2. Returns
// { image_url, pre_logo_image_url }. Image failure is non-fatal — the creative
// is still saved with copy and a null image (the UI shows "New image" to retry).
async function makeImage(customer, v, overrides = {}) {
  const brief = v.image_brief || v.headline || v.primary_text || `${customer.name} advert`;
  // headline → rendered into the designed ad; hook_label → tone/layout guidance;
  // cta → the friendly label baked onto the button.
  const post = {
    topic: v.headline || v.hook_label || '',
    angle: v.hook_label || '',
    cta: ALLOWED_CTAS[v.cta] || 'Find out more',
    buyer_segment: '',
  };
  const img = await generateGptImage(brief, clientObjFor({ ...customer, ...overrides }), post);
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
    image_brief:  creative.image_brief,
    headline:     creative.headline,
    primary_text: creative.primary_text,
    hook_label:   creative.hook_label,
    cta:          creative.cta,
  });
}
