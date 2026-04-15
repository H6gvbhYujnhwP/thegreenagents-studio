import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export async function generateImage(prompt) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-preview-image-generation' });

  const enhancedPrompt = `${prompt}. Professional LinkedIn business image, clean composition, no text or words in the image, photorealistic, high quality, suitable for B2B social media.`;

  const response = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: enhancedPrompt }] }],
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
