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
 *
 * DARK-BACKGROUND ESCAPE HATCH (2026-05-12): the trim pipeline assumes the
 * logo's background is light/transparent so the corner pixel represents
 * "background to crop." That holds for most customers but breaks badly when
 * a customer (e.g. The Manson Group) uploads a logo with a dark background.
 * Sharp's trim sees the dark corner, treats it as the reference colour, and
 * the threshold-of-30 ends up matching irregular gradient/vignette pixels
 * around the wordmark — cropping into the wordmark itself. The Manson
 * upload visibly lost the "GROUP" subtitle this way.
 *
 * Detection: sample the four corner pixels; compute luminance per pixel
 * (Rec. 601: 0.299R + 0.587G + 0.114B); take the MEDIAN of the four. If
 * that's below 120 (well below the ~220+ a light-background logo would
 * show), classify as dark-background and SKIP THE TRIM ENTIRELY. The file
 * uploads to R2 unchanged. The compositor's white-panel placement still
 * works visually because most dark-bg logos are themselves rectangles with
 * their own framing — a white panel underneath them just becomes a thin
 * margin, not a problem. (If a future customer complains "I want my posts
 * to use my dark brand colour for the panel instead of white," that's a
 * separate change to the compositor — Option 3 in the design discussion.)
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

    // Dark-background escape hatch. We only check opaque sources here —
    // transparent PNGs by definition have alpha at the corners (which is what
    // Sharp's trim looks at), so the corner-luminance test would be both
    // unreliable and unnecessary. Transparent logos already trim cleanly
    // because the trim target is "transparent" not "this colour."
    if (!srcHasAlpha) {
      const corner = await medianCornerLuminance(buffer, srcMeta);
      if (corner !== null && corner < DARK_BG_LUMINANCE_THRESHOLD) {
        console.log(
          `[logo-prep] Dark background detected (median corner luminance ${corner.toFixed(0)} < ${DARK_BG_LUMINANCE_THRESHOLD}) — skipping trim, preserving original.`
        );
        return { buffer, mimetype, ext: extFromMime(mimetype) };
      }
    }

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

// Luminance below which we classify a logo's background as "dark" and skip
// the trim path. 120 chosen as a safe midpoint: a light/cream logo background
// reads as 220+ luminance, the Manson dark-blue reads as ~46, mid-grey reads
// as ~128. 120 captures dark and mid-dark backgrounds while leaving genuine
// off-whites and pale tints in the trim path. If a future logo reads in the
// 100-140 range and gets the wrong classification, this is the dial to
// adjust — log line above prints the exact median so the right value is
// always inferable from Render logs.
const DARK_BG_LUMINANCE_THRESHOLD = 120;

// Compute the median luminance of the four corner pixels of an image. Uses
// the Rec. 601 luma formula: Y = 0.299R + 0.587G + 0.114B. Median (not mean)
// because a single odd-corner pixel (e.g. a logo touching one corner with a
// bit of foreground colour) shouldn't flip the classification — three light
// corners and one dark corner stays "light."
//
// Returns null on any error so the caller falls through to the existing
// trim path — fail-open is consistent with the rest of this module.
async function medianCornerLuminance(buffer, meta) {
  try {
    const w = meta.width;
    const h = meta.height;
    if (!w || !h || w < 2 || h < 2) return null;

    // Extract the four corners as 1x1 RGB samples. extract() is much cheaper
    // than raw pixel decoding the whole image and works on any input format
    // Sharp can decode.
    const corners = [
      { left: 0,     top: 0 },
      { left: w - 1, top: 0 },
      { left: 0,     top: h - 1 },
      { left: w - 1, top: h - 1 },
    ];

    const lumas = [];
    for (const c of corners) {
      const { data } = await sharp(buffer)
        .extract({ left: c.left, top: c.top, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      // data is a 3-byte Buffer [R, G, B].
      const r = data[0], g = data[1], b = data[2];
      lumas.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
    lumas.sort((a, b) => a - b);
    // Median of 4 = average of the two middle values.
    return (lumas[1] + lumas[2]) / 2;
  } catch (_) {
    return null;
  }
}

function extFromMime(mimetype) {
  if (mimetype === 'image/png')  return 'png';
  if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') return 'jpg';
  if (mimetype === 'image/webp') return 'webp';
  if (mimetype === 'image/svg+xml') return 'svg';
  return 'png';
}
