/**
 * gemini.js - Image generation using Nano Banana (gemini-2.5-flash-image)
 *
 * Two-stage pipeline:
 *
 *   Stage 1 (generation): Gemini produces a 1024x1024 image based on the
 *   prompt. We hold onto the raw bytes (the "pre-logo image") so they can
 *   be re-composited later with different per-post logo settings without
 *   another AI call.
 *
 *   Stage 2 (composite): Sharp pastes the customer's logo into one of four
 *   corners, at one of three sizes, with or without a white panel behind
 *   it. Three concerns are per-customer (Position default, Background panel,
 *   Size default) and live on the clients row. Position and Size can be
 *   OVERRIDDEN per-post — passed as the `overrides` arg, falling back to
 *   the client-level value when null/missing.
 *
 * Callers get back BOTH the pre-logo image and the final composited image
 * so they can store the pre-logo bytes in R2. That lets the customer
 * portal's per-post logo dropdowns re-composite without re-calling Gemini
 * (cheap, fast, no AI cost). Falls back to text brand signature if no
 * logo is uploaded.
 */

import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateImage(imagePrompt, client = {}, post = {}) {
  const brandName  = client.brand || client.name || 'Brand';
  const audience   = post.buyer_segment || 'business professionals';
  const format     = (post.format || 'Text Post').toLowerCase();
  const isCarousel = format.includes('carousel');
  const topic      = post.topic || '';
  const angle      = post.angle || '';
  const hasLogo    = !!client.logo_url;

  const aspectNote   = isCarousel ? '1:1 square format' : '16:9 landscape format';
  const carouselNote = isCarousel
    ? 'This is a CAROUSEL COVER SLIDE — title must be provocative and short (max 8 words) to force the viewer to swipe next.'
    : 'Standard LinkedIn post image.';

  // Brand-mark rule (logo customers only).
  //
  // Earlier wording asked Gemini to "leave the bottom-right 320x140px area
  // relatively clear (no text, no important design elements)." That worked
  // for protecting the logo zone from being covered by content — but it
  // also caused Gemini to render a visibly LIGHTER, cleaner-looking patch
  // in that exact rectangle, treating the instruction as a positive design
  // brief rather than a constraint. On busy/dirty backgrounds (e.g. Cube6's
  // factory-floor scenes) the lighter patch was clearly visible as a faint
  // halo extending above and left of our actual white logo panel.
  //
  // Softer wording was tried — "don't place text or the main subject in
  // the [corner]" — but that left the door wide open for Gemini to draw
  // a brand signature, watermark, or invented logo SOMEWHERE ELSE in the
  // image. With the prompt header saying "Generate a LinkedIn post visual
  // for ${brandName}", Gemini routinely stamps "${brandName}" in a clean
  // font with a small emblem in the opposite corner — producing a TWO-LOGO
  // image once we paste the real customer logo via post-processing. First
  // reported on The Manson Group ('top-right' position, AI stamping a fake
  // 'MANSON' wordmark in the bottom-right).
  //
  // Current rule below: explicit blanket ban on any brand mark, watermark,
  // logo, company name, or signature ANYWHERE in the image. Tells Gemini
  // the real logo will be added in post-processing and which corner to
  // keep clear of subjects/text so our paste lands cleanly. Applies to
  // every customer with a logo file uploaded.
  //
  // The corner is per-customer: defaults to 'bottom-right' (current
  // behaviour for every customer pre-this-feature), but configurable via
  // clients.logo_position. The Manson Group is the first customer to use
  // 'top-right' — their dark-blue logo reads better above the content,
  // and top-right is also less likely to clash with Gemini's tendency to
  // stamp headline text near the bottom of the image.
  const logoPosition = client.logo_position || 'bottom-right';
  const cornerLabel = {
    'bottom-right': 'bottom-right',
    'top-right':    'top-right',
    'bottom-left':  'bottom-left',
    'top-left':     'top-left'
  }[logoPosition] || 'bottom-right';

  const brandSignatureRule = hasLogo
    ? `7. NO BRAND MARK ANYWHERE: Do NOT include any logo, watermark, company name, brand signature, or text reading "${brandName}" anywhere in the image — not in any corner, not as a decorative element, not as part of any sign, screen, label, or background. The real logo will be added separately in post-processing. Keep your main subject and headline text away from the ${cornerLabel} corner so the logo placement lands cleanly there.`
    : `7. BRAND SIGNATURE: The text "${brandName}" MUST appear clearly at the bottom right in a clean professional font. If background is dark use white text; if light use dark text.`;

  const nanoBananaPrompt = `Generate a LinkedIn post visual in the NANO BANNA style for ${brandName}.

BRAND: ${brandName}
AUDIENCE: ${audience}
POST TOPIC: ${topic}
POST ANGLE: ${angle}
FORMAT: ${aspectNote} — ${carouselNote}

VISUAL BRIEF:
${imagePrompt}

NANO BANNA STYLE RULES:

1. SCROLL-STOPPER: Bold typography, high-contrast colour blocking, or a striking visual hook.

2. TEXT ALLOWED: Include bold text if it strengthens the visual (a short stat, a hook, or a title). Maximum 15 words. Large and mobile-legible.

3. COLOUR: 2 dominant colours, high contrast, professional and relevant to ${audience}.

4. ${aspectNote.toUpperCase()}: Fill the entire frame — no white borders or padding.

5. NO CLICHÉS: No handshakes, no generic laptop photos, no people pointing at whiteboards.

6. AUDIENCE: Visually signals immediate relevance to ${audience}.

${brandSignatureRule}`;

  // gemini-2.5-flash-image is the current working model. The other two are
  // kept as fallbacks in case Google retires it again. Put the working model
  // first so we skip a wasted ~150ms 404 round trip on every generation.
  const MODEL_CANDIDATES = [
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-preview-image-generation',
    'gemini-2.0-flash-preview-image-generation',
  ];

  let response = null;
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      console.log(`[gemini] Trying model: ${modelName}`);
      response = await ai.models.generateContent({
        model: modelName,
        contents: nanoBananaPrompt,
        config: { responseModalities: ['TEXT', 'IMAGE'] }
      });
      console.log(`[gemini] Success with model: ${modelName}`);
      break;
    } catch (err) {
      console.warn(`[gemini] Model ${modelName} failed: ${err.message?.slice(0, 150)}`);
      lastError = err;
      if (err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) throw err;
    }
  }

  if (!response) throw lastError || new Error('All Gemini image models failed');

  const parts     = response.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (!imagePart) throw new Error('Gemini responded but returned no image');

  // The raw Gemini bytes are the "pre-logo image" — we hold onto these so
  // they can be re-composited later when the customer adjusts per-post logo
  // settings, without re-calling Gemini. Callers MUST persist these bytes
  // to R2 alongside the final composited image; the per-post recomposite
  // endpoint reads them back from R2 storage.
  const preLogoData = imagePart.inlineData.data;
  const preLogoMime = imagePart.inlineData.mimeType;

  let finalData = preLogoData;
  let finalMime = preLogoMime;

  if (hasLogo) {
    try {
      finalData = await compositeLogo(preLogoData, preLogoMime, client);
      finalMime  = 'image/png';
      console.log(`[gemini] Logo composited for: ${client.name}`);
    } catch (err) {
      console.warn(`[gemini] Logo composite failed (non-fatal): ${err.message}`);
    }
  }

  return {
    // Final composited image — what gets shown to the customer in the portal.
    data:     finalData,
    mimeType: finalMime,
    // Pre-logo image — Gemini's raw output before any logo paste-in.
    // Persist this to R2 too. The per-post recomposite endpoint fetches it
    // from R2 to redo Stage 2 with different position/size overrides.
    preLogoData,
    preLogoMime,
  };
}

// ── Compositor ──────────────────────────────────────────────────────────────
//
// Reads three per-customer brand settings off the client row (with
// defaults that match the original always-bottom-right / always-white /
// small behaviour, so every pre-existing customer is unchanged):
//
//   client.logo_position — corner the logo lands in
//     'bottom-right' (default) | 'top-right' | 'bottom-left' | 'top-left'
//
//   client.logo_panel    — whether a white panel sits behind the logo
//     'white' (default) | 'none'
//
//   client.logo_size     — max dimensions the resized logo is fit to
//     'small' (default — max 280×100) | 'medium' (480×160) | 'large' (640×220)
//
// Optional `overrides` arg lets a single post override Position, Size, and
// Background panel without changing the customer-level default. Used by
// the per-post re-composite endpoint when the customer changes the
// dropdowns on a specific post card. Customer-level defaults still apply
// to fresh image generation and to posts where the customer hasn't
// overridden the relevant field.
//
// All settings are independent — a customer can have any combination. The
// Manson Group is the first to use a non-default combo: top-right + none +
// large, because their logo has its own dark-blue background built into
// the file and reads better directly on the image than fenced inside a
// white box.
//
// Trade-off on 'none' panel: the logo will sit directly on the generated
// image's pixels, so a customer choosing this option is relying on their
// logo having either (a) a built-in opaque background of its own (Manson's
// dark-blue rectangle) or (b) enough contrast against typical Gemini
// output to read clearly. We don't try to detect-and-warn; the operator
// chose the setting deliberately and the fix when it fails is regenerate
// the image (already a button in both admin and customer portal).
export async function compositeLogo(imageBase64, imageMime, client, overrides = {}) {
  const logoUrl  = client.logo_url;
  const position = overrides.logo_position || client.logo_position || 'bottom-right';
  const panel    = overrides.logo_panel    || client.logo_panel    || 'white';
  const size     = overrides.logo_size     || client.logo_size     || 'small';

  const logoResponse = await fetch(logoUrl);
  if (!logoResponse.ok) throw new Error(`Failed to fetch logo: ${logoResponse.status}`);
  const logoBuffer = Buffer.from(await logoResponse.arrayBuffer());

  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const baseImage   = sharp(imageBuffer);
  const { width, height } = await baseImage.metadata();

  // Size table. Small matches the original 280×100 — every existing
  // customer keeps the same dimensions on first deploy. Large is roughly
  // 2× the small width, matching the "twice as big" Manson ask. Medium
  // sits in between for the rare future customer who wants prominence
  // without going to a half-image-width logo.
  const SIZE_TABLE = {
    small:  { w: 280, h: 100 },
    medium: { w: 480, h: 160 },
    large:  { w: 640, h: 220 }
  };
  const { w: LOGO_MAX_W, h: LOGO_MAX_H } = SIZE_TABLE[size] || SIZE_TABLE.small;

  // No trim step here — by design. Trim is data-dependent (Sharp's threshold
  // detection looks at actual pixel values, which can shift between calls
  // due to compression noise, anti-aliasing, or floating-point rounding).
  // Earlier versions trimmed inline on every regen, which produced the
  // "Post 1's logo panel is bigger than Post 2's" variance bug on Tower
  // Leasing.
  //
  // Trim now happens once, at upload time, in services/logo-prep.js. The
  // file in R2 is the canonical pre-trimmed form. Compositor just resizes
  // it — every post gets identical bytes, identical dimensions, identical
  // panel size. See services/logo-prep.js for full rationale.
  const logoResized = await sharp(logoBuffer)
    .resize(LOGO_MAX_W, LOGO_MAX_H, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const logoMeta = await sharp(logoResized).metadata();
  const logoW    = logoMeta.width;
  const logoH    = logoMeta.height;

  // Padding around the wordmark on the white panel is 20% of the logo's
  // smaller dimension AFTER resize, floor 8px. Same rule as before — see
  // decision #55 for the proportional-vs-fixed rationale. Only applies
  // when panel === 'white'; with panel === 'none' there is no padding
  // because there's no panel to pad against.
  const PADDING = panel === 'white'
    ? Math.max(8, Math.round(Math.min(logoW, logoH) * 0.20))
    : 0;

  // Inset of the whole placement from the image edge. 16px matches the
  // pre-feature constant and reads as comfortable on a 1024px image at
  // every supported logo size.
  const EDGE_INSET = 16;

  // Outer placement dimensions = logo + (panel padding × 2 if panelled).
  const placementW = logoW + PADDING * 2;
  const placementH = logoH + PADDING * 2;

  // Pick the corner. Each branch sets the top-left of the placement
  // rectangle; the logo then centres inside it (or sits at the placement
  // origin when there's no panel and PADDING is 0, which is the same
  // pixel either way).
  let placementX, placementY;
  switch (position) {
    case 'top-right':
      placementX = width  - placementW - EDGE_INSET;
      placementY = EDGE_INSET;
      break;
    case 'bottom-left':
      placementX = EDGE_INSET;
      placementY = height - placementH - EDGE_INSET;
      break;
    case 'top-left':
      placementX = EDGE_INSET;
      placementY = EDGE_INSET;
      break;
    case 'bottom-right':
    default:
      placementX = width  - placementW - EDGE_INSET;
      placementY = height - placementH - EDGE_INSET;
  }

  const compositeOps = [];

  // Add the white panel only when requested. With 'none' the logo
  // sits directly on the generated image — relies on the logo file
  // having its own readable background or sufficient inherent
  // contrast.
  if (panel === 'white') {
    const patchSvg = `<svg width="${placementW}" height="${placementH}">
      <rect width="${placementW}" height="${placementH}" rx="6" ry="6" fill="rgba(255,255,255,1.0)"/>
    </svg>`;
    const patchBuffer = await sharp(Buffer.from(patchSvg))
      .resize(placementW, placementH)
      .png()
      .toBuffer();
    compositeOps.push({ input: patchBuffer, left: placementX, top: placementY, blend: 'over' });
  }

  // Logo placement. When panelled, the logo centres inside the panel.
  // When panel === 'none', PADDING is 0 so logo sits at the placement
  // origin (which is already inset 16px from the image edge).
  const logoLeft = placementX + PADDING;
  const logoTop  = placementY + Math.floor((placementH - logoH) / 2);
  compositeOps.push({ input: logoResized, left: logoLeft, top: logoTop, blend: 'over' });

  const composited = await sharp(imageBuffer)
    .composite(compositeOps)
    .png()
    .toBuffer();

  return composited.toString('base64');
}

// ── Per-post re-compositor ─────────────────────────────────────────────────
//
// Called by the customer portal when the customer changes the per-post
// logo position or size dropdowns. Fetches the previously-stored pre-logo
// image from R2, runs compositeLogo with the override values, returns
// the new base64 ready for re-upload.
//
// No AI call — purely Sharp pixel-pushing. ~200-500ms typical, near-zero
// cost. Critical to the "immediate visual feedback when the dropdown
// changes" experience.
//
// Throws if the pre-logo image can't be fetched (e.g. R2 outage, or the
// post was generated before the pre-logo storage feature shipped — in
// which case there's no pre-logo URL to fetch from). Callers should
// surface the second case as "click New image first" so the customer
// understands the path forward.
export async function recompositeLogoFromUrl(preLogoUrl, client, overrides = {}) {
  const r = await fetch(preLogoUrl);
  if (!r.ok) throw new Error(`Failed to fetch pre-logo image: ${r.status}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  const base64 = buffer.toString('base64');

  // Sharp will detect the actual mime from the buffer; pass image/png as
  // a reasonable default since R2 doesn't return the original content-type
  // in a way we need here.
  const composited = await compositeLogo(base64, 'image/png', client, overrides);
  return { data: composited, mimeType: 'image/png' };
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
