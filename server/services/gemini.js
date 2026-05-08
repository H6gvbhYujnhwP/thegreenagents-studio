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

  // Auto-detect whether the logo has its own opaque, light background.
  //
  // The original design assumed all logos were transparent PNGs and added a
  // contrasting white/black patch behind every one for readability. But some
  // customers upload logos that already have a built-in white background
  // (e.g. Tower Leasing). For those, the patch is redundant and produces a
  // visible thin line where the patch edge meets the logo's own rectangle.
  //
  // We sample the four corner pixels and ask two questions:
  //   1. Are they fully opaque (alpha=255)?
  //   2. Are they near-white (luminance > ~235)?
  //
  // Both must be true to skip the patch. This catches a real failure mode
  // we saw with one customer who uploaded a JPEG renamed to .png — JPEGs
  // can't have transparency, so the alpha test alone said "logo has own
  // background" and the system pasted a black-cornered logo straight onto
  // generated images. By requiring near-white corners as well, we now treat
  // any logo with dark or coloured corners as "needs a patch" and force a
  // white panel behind it. Three real cases:
  //   - Transparent PNG (Cube6) → corners alpha=0 → patch added (correct)
  //   - White-bg PNG (Tower Leasing) → corners opaque+white → no patch (correct)
  //   - Black-bg JPEG-as-PNG (Sweetbyte) → corners opaque+dark → patch added (correct)
  //
  // The middle of every logo is opaque (that's the artwork), so we can't
  // sample there. Errors fall through to "keep the patch" — safer than
  // accidentally dropping it.
  const NEAR_WHITE_LUMINANCE = 235; // 0–255 scale; allows ~off-white papers
  let logoHasOwnBackground = false;
  let logoHasOpaqueDarkCorners = false; // broken file: JPEG-as-PNG with dark fill
  try {
    const logoRaw = await sharp(logoResized).raw().toBuffer({ resolveWithObject: true });
    const channels = logoRaw.info.channels;
    const data = logoRaw.data;
    const w = logoRaw.info.width;
    const h = logoRaw.info.height;
    // Returns { alpha, luminance } for a corner pixel. Luminance uses the
    // standard Rec. 601 formula — same one we use elsewhere in this file
    // for the patch-colour decision.
    const sampleCorner = (x, y) => {
      const i = (y * w + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const alpha = channels === 4 ? data[i + 3] : 255;
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      return { alpha, luminance };
    };
    const corners = [
      sampleCorner(0, 0),
      sampleCorner(w - 1, 0),
      sampleCorner(0, h - 1),
      sampleCorner(w - 1, h - 1),
    ];
    logoHasOwnBackground       = corners.every(c => c.alpha === 255 && c.luminance >= NEAR_WHITE_LUMINANCE);
    logoHasOpaqueDarkCorners   = corners.every(c => c.alpha === 255) && !logoHasOwnBackground;
    if (logoHasOpaqueDarkCorners) {
      console.warn(`[gemini] Logo at ${logoUrl} has opaque dark corners — likely a JPEG renamed to .png. Forcing a white patch behind it. Customer should re-upload a transparent PNG for cleaner output.`);
    }
  } catch (err) {
    console.warn(`[gemini] Logo corner sample failed (keeping patch): ${err.message}`);
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

  // Dark corner → white patch; Light corner → dark patch.
  // BUT if the logo has dark opaque corners (broken source file), we override
  // to white regardless — a dark patch would merge with the logo's own bad
  // dark background and make the rendering worse. Use high opacity so logos
  // of any colour stand out clearly.
  const useDarkPatch = !logoHasOpaqueDarkCorners && avgLuminance > 128;
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
