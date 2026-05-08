/**
 * logo-prep.js — One-shot logo trimming at upload time.
 *
 * Background: every customer logo file goes through an identical pipeline
 * before it lands on a generated post — Sharp's `.trim()` strips solid-colour
 * margins so the wordmark sits flush against its white panel rather than
 * floating inside its own built-in padding.
 *
 * Originally that trim happened inline in the post compositor (gemini.js),
 * once per generated image. That was the source of the "Post 1's logo looks
 * bigger than Post 2's" bug on Tower Leasing — Sharp's `.trim()` is data-
 * dependent, so the same source file produced slightly different post-trim
 * dimensions on consecutive regenerations. With trim in the compositor, the
 * variance in the trimmed dimensions translated directly into variance in
 * the white panel size, post by post.
 *
 * Fix: trim ONCE, at upload time. The trimmed buffer is what gets uploaded
 * to R2 as the canonical logo file. Every subsequent post regen pulls that
 * already-trimmed file and skips the trim step entirely. Output is identical
 * across every regen of every post for that customer, forever.
 *
 * Two paths inside trimmed:
 *   - Transparent source (PNG with alpha): trim transparent + near-white
 *     border, KEEP alpha. The compositor places this onto a white panel —
 *     the alpha gives the artwork crisp edges against that panel.
 *   - Opaque source (JPEG, opaque PNG): trim, then flatten onto pure white.
 *     This kills any JPEG compression noise around the edges that would
 *     otherwise read as a coloured tint when composited on a dark base, and
 *     guarantees the file's pixels match the compositor's white panel.
 *
 * SVGs are passed through untouched — trimming a vector is meaningless and
 * Sharp's trim on rasterised SVGs would produce surprising results.
 *
 * Trim threshold of 30 chosen because logo artwork colours are usually 60+
 * luminance units away from white — safe to trim that aggressively without
 * cutting into the wordmark itself. Same threshold the old in-compositor
 * code used; this just moves the call upstream.
 */

import sharp from 'sharp';

/**
 * Trim a logo file buffer for canonical R2 storage.
 *
 * @param {Buffer} buffer       Raw uploaded file bytes.
 * @param {string} mimetype     Original mime type from the upload (or fetched
 *                              file). Used only to detect SVG (passthrough).
 * @returns {Promise<{buffer: Buffer, mimetype: string, ext: string}>}
 *          The trimmed buffer ready to upload, its new mime type, and the
 *          file extension to use in the R2 key. SVGs come back unchanged.
 *          Other types come back as PNG regardless of input format because
 *          we may have introduced an alpha channel via the trim path.
 */
export async function prepareLogoForStorage(buffer, mimetype) {
  // SVGs: pass through untouched. Trim on a vector is meaningless and we
  // don't want to rasterise SVGs at upload time — keep the file pristine
  // so the compositor can render it at any size cleanly.
  if (mimetype === 'image/svg+xml') {
    return { buffer, mimetype, ext: 'svg' };
  }

  try {
    const srcMeta     = await sharp(buffer).metadata();
    const srcHasAlpha = srcMeta.channels === 4 || srcMeta.hasAlpha;

    let trimmed;
    if (srcHasAlpha) {
      trimmed = await sharp(buffer)
        .trim({ threshold: 30 })
        .png()
        .toBuffer();
    } else {
      trimmed = await sharp(buffer)
        .trim({ threshold: 30 })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer();
    }
    return { buffer: trimmed, mimetype: 'image/png', ext: 'png' };
  } catch (err) {
    // Trim can throw on extreme edge cases (entire image one colour, fully
    // transparent file, etc.). In that case we keep the original — better
    // to ship the customer's logo as-is than to fail their upload outright.
    console.warn(`[logo-prep] Trim skipped, using original: ${err.message}`);
    return { buffer, mimetype, ext: extFromMime(mimetype) };
  }
}

function extFromMime(mimetype) {
  if (mimetype === 'image/png')  return 'png';
  if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') return 'jpg';
  if (mimetype === 'image/webp') return 'webp';
  if (mimetype === 'image/svg+xml') return 'svg';
  return 'png';
}
