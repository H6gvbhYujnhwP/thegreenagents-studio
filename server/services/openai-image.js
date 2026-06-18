/**
 * openai-image.js — Designed-ad image generation via OpenAI gpt-image-2.
 *
 * PILOT ENGINE. Selected per-client by clients.image_engine === 'gpt_image'.
 * The dispatcher lives at the top of services/gemini.js generateImage(), so
 * call sites (campaigns.js, portal.js) are unchanged.
 *
 * This is the OPPOSITE approach to gemini.js. Gemini makes a plain photo with
 * no text/logo and we composite the real logo afterwards. gpt-image-2 instead
 * renders the COMPLETE designed ad in a single pass — background, headline,
 * CTA, footer bar, brand colours and logo together — the same approach the
 * Manus ad sets use (gpt-image-2 is the model behind Manus's "Forge" wrapper).
 *
 * Returns the SAME shape as gemini.js generateImage so it's a drop-in:
 *   { data, mimeType, preLogoData, preLogoMime }
 * gpt-image bakes the logo into the image, so there is no separate "pre-logo"
 * version — preLogoData mirrors data. NOTE: the portal's per-post logo
 * reposition dropdowns (recompositeLogoFromUrl) are a no-op for gpt_image
 * clients, because there is no clean logo-free base to re-stamp. That's
 * acceptable for the pilot; we can hide those controls for gpt_image clients
 * later if needed.
 *
 * FIRST CUT (this version): the logo is DESCRIBED in the prompt (from the
 * client's logo_description) rather than uploaded as a true reference image.
 * This uses the well-documented /v1/images/generations endpoint (JSON) and is
 * the safest way to get a working designed ad on the first live test. If logo
 * fidelity isn't good enough, the next step is to switch logo-bearing clients
 * to the /v1/images/edits endpoint and pass the real logo file as a reference
 * (Manus's approach) — banked as a follow-up, deliberately not in this cut.
 */

const OPENAI_KEY = () =>
  process.env.OPENAI_AI_KEY || process.env.OPENAI_API_KEY || '';

// Env-overridable so a future model bump (gpt-image-3, a dated snapshot, etc.)
// needs no code change.
const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';

// gpt-image-2 supports 1024x1024 (square), 1536x1024 (landscape) and
// 1024x1536 (portrait). Square is the safe, universally-good default for both
// LinkedIn and Facebook feeds and matches the Manus feed default.
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1024';

// Layout shells rotated across a set so 12+ images feel varied but on-brand.
// Picked by a stable hash of the post so the same post always gets the same
// layout (no flicker on regenerate).
const LAYOUTS = [
  'Split layout: a dramatic photo fills the left ~55%, a clean brand-colour panel on the right holds the headline and CTA.',
  'Full-bleed photo background with a strong dark-to-transparent gradient along the bottom third; headline and CTA sit over the gradient.',
  'Top two-thirds is the photo; a solid brand-colour band across the bottom third carries the headline in large text with the CTA.',
  'Bold colour-block design: minimal photo inset top-left, the rest a brand-colour field with an oversized headline and a clear CTA button.',
  'Diagonal split between a photo and a brand-colour field, headline spanning the join, CTA below.',
];

function pickLayout(seedStr) {
  const s = String(seedStr || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return LAYOUTS[h % LAYOUTS.length];
}

function buildPrompt(imagePrompt, client = {}, post = {}) {
  const brandName = client.brand || client.name || 'the brand';
  const colors    = (client.brand_colors || '').trim();
  const logoDesc  = (client.logo_description || '').trim();
  const typeStyle = (client.type_style || '').trim()
    || 'bold condensed sans-serif headline, clean modern sans-serif supporting text';
  const website   = (client.website || '').trim();
  const audience  = post.buyer_segment || 'business decision-makers';
  const topic     = (post.topic || '').trim();
  const angle     = (post.angle || '').trim();

  // The on-image headline. Kept short and drawn from the post's topic (falling
  // back to the angle). This is deliberately simple for the pilot; a dedicated
  // AI-written image headline can be added to post generation later.
  const headline = (topic || angle || brandName).toString().trim().slice(0, 90);

  const layout = pickLayout(`${topic}|${angle}|${brandName}`);

  const logoLine = logoDesc
    ? `LOGO: render the ${brandName} logo cleanly in one top corner, kept clear of the headline. The logo is: ${logoDesc}`
    : `LOGO: render a clean, simple "${brandName}" wordmark in one top corner, kept clear of the headline.`;

  const colourLine = colors
    ? `BRAND COLOURS: ${colors}. Use these for the accent panel/band, the CTA button and the footer bar. White or near-white for clean space.`
    : `BRAND COLOURS: a clean, professional, high-contrast palette consistent across the set.`;

  const footerLine = website
    ? `FOOTER: a solid brand-colour bar across the full width at the very bottom, containing the website "${website}" in clean white text.`
    : '';

  return [
    `A professional, polished, print-ready advertisement image for ${brandName}, aimed at ${audience}. It must look like a designed marketing creative, not a stock photo.`,
    ``,
    `LAYOUT: ${layout}`,
    ``,
    `BACKGROUND IMAGERY: ${imagePrompt || `a relevant, high-quality photographic scene for ${brandName}`}`,
    ``,
    `HEADLINE: large, bold, mobile-legible text reading exactly: "${headline}". Spelled correctly. Strong visual hierarchy.`,
    angle ? `SUPPORTING ANGLE (do not render verbatim, let it guide tone): ${angle}` : ``,
    `CALL TO ACTION: a clear rounded rectangle button in a brand colour with short white text such as "Find out more" or "Get in touch".`,
    logoLine,
    colourLine,
    `TYPOGRAPHY: ${typeStyle}.`,
    footerLine,
    ``,
    `STYLE: clean, modern, corporate, high contrast, clear hierarchy. Fill the entire frame edge to edge — no white border or padding. Any text must be correctly spelled and legible.`,
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
    // Intentionally minimal/safe params: model + prompt + size + n. No
    // quality/response_format passed, so we don't risk an invalid-parameter
    // error if gpt-image-2's secondary params differ. gpt-image returns
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
  const b64 = await generateViaApi(prompt);
  console.log(`[gpt-image] Success for: ${client.name || 'unknown'}`);

  // Logo is baked into the single-pass image, so there is no separate pre-logo
  // version; mirror the bytes to keep the return shape identical to gemini.js.
  return {
    data:        b64,
    mimeType:    'image/png',
    preLogoData: b64,
    preLogoMime: 'image/png',
  };
}
