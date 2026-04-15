/**
 * extractText.js — Extract plain text from uploaded files.
 * Supports: .pdf (via pdfjs-dist), .txt, .md, .csv, and other text formats.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Extract text from a file buffer based on its filename.
 * @param {Buffer} buffer - The file buffer from multer
 * @param {string} filename - Original filename (used to detect type)
 * @returns {Promise<string>} - Extracted plain text
 */
export async function extractTextFromBuffer(buffer, filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) {
    return extractPdfText(buffer);
  }
  // .txt, .md, .csv, etc.
  return buffer.toString('utf-8');
}

async function extractPdfText(buffer) {
  const uint8 = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data: uint8 }).promise;
  const pageTexts = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let pageText = '';
    let lastY = null;
    for (const item of content.items) {
      if (item.str === undefined) continue;
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
        pageText += '\n';
      }
      pageText += item.str;
      if (item.hasEOL) pageText += '\n';
      lastY = item.transform[5];
    }
    pageTexts.push(pageText.trim());
  }

  const fullText = pageTexts.join('\n\n');
  if (!fullText.trim()) {
    throw new Error('PDF has no extractable text (may be scanned/image). Please use .txt or .md instead.');
  }
  return fullText;
}
