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

  const brandSignatureRule = hasLogo
    ? `7. BOTTOM RIGHT CORNER: Leave the bottom-right 320x140px area relatively clear (no text, no important design elements) — a logo will be composited there in post-processing.`
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

  const MODEL_CANDIDATES = [
    'gemini-2.5-flash-preview-image-generation',
    'gemini-2.5-flash-image',
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
  const PADDING    = 16;

  const logoResized = await sharp(logoBuffer)
    .resize(LOGO_MAX_W, LOGO_MAX_H, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const logoMeta = await sharp(logoResized).metadata();
  const logoW    = logoMeta.width;
  const logoH    = logoMeta.height;

  // Auto-detect whether the logo has its own opaque background.
  //
  // The original design assumed all logos were transparent PNGs and added a
  // contrasting white/black patch behind every one for readability. But some
  // customers upload logos that already have a built-in white background
  // (e.g. Tower Leasing). For those, the patch is redundant and produces a
  // visible thin line where the patch edge meets the logo's own rectangle —
  // two near-white shapes overlapping on a darker base image.
  //
  // We sample the four corner pixels' alpha channel:
  //   - All four corners opaque (alpha=255) → logo has its own background,
  //     skip the patch.
  //   - Any corner has transparency → logo expects a patch behind it, keep
  //     the existing behaviour.
  //
  // The middle of every logo is opaque (that's the artwork), so we can't
  // sample there. Corners are reliable: a transparent-background logo has
  // alpha=0 at the corners; a logo with rounded-corner artwork on a coloured
  // background still has alpha=255 at the rectangle corners. Errors fall
  // through to "keep the patch" — safer than accidentally dropping it.
  let logoHasOwnBackground = false;
  try {
    const logoRaw = await sharp(logoResized).raw().toBuffer({ resolveWithObject: true });
    const channels = logoRaw.info.channels;
    if (channels === 4) {
      const data = logoRaw.data;
      const w = logoRaw.info.width;
      const h = logoRaw.info.height;
      // Index of alpha byte for pixel (x, y) is (y * w + x) * 4 + 3.
      const alphaAt = (x, y) => data[(y * w + x) * 4 + 3];
      const corners = [
        alphaAt(0, 0),
        alphaAt(w - 1, 0),
        alphaAt(0, h - 1),
        alphaAt(w - 1, h - 1),
      ];
      logoHasOwnBackground = corners.every(a => a === 255);
    }
    // channels === 3 means the PNG was saved without an alpha channel at all
    // (fully opaque). That's also "logo has its own background."
    if (channels === 3) {
      logoHasOwnBackground = true;
    }
  } catch (err) {
    console.warn(`[gemini] Logo alpha sample failed (keeping patch): ${err.message}`);
  }

  const patchW = logoW + PADDING * 2;
  const patchH = logoH + PADDING * 2;
  const patchX = width  - patchW - 16;
  const patchY = height - patchH - 16;

  // If the logo has its own background, place it directly on the image with
  // no padding patch behind it. We still inset it from the corner by the
  // same 16px the patch path uses, so the visual position is consistent.
  if (logoHasOwnBackground) {
    const logoLeft = width  - logoW - 16;
    const logoTop  = height - logoH - 16;
    const composited = await sharp(imageBuffer)
      .composite([
        { input: logoResized, left: logoLeft, top: logoTop, blend: 'over' }
      ])
      .png()
      .toBuffer();
    return composited.toString('base64');
  }

  // Analyse corner brightness to determine patch colour
  const cornerPixels = await sharp(imageBuffer)
    .extract({ left: Math.max(0, patchX), top: Math.max(0, patchY), width: patchW, height: patchH })
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer();

  let totalLuminance = 0;
  const pixelCount = cornerPixels.length / 3;
  for (let i = 0; i < cornerPixels.length; i += 3) {
    totalLuminance += 0.299 * cornerPixels[i] + 0.587 * cornerPixels[i+1] + 0.114 * cornerPixels[i+2];
  }
  const avgLuminance = totalLuminance / pixelCount;

  // Dark corner → white patch; Light corner → dark patch
  // Use high opacity so logos of any colour stand out clearly
  const useDarkPatch = avgLuminance > 128;
  const patchRgba    = useDarkPatch ? 'rgba(10,10,10,0.92)' : 'rgba(255,255,255,0.95)';

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
