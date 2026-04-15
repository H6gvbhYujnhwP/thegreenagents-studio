/**
 * gemini.js — Image generation using Nano Banana style via Gemini API
 *
 * Implements the Universal NANO BANNA Image Generation specification:
 * - Extracts brand identity (name, vibe, audience) from client record
 * - Scroll-stopper design: bold typography, high contrast
 * - Brand name/logo text included on every image (bottom right)
 * - Bold text allowed when post requires it (quote, stat, jargon buster)
 * - 16:9 landscape format for standard posts, 1:1 for carousels
 * - Tailored to the specific post topic, angle, and buyer segment
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Generate a LinkedIn post image in Nano Banana style.
 *
 * @param {string} imagePrompt - Post-specific visual guidance from GPT-4o
 * @param {object} client - Full client record from DB (name, brand, etc.)
 * @param {object} post - The post object (topic, angle, buyer_segment, format)
 */
export async function generateImage(imagePrompt, client = {}, post = {}) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-preview-image-generation'
  });

  const brandName   = client.brand || client.name || 'Brand';
  const audience    = post.buyer_segment || 'business professionals';
  const format      = (post.format || 'Text Post').toLowerCase();
  const isCarousel  = format.includes('carousel');
  const topic       = post.topic || '';
  const angle       = post.angle || '';

  // Determine aspect ratio and slide type per Nano Banana spec
  const aspectRatio = isCarousel ? '1:1 square' : '16:9 landscape';
  const slideNote   = isCarousel
    ? 'This is a CAROUSEL COVER SLIDE — make the title provocative and short (max 8 words) to force the viewer to click next.'
    : 'Standard LinkedIn post image.';

  const nanoBananaPrompt = `Generate a LinkedIn post visual in the NANO BANNA style.

BRAND: ${brandName}
TARGET AUDIENCE: ${audience}
POST TOPIC: ${topic}
POST ANGLE: ${angle}
FORMAT: ${aspectRatio} — ${slideNote}

VISUAL BRIEF FROM POST:
${imagePrompt}

NANO BANNA STYLE REQUIREMENTS — follow all of these strictly:

1. SCROLL-STOPPER: Design must make a professional stop scrolling. Use bold typography, high-contrast split screens, strong colour blocking, or an immediately recognisable visual hook.

2. BRAND IDENTITY: Apply a professional colour palette that suits ${brandName}'s industry and audience. Use 2 dominant colours maximum — high contrast, clean, corporate.

3. TEXT ON IMAGE: You MAY include bold text if it strengthens the visual (e.g. a short provocative stat, a 1-line hook, or a section title). Keep any text under 15 words. Text must be large and legible on mobile.

4. BRAND NAME: The text "${brandName}" MUST appear clearly at the bottom right of the image in a clean, professional font — this is the brand signature on every image.

5. ASPECT RATIO: ${aspectRatio}. Fill the entire frame — no white borders, no padding.

6. AUDIENCE FIT: The image should immediately signal relevance to ${audience}. Use visual metaphors, environments, or abstract graphics that resonate with their world.

7. NO STOCK PHOTO CLICHÉS: No handshakes, no generic laptop photos, no people pointing at whiteboards. Use bold graphic design, strong typography, or meaningful imagery.

8. QUALITY: High resolution, professional grade, suitable for B2B LinkedIn.`;

  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: nanoBananaPrompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
  });

  const parts = response.response.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imagePart) throw new Error('No image returned from Gemini');

  return {
    data: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType
  };
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
