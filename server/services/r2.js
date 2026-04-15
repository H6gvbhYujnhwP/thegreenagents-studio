import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

export async function uploadImageToR2(base64Data, mimeType, clientId, postId) {
  const ext = mimeType.split('/')[1] || 'jpg';
  const key = `images/${clientId}/${postId}-${uuid()}.${ext}`;
  const buffer = Buffer.from(base64Data, 'base64');

  try {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType
    }));
  } catch (err) {
    console.error('[r2] Upload failed:', {
      code: err.Code || err.code || err.$metadata?.httpStatusCode,
      message: err.message,
      bucket: process.env.R2_BUCKET_NAME,
      endpoint: process.env.R2_ENDPOINT,
      keyId: (process.env.R2_ACCESS_KEY_ID || '').slice(0, 8) + '...'
    });
    throw new Error(`R2 upload failed (${err.Code || err.$metadata?.httpStatusCode || 'unknown'}): ${err.message}`);
  }

  return `${process.env.R2_PUBLIC_URL}/${key}`;
}
