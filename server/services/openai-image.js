/**
 * openai-image.js — Designed-ad image generation via OpenAI gpt-image-2.
 *
 * PILOT ENGINE. Selected per-client by clients.image_engine === 'gpt_image'.
 * The dispatcher lives at the top of services/gemini.js generateImage(), so
 * call sites (campaigns.js, portal.js) are unchanged.
 *
 * Approach (HYBRID — guarantees the real logo):
 *   1. gpt-image-2 generates the COMPLETE designed ad — background, headline,
 *      CTA, brand colours — in a single pass, but with NO logo and a corner
 *      left clear. This is the opposite of Gemini's plain-photo output: the
 *      design, layout and text are all the model's, like the Manus ad sets.
 *   2. Studio then composites the customer's REAL uploaded logo into that
 *      clear corner using the existing Sharp compositor in gemini.js — the
 *      exact same one the Gemini path uses. The model is told never to draw a
 *      logo, so it can't invent one; the only logo that ever appears is the
 *      uploaded file, pixel-for-pixel, for every customer.
 *
 * Returns the SAME shape as gemini.js generateImage so it's a drop-in:
 *   { data, mimeType, preLogoData, preLogoMime }
 * preLogoData is the no-logo designed ad, so the per-post logo reposition
 * dropdowns work for gpt_image clients too.
 *
 * SPELLING: gpt-image-2 renders text well but not perfectly. We minimise
 * errors by giving it short, exact text to render verbatim and few text
 * elements. The reliable safety net is the per-post "regenerate image" button
 * on the review screen.
 */

const OPENAI_KEY = () =>
  process.env.OPENAI_AI_KEY || process.env.OPENAI_API_KEY || '';

// Env-overridable so a future model bump needs no code change.
const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';

// gpt-image-2 supports 1024x1024 (square), 1536x1024 (landscape) and
// 1024x1536 (portrait). Square is the safe, universally-good default.
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1024';

// Layout shells rotated across a set so many images feel varied but on-brand.
// Picked by a stable hash of the post so the same post always gets the same
// layout (no flicker on regenerate).
const LAYOUTS = [
  'Split layout: a dramatic photo fills the left ~55%, a clean brand-colour panel on the right holds the headline and CTA.',
  'Full-bleed photo background with a strong dark-to-transparent gradient along the bottom third; headline and CTA sit over the gradient.',
  'Top two-thirds is the photo; a solid brand-colour band across the bottom third carries the headline with the CTA.',
  'Bold colour-block design: a small photo inset, the rest a brand-colour field with an oversized headline and a clear CTA button.',
  'Diagonal split between a photo and a brand-colour field, headline spanning the join, CTA below.',
];

function pickLayout(seedStr) {
  const s = String(seedStr || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return LAYOUTS[h % LAYOUTS.length];
}

// Trim a headline to a short, punchy length at a word boundary. Shorter text
// = far fewer spelling mistakes from the model.
function shortHeadline(str, maxLen = 60) {
  const s = String(str || '').trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

function buildPrompt(imagePrompt, client = {}, post = {}) {
  const brandName = client.brand || client.name || 'the brand';
  const colors    = (client.brand_colors || '').trim();
  const visualStyle = (client.visual_style || '').trim();
  const typeStyle = (client.type_style || '').trim()
    || 'bold condensed sans-serif headline, clean modern sans-serif supporting text';
  const audience  = post.buyer_segment || 'business decision-makers';
  const topic     = (post.topic || '').trim();
  const angle     = (post.angle || '').trim();

  const headline = shortHeadline(topic || angle || brandName, 60);
  const layout   = pickLayout(`${topic}|${angle}|${brandName}`);
  // CTA button label. Defaults to the LinkedIn wording; Facebook ads pass their
  // own Meta call-to-action label (e.g. "Get quote", "Book now").
  const cta = (post.cta || '').trim() || 'Find out more';

  // The corner to keep clear — matches where the real logo will be composited.
  const logoPosition = client.logo_position || 'bottom-right';
  const cornerLabel = {
    'bottom-right': 'bottom-right',
    'top-right':    'top-right',
    'bottom-left':  'bottom-left',
    'top-left':     'top-left',
  }[logoPosition] || 'bottom-right';

  const colourLine = colors
    ? `BRAND COLOURS (use these, do not substitute your own): ${colors}. Apply the stated primary combination across the background, accent panel/band and the CTA button so the ad is instantly recognisable as ${brandName}.`
    : `BRAND COLOURS: a clean, professional, high-contrast palette consistent across the set.`;

  // Overall creative direction + the explicit "avoid" rules, straight from the
  // RAG-extracted brand block. This is what makes the designed ad match the
  // customer's website and Facebook creative rather than a generic look.
  const styleLine = visualStyle
    ? `BRAND STYLE: Follow this creative direction and honour any "avoid" instructions in it — ${visualStyle}`
    : '';

  return [
    `A professional, polished, print-ready advertisement image for ${brandName}, aimed at ${audience}. It must look like a designed marketing creative, not a stock photo.`,
    ``,
    `LAYOUT: ${layout}`,
    ``,
    `BACKGROUND IMAGERY: ${imagePrompt || `a relevant, high-quality photographic scene for ${brandName}`}`,
    ``,
    `HEADLINE TEXT — render these exact words, do not change, add or remove any word, and spell every word exactly as written: "${headline}". Large, bold, mobile-legible, with strong visual hierarchy.`,
    angle ? `TONE (guidance only, do not render as text): ${angle}` : ``,
    `CALL TO ACTION: one clear rounded-rectangle button in a brand colour containing exactly the text "${cta}". No other words on the button.`,
    colourLine,
    styleLine,
    `TYPOGRAPHY: ${typeStyle}.`,
    ``,
    `NO LOGO: Do NOT draw any logo, watermark, brand mark, company name, monogram, emblem, or signature anywhere in the image. Keep the ${cornerLabel} corner clear of text and important subjects — a real logo will be added there afterwards. This is critical.`,
    ``,
    `SPELLING IS CRITICAL: every word in the image must be spelled correctly and exactly as given. Do not invent extra text. If a word is hard to render, use simpler wording rather than risk a misspelling.`,
    ``,
    `STYLE: clean, modern, corporate, high contrast, clear hierarchy. Fill the entire frame edge to edge — no white border or padding.`,
  ].filter(Boolean).join('\n');
}

async function generateViaApi(prompt) {
  const key = OPENAI_KEY();
  if (!key) throw new Error('OPENAI_AI_KEY is not set — cannot call gpt-image-2.');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    // Minimal/safe params: model + prompt + size + n. gpt-image returns
    // base64 (b64_json) by default.
    body: JSON.stringify({ model: MODEL, prompt, size: IMAGE_SIZE, n: 1 }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`gpt-image-2 request failed (${res.status}): ${detail}`);
  }

  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('gpt-image-2 responded but returned no image data.');
  return b64;
}

export async function generateGptImage(imagePrompt, client = {}, post = {}) {
  const prompt = buildPrompt(imagePrompt, client, post);
  console.log(`[gpt-image] Generating designed ad for: ${client.name || 'unknown'} (model ${MODEL})`);
  const rawB64 = await generateViaApi(prompt);   // designed ad WITHOUT a logo
  console.log(`[gpt-image] Base image generated for: ${client.name || 'unknown'}`);

  let finalData = rawB64;
  let finalMime = 'image/png';

  // Composite the customer's REAL uploaded logo into the reserved corner,
  // reusing the proven Sharp compositor in gemini.js. Dynamic import avoids a
  // static circular dependency (gemini.js imports this module). Non-fatal: if
  // compositing fails we still return the designed ad (just without the logo).
  if (client.logo_url) {
    try {
      const { compositeLogo } = await import('./gemini.js');
      finalData = await compositeLogo(rawB64, 'image/png', client);
      finalMime = 'image/png';
      console.log(`[gpt-image] Real uploaded logo composited for: ${client.name || 'unknown'}`);
    } catch (err) {
      console.warn(`[gpt-image] Logo composite failed (non-fatal): ${err.message}`);
    }
  }

  return {
    data:        finalData,
    mimeType:    finalMime,
    preLogoData: rawB64,        // no-logo designed ad — enables per-post recomposite
    preLogoMime: 'image/png',
  };
}
