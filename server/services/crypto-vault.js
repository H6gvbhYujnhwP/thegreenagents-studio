/**
 * crypto-vault.js — AES-256-GCM for encrypting secrets at rest.
 *
 * Used for IMAP app passwords stored in the email_inboxes table.
 *
 * The master key comes from MAILBOX_ENCRYPTION_KEY env var. Generate it once with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * and paste the resulting 44-char base64 string into Render's env vars.
 *
 * If the master key is rotated, all existing ciphertexts become unreadable —
 * so don't rotate it without a migration plan. For now the master key lives in
 * one Render env var and you keep a copy somewhere offline.
 *
 * Format on disk: base64(iv|tag|ciphertext)
 *   - iv:        12 bytes (96 bits, GCM standard)
 *   - tag:       16 bytes (auth tag)
 *   - ciphertext: variable length, equal to the plaintext length
 */

import crypto from 'crypto';

const KEY_ENV = 'MAILBOX_ENCRYPTION_KEY';

function getKey() {
  const b64 = process.env[KEY_ENV];
  if (!b64) {
    throw new Error(`${KEY_ENV} env var not set. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    throw new Error(`${KEY_ENV} must be a 32-byte key (base64-encoded). Got ${buf.length} bytes.`);
  }
  return buf;
}

export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(ciphertextB64) {
  if (!ciphertextB64) return null;
  const key = getKey();
  const buf = Buffer.from(ciphertextB64, 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('ciphertext too short');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8');
}

// Self-test on import — fail fast at boot if key is misconfigured.
// Safe to skip if env var isn't set yet (the encrypt/decrypt calls themselves will throw).
export function selfTest() {
  if (!process.env[KEY_ENV]) return { ok: false, reason: `${KEY_ENV} not set` };
  try {
    const sample = 'imap-test-' + Date.now();
    const ct = encrypt(sample);
    const pt = decrypt(ct);
    if (pt !== sample) return { ok: false, reason: 'encrypt/decrypt round-trip mismatch' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
