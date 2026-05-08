/**
 * logo-backfill.js — One-shot startup backfill that re-trims any logo
 * uploaded before the trim-at-upload pipeline shipped.
 *
 * Background: prior to this change, customer logos were stored raw in R2 and
 * trimmed inline by the post compositor on every regen. The trim step was
 * data-dependent and produced slightly different output on consecutive runs,
 * which made the white logo panel visibly larger on some posts than others
 * within the same campaign (Tower Leasing's "Post 1 vs Post 2" report).
 *
 * After the fix:
 *   - New uploads are trimmed at upload time (services/logo-prep.js) and the
 *     trimmed bytes are what land in R2.
 *   - The compositor no longer trims — it just resizes the already-trimmed
 *     file. Identical input → identical output → identical panel size on
 *     every post forever.
 *
 * This module covers the gap for ALREADY-uploaded logos. On startup it walks
 * every clients/email_clients row where logo_url IS NOT NULL AND
 * logo_processed_at IS NULL, fetches the raw file, trims it via the same
 * helper the upload routes use, uploads the trimmed version to a fresh R2
 * key under the same prefix, and updates the DB row to point at the new URL
 * with logo_processed_at stamped.
 *
 * Fire-and-forget: kicked off from index.js after the server is listening.
 * If a single logo fails to backfill it logs and moves on. The original raw
 * file is left in place in R2 — we point the DB at the new trimmed file but
 * don't delete the old object (avoids a race where a stale frontend tab
 * could 404 mid-deploy). R2 lifecycle policies can clean those up later if
 * storage cost becomes a concern.
 *
 * Idempotent: rows with logo_processed_at set are skipped, so re-running on
 * subsequent boots is a no-op for everyone except newly-added rows that
 * predate this code (e.g. if a row was inserted by a slow-syncing path
 * before its logo was ever trimmed).
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { prepareLogoForStorage } from './logo-prep.js';

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Process a single row: fetch its current logo, trim, re-upload, update DB.
 *
 * @param {string} table  Either 'clients' or 'email_clients'.
 * @param {string} id     Row primary key.
 * @param {string} url    Current logo_url value (public R2 URL).
 * @returns {Promise<{ ok: boolean, newUrl?: string, reason?: string }>}
 */
async function backfillOne(table, id, url) {
  // Guess R2 key from the public URL by stripping the public prefix.
  // This is safe because every logo we've ever stored has a key starting
  // with `logos/...` and the public URL is just `${R2_PUBLIC_URL}/${key}`.
  const publicPrefix = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  let scope, ownerId;
  if (publicPrefix && url.startsWith(publicPrefix + '/')) {
    const oldKey = url.slice(publicPrefix.length + 1);
    // Expected shape: logos/<scope>/<ownerId>/logo-<uuid>.<ext>
    //              or logos/<ownerId>/logo-<uuid>.<ext>     (LinkedIn-side)
    const parts = oldKey.split('/');
    if (parts[0] === 'logos') {
      if (parts.length === 4) { scope = parts[1]; ownerId = parts[2]; }
      else if (parts.length === 3) { scope = null; ownerId = parts[1]; }
    }
  }
  if (!ownerId) {
    // Couldn't parse — fall back to the row's own id and a default scope.
    ownerId = id;
    scope = (table === 'email_clients') ? 'portal' : null;
  }

  // Fetch the current logo bytes from the public R2 URL.
  let buffer, mimetype;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, reason: `fetch ${r.status}` };
    buffer = Buffer.from(await r.arrayBuffer());
    mimetype = r.headers.get('content-type') || 'image/png';
  } catch (err) {
    return { ok: false, reason: `fetch threw: ${err.message}` };
  }

  // Trim via the shared helper.
  let prepped;
  try {
    prepped = await prepareLogoForStorage(buffer, mimetype);
  } catch (err) {
    return { ok: false, reason: `prep threw: ${err.message}` };
  }

  // Build a fresh R2 key — same prefix shape, new uuid suffix. The old key
  // stays in place untouched.
  const newKey = scope
    ? `logos/${scope}/${ownerId}/logo-${uuid()}.${prepped.ext}`
    : `logos/${ownerId}/logo-${uuid()}.${prepped.ext}`;

  try {
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         newKey,
      Body:        prepped.buffer,
      ContentType: prepped.mimetype,
    }));
  } catch (err) {
    return { ok: false, reason: `put threw: ${err.message}` };
  }

  const newUrl = `${publicPrefix}/${newKey}`;
  return { ok: true, newUrl };
}

/**
 * Walk every un-processed logo row and backfill it. Splits the work between
 * `clients` (LinkedIn-side) and `email_clients` (portal-side), then performs
 * the cross-sync on each clients row so any portal_link'd email_clients row
 * also gets the new URL stamped (matching the live cross-sync behaviour of
 * the upload routes).
 */
export async function backfillLogos() {
  // LinkedIn-side rows.
  const linkedinRows = db.prepare(`
    SELECT id, logo_url FROM clients
    WHERE logo_url IS NOT NULL AND logo_processed_at IS NULL
  `).all();

  // Portal-side rows that are NOT just mirrors of a LinkedIn row. We process
  // these independently because some portal customers have their own logo
  // uploaded via the portal-admin route directly.
  const portalRows = db.prepare(`
    SELECT id, logo_url FROM email_clients
    WHERE logo_url IS NOT NULL AND logo_processed_at IS NULL
  `).all();

  if (linkedinRows.length === 0 && portalRows.length === 0) {
    console.log('[logo-backfill] No rows need processing — nothing to do.');
    return;
  }

  console.log(`[logo-backfill] Starting: ${linkedinRows.length} clients row(s) + ${portalRows.length} email_clients row(s) need processing.`);

  let succeeded = 0, failed = 0, skipped = 0;

  // Process clients first — when one succeeds we propagate to any linked
  // email_clients rows so they get marked processed in the same pass.
  for (const row of linkedinRows) {
    const result = await backfillOne('clients', row.id, row.logo_url);
    if (!result.ok) {
      console.warn(`[logo-backfill] clients[${row.id}] failed: ${result.reason}`);
      failed++;
      continue;
    }
    db.prepare(`
      UPDATE clients
      SET logo_url = ?, logo_processed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(result.newUrl, row.id);

    // Cross-sync: same join the live upload route uses (customer_services
    // OR legacy linkedin_client_id). If the linked email_clients row was
    // also unprocessed, this stamps it so the portal pass below will skip
    // it as already-handled.
    db.prepare(`
      UPDATE email_clients
      SET logo_url = ?, logo_processed_at = datetime('now')
      WHERE id IN (
        SELECT email_client_id FROM customer_services
        WHERE service_key = 'linkedin' AND linked_external_id = ?
        UNION
        SELECT id FROM email_clients WHERE linkedin_client_id = ?
      ) AND logo_processed_at IS NULL
    `).run(result.newUrl, row.id, row.id);

    succeeded++;
    console.log(`[logo-backfill] clients[${row.id}] processed → ${result.newUrl}`);
  }

  // Now process portal rows that weren't already covered by the cross-sync.
  // Re-read the rows because the cross-sync above may have stamped some.
  const remainingPortalRows = db.prepare(`
    SELECT id, logo_url FROM email_clients
    WHERE logo_url IS NOT NULL AND logo_processed_at IS NULL
  `).all();

  for (const row of remainingPortalRows) {
    const result = await backfillOne('email_clients', row.id, row.logo_url);
    if (!result.ok) {
      console.warn(`[logo-backfill] email_clients[${row.id}] failed: ${result.reason}`);
      failed++;
      continue;
    }
    db.prepare(`
      UPDATE email_clients
      SET logo_url = ?, logo_processed_at = datetime('now')
      WHERE id = ?
    `).run(result.newUrl, row.id);
    succeeded++;
    console.log(`[logo-backfill] email_clients[${row.id}] processed → ${result.newUrl}`);
  }

  // Anything that was stamped by cross-sync above counts as "skipped" (the
  // portal row was handled by its LinkedIn counterpart).
  skipped = portalRows.length - remainingPortalRows.length;

  console.log(`[logo-backfill] Done. Succeeded=${succeeded} Failed=${failed} Skipped(cross-synced)=${skipped}.`);
}
