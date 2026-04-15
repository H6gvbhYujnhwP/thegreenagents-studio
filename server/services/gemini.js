/**
 * gemini.js — Image generation using Nano Banana (gemini-2.5-flash-image)
 *
 * "Nano Banana" IS gemini-2.5-flash-image — Google's codename for this model.
 * Uses the new @google/genai SDK (replaces deprecated @google/generative-ai).
 *
 * Implements the Universal NANO BANNA Image Generation specification:
 * - Brand name on every image (bottom right)
 * - Scroll-stopper design: bold typography, high contrast
 * - Text on image allowed (hooks, stats, short titles ≤15 words)
 * - 16:9 landscape for text posts, 1:1 for carousel covers
 * - Audience-tailored visuals from post.buyer_segment
 * - No stock photo clichés
 */

import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Generate a LinkedIn post image in Nano Banana style.
 * @param {string} imagePrompt  - Post-specific visual guidance from GPT-4o
 * @param {object} client       - Client record (name, brand, etc.)
 * @param {object} post         - Post object (topic, angle, buyer_segment, format)
 */
export async function generateImage(imagePrompt, client = {}, post = {}) {
  const brandName  = client.brand || client.name || 'Brand';
  const audience   = post.buyer_segment || 'business professionals';
  const format     = (post.format || 'Text Post').toLowerCase();
  const isCarousel = format.includes('carousel');
  const topic      = post.topic || '';
  const angle      = post.angle || '';

  const aspectNote  = isCarousel ? '1:1 square format' : '16:9 landscape format';
  const carouselNote = isCarousel
    ? 'This is a CAROUSEL COVER SLIDE — title must be provocative and short (max 8 words) to force the viewer to swipe next.'
    : 'Standard LinkedIn post image.';

  const nanoBananaPrompt = `Generate a LinkedIn post visual in the NANO BANNA style for ${brandName}.

BRAND: ${brandName}
AUDIENCE: ${audience}
POST TOPIC: ${topic}
POST ANGLE: ${angle}
FORMAT: ${aspectNote} — ${carouselNote}

VISUAL BRIEF:
${imagePrompt}

NANO BANNA STYLE RULES — apply all strictly:

1. SCROLL-STOPPER: Bold typography, high-contrast colour blocking, or an immediately striking visual hook. Make a professional stop scrolling.

2. BRAND SIGNATURE: The text "${brandName}" MUST appear clearly at the bottom right in a clean professional font.

3. TEXT ALLOWED: Include bold text if it strengthens the visual (a short stat, a 1-line hook, or a section title). Maximum 15 words. Large and mobile-legible.

4. COLOUR: 2 dominant colours, high contrast, professional and relevant to ${audience}.

5. ${aspectNote.toUpperCase()}: Fill the entire frame — no white borders or padding.

6. NO CLICHÉS: No handshakes, no generic laptop photos, no people pointing at whiteboards. Use bold graphic design or meaningful imagery.

7. AUDIENCE: Visually signals immediate relevance to ${audience}.`;

  // Model name fallback chain — Google renames preview models frequently.
  // The 429 quota error revealed the internal quota name is gemini-2.5-flash-preview-image-generation.
  const MODEL_CANDIDATES = [
    'gemini-2.5-flash-preview-image-generation',  // confirmed internal name from quota metrics
    'gemini-2.5-flash-image',                     // shorthand alias
    'gemini-2.0-flash-preview-image-generation',  // fallback to 2.0
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
      // Stop immediately on quota exhaustion — no point trying other models
      if (err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) throw err;
    }
  }

  if (!response) throw lastError || new Error('All Gemini image models failed');

  const parts = response.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imagePart) throw new Error('Gemini responded but returned no image — model may not support image generation');

  return {
    data: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType
  };
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
