/**
 * gemini.js - Image generation using Nano Banana (gemini-2.5-flash-image)
 *
 * After Gemini generates the image, Sharp composites the client logo
 * into the bottom-right corner with an auto-contrasting background patch.
 * Falls back to text brand signature if no logo is uploaded.
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

  // BOTTOM RIGHT CORNER instruction (logo customers only).
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
  // Softer wording below: still tells Gemini not to put text or the focal
  // subject in the bottom-right (so our panel doesn't cover important
  // content), but without the dimensions and "clear area" framing that was
  // producing the halo. The panel itself is opaque white so anything
  // underneath the panel is hidden anyway — the only thing we actually
  // need from Gemini is "don't put your main subject there."
  const brandSignatureRule = hasLogo
    ? `7. BOTTOM RIGHT CORNER: Don't place text or the main subject in the bottom-right corner — a small logo will be added there in post-processing.`
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

  let imageData = imagePart.inlineData.data;
  let imageMime = imagePart.inlineData.mimeType;

  if (hasLogo) {
    try {
      imageData = await compositeLogoBottomRight(imageData, imageMime, client.logo_url);
      imageMime  = 'image/png';
      console.log(`[gemini] Logo composited for: ${client.name}`);
    } catch (err) {
      console.warn(`[gemini] Logo composite failed (non-fatal): ${err.message}`);
    }
  }

  return { data: imageData, mimeType: imageMime };
}

async function compositeLogoBottomRight(imageBase64, imageMime, logoUrl) {
  const logoResponse = await fetch(logoUrl);
  if (!logoResponse.ok) throw new Error(`Failed to fetch logo: ${logoResponse.status}`);
  const logoBuffer = Buffer.from(await logoResponse.arrayBuffer());

  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const baseImage   = sharp(imageBuffer);
  const { width, height } = await baseImage.metadata();

  const LOGO_MAX_W = 280;
  const LOGO_MAX_H = 100;

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
  // smaller dimension AFTER resize. This scales naturally:
  //
  //   - Tower Leasing's wide wordmark (~280x76 after resize)
  //       smaller dim = 76 → padding ≈ 15px → panel ≈ 310x106
  //
  //   - Cube6's compact logo + tagline (~100x100 after resize)
  //       smaller dim = 100 → padding ≈ 20px → panel ≈ 140x140
  //
  // Trade-off vs a fixed pixel padding: the panel size now varies per
  // customer, but in a way that matches their logo's intrinsic shape — so
  // every customer's panel reads as proportionally comfortable rather than
  // either cramped (small logo, fixed padding too tight) or boxy (compact
  // logo, fixed padding too generous). The previous attempt at fixed 40px
  // produced a visibly oversized panel around Cube6's small logo.
  //
  // Logo dimensions are fully deterministic per customer because trimming
  // now happens once at upload time. Same logo bytes → same resized
  // dimensions → same padding → same panel size, every post.
  //
  // Floor at 8px to guarantee a sliver of breathing room even on extreme
  // edge cases (e.g. a tiny logo that resizes to 30x30 — 20% would be 6,
  // and 6px padding visually fuses the wordmark into the panel edge).
  const PADDING = Math.max(8, Math.round(Math.min(logoW, logoH) * 0.20));

  const patchW = logoW + PADDING * 2;
  const patchH = logoH + PADDING * 2;
  const patchX = width  - patchW - 16;
  const patchY = height - patchH - 16;

  // Panel is always solid white. We previously had a heuristic that picked
  // dark-vs-white based on the image's bottom-right brightness, plus a
  // separate dark-corners override for JPEG-as-PNG logos. Both are gone.
  //
  // Why: every real customer logo we've shipped (Cube6's dark-on-transparent,
  // Tower Leasing's dark-green-on-white, Sweetbyte's dark-on-dark JPEG-fill)
  // reads cleanly on white. The only case where white fails is a white-on-
  // transparent logo (light wordmark for dark backgrounds) — none of our
  // customers have one, and if a future customer did the right answer is to
  // ask them for a darker version of the file rather than re-introduce
  // detection branching.
  //
  // Predictability beats cleverness — same principle as decision #42 (one
  // unified panel path for every logo, no skip-the-panel branch). The
  // heuristic version produced a dark panel on Sweetbyte's regen because
  // the image's bottom-right orange band was bright, even though Sweetbyte's
  // logo is also dark — dark-on-dark, illegible.
  const patchRgba = 'rgba(255,255,255,1.0)';

  const patchSvg = `<svg width="${patchW}" height="${patchH}">
    <rect width="${patchW}" height="${patchH}" rx="6" ry="6" fill="${patchRgba}"/>
  </svg>`;

  const patchBuffer = await sharp(Buffer.from(patchSvg))
    .resize(patchW, patchH)
    .png()
    .toBuffer();

  const logoLeft = patchX + PADDING;
  const logoTop  = patchY + Math.floor((patchH - logoH) / 2);

  const composited = await sharp(imageBuffer)
    .composite([
      { input: patchBuffer, left: patchX,    top: patchY,   blend: 'over' },
      { input: logoResized, left: logoLeft,  top: logoTop,  blend: 'over' }
    ])
    .png()
    .toBuffer();

  return composited.toString('base64');
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
