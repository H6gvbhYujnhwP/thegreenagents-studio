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
  const PADDING    = 20;

  // Trim solid-colour padding off the file before resizing.
  //
  // Some customers upload logos with built-in white margin around the actual
  // artwork (e.g. a 2586x669 file where the wordmark only fills the middle
  // 60%). Without this trim, our resize step preserves the padding and the
  // composited logo looks visibly "boxed in" — a chunky white rectangle
  // around the wordmark on every generated image.
  //
  // We branch on whether the source is transparent or opaque, because the
  // two cases need different handling:
  //
  //   Opaque source (JPEG, opaque PNG with built-in white padding):
  //     Trim with a generous threshold (30) to catch JPEG compression noise
  //     around artwork edges that would otherwise read as a coloured tint
  //     when placed on a dark base image. Flatten onto pure white so the
  //     corner pixels my downstream detection samples are unambiguous.
  //
  //   Transparent source (real PNG with alpha):
  //     Trim removes the transparent border (tighter crop of just artwork).
  //     We do NOT flatten — that'd fill the artwork's transparent regions
  //     with white and remove the customer's reliance on the auto-patch
  //     path. Output keeps its alpha so my downstream detection sees
  //     transparent corners and adds the white patch behind it.
  //
  // For tightly-cropped logos either way, trim is a no-op. If trim throws
  // (e.g. entire image is one colour — extreme edge case) we fall back to
  // the original buffer so image generation still succeeds.
  let logoForResize = logoBuffer;
  try {
    const srcMeta = await sharp(logoBuffer).metadata();
    const srcHasAlpha = srcMeta.channels === 4 || srcMeta.hasAlpha;
    if (srcHasAlpha) {
      logoForResize = await sharp(logoBuffer)
        .trim({ threshold: 30 })
        .png()
        .toBuffer();
    } else {
      logoForResize = await sharp(logoBuffer)
        .trim({ threshold: 30 })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer();
    }
  } catch (err) {
    console.warn(`[gemini] Logo trim failed (using untrimmed): ${err.message}`);
  }

  const logoResized = await sharp(logoForResize)
    .resize(LOGO_MAX_W, LOGO_MAX_H, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const logoMeta = await sharp(logoResized).metadata();
  const logoW    = logoMeta.width;
  const logoH    = logoMeta.height;

  // Detect the JPEG-renamed-to-PNG case (decision #38, third real customer
  // case — Sweetbyte). These files have opaque corners with dark/coloured
  // fill that, if we let our patch-colour heuristic see them, can produce a
  // dark patch on a light image and merge with the logo's own bad dark
  // background. So we sample the four corner pixels — if all four are
  // opaque AND not near-white (luminance < ~200), we know the logo has dark
  // baked-in corners and force a WHITE patch regardless of what the image's
  // bottom-right luminance says.
  //
  // We previously also branched on "logo has its own white background → skip
  // the panel entirely" for files like Tower Leasing's. That branch has been
  // removed: it produced inconsistent results across runs (Sharp's trim is
  // data-dependent and the same file could pass or fail the four-corner
  // test on consecutive generations) and customers with white-bg logos
  // looked visibly cropped against the image. Every logo now gets the same
  // panel treatment. The customer's own white background simply blends into
  // the panel — no harm, fully consistent.
  //
  // Errors fall through to "no override" — safer than accidentally forcing
  // white in cases that don't need it.
  const NEAR_WHITE_LUMINANCE = 200;
  let logoHasOpaqueDarkCorners = false;
  try {
    const logoRaw = await sharp(logoResized).raw().toBuffer({ resolveWithObject: true });
    const channels = logoRaw.info.channels;
    const data = logoRaw.data;
    const w = logoRaw.info.width;
    const h = logoRaw.info.height;
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
    logoHasOpaqueDarkCorners = corners.every(c => c.alpha === 255 && c.luminance < NEAR_WHITE_LUMINANCE);
    if (logoHasOpaqueDarkCorners) {
      console.warn(`[gemini] Logo at ${logoUrl} has opaque dark corners — likely a JPEG renamed to .png. Forcing a white patch behind it. Customer should re-upload a transparent PNG for cleaner output.`);
    }
  } catch (err) {
    console.warn(`[gemini] Logo corner sample failed (no patch override): ${err.message}`);
  }

  const patchW = logoW + PADDING * 2;
  const patchH = logoH + PADDING * 2;
  const patchX = width  - patchW - 16;
  const patchY = height - patchH - 16;

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
