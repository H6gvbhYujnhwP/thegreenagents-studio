/**
 * SES email sender — bypasses AWS SDK entirely.
 * Makes raw HTTPS POST directly to SES API, signed with AWS Signature V4.
 * This is exactly how Sendy works (class.amazonses.php) and avoids the SDK
 * middleware that attaches account-level default configuration sets,
 * which cause AWS to inject the awstrack.me tracking pixel.
 *
 * Tracking is injected BEFORE handing to SES, so opens/clicks point to our
 * own domain — same approach as Sendy.
 */

import https from 'https';
import crypto from 'crypto';
import db from '../db.js';
import { v4 as uuid } from 'uuid';
import { applyTracking } from './tracking.js';
import { SESClient, GetSendQuotaCommand, ListIdentitiesCommand, GetIdentityVerificationAttributesCommand } from '@aws-sdk/client-ses';

const REGION  = process.env.AWS_SES_REGION || 'eu-north-1';
const HOST    = `email.${REGION}.amazonaws.com`;
const AK      = process.env.AWS_ACCESS_KEY_ID;
const SK      = process.env.AWS_SECRET_ACCESS_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── AWS Signature V4 ──────────────────────────────────────────────────────────
// IMPORTANT: when chaining HMACs, keep keys as Buffers — never digest('binary')
// and pass the resulting string back in. Node converts that string to UTF-8 when
// used as a key, which silently corrupts any byte ≥ 0x80, so signing fails
// roughly half the time depending on the secret. digest() with no arg returns
// a Buffer that round-trips correctly.
function hmacBuf(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function sign(date, region, service, secret) {
  const k1 = hmacBuf('AWS4' + secret, date);
  const k2 = hmacBuf(k1, region);
  const k3 = hmacBuf(k2, service);
  return hmacBuf(k3, 'aws4_request');
}

function buildAuthHeader(body) {
  const now      = new Date();
  const amzDate  = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date     = amzDate.slice(0, 8);
  const payHash  = crypto.createHash('sha256').update(body).digest('hex');

  const canonHeaders  = `content-type:application/x-www-form-urlencoded\nhost:${HOST}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonReq      = ['POST', '/', '', canonHeaders, signedHeaders, payHash].join('\n');

  const credScope  = `${date}/${REGION}/email/aws4_request`;
  const strToSign  = ['AWS4-HMAC-SHA256', amzDate, credScope, crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');
  const signingKey = sign(date, REGION, 'email', SK);
  const signature  = hmacHex(signingKey, strToSign);

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date':  amzDate,
  };
}

// ── Raw HTTPS POST to SES API ─────────────────────────────────────────────────
function sesRequest(params) {
  return new Promise((resolve, reject) => {
    // Sort params alphabetically — required for correct AWS Signature V4 (Sendy does ksort)
    const sorted = Object.keys(params).sort().reduce((acc, k) => { acc[k] = params[k]; return acc; }, {});
    const body   = new URLSearchParams(sorted).toString();
    const authHdr = buildAuthHeader(body);

    const options = {
      hostname: HOST,
      port:     443,
      path:     '/',
      method:   'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'host':         HOST,
        ...authHdr,
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`SES error ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Extract MessageId from SES XML response ───────────────────────────────────
function extractMessageId(xml) {
  const m = xml && xml.match(/<MessageId>([^<]+)<\/MessageId>/);
  return m ? m[1] : null;
}

// ── Build raw MIME email ──────────────────────────────────────────────────────
function buildRawEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody, listUnsubUrl }) {
  const boundary   = `b_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const toAddress  = toName ? `${toName} <${to}>` : to;
  const plain      = plainBody || htmlToPlain(htmlBody);
  const subjEnc    = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;

  const headers = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${toAddress}`,
    `Reply-To: ${replyTo || fromEmail}`,
    `Subject: ${subjEnc}`,
    `MIME-Version: 1.0`,
  ];

  // List-Unsubscribe headers (RFC 2369 + RFC 8058) — Gmail/Outlook deliverability win.
  // Only added when we have a campaign-bound unsubscribe URL.
  if (listUnsubUrl) {
    headers.push(`List-Unsubscribe: <${listUnsubUrl}>`);
    headers.push(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`);
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  return [
    ...headers,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    plain,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ].join('\r\n');
}

// ── Send a single email — raw SES API, no SDK middleware ─────────────────────
// If campaignId + subscriberId + baseUrl provided → tracking is injected.
// Returns { messageId } — used by sendCampaign to map bounces/complaints back.
export async function sendEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody, campaignId, subscriberId, baseUrl }) {
  let finalHtml = htmlBody;
  let listUnsubUrl = null;

  // Apply own-domain tracking (open pixel + click rewrite + unsub footer).
  // Only when we have campaign + subscriber context — test sends skip tracking.
  if (campaignId && subscriberId && baseUrl) {
    finalHtml = applyTracking(htmlBody, { baseUrl, campaignId, subscriberId });
    listUnsubUrl = `${baseUrl}/api/email/unsubscribe?sid=${subscriberId}&cid=${campaignId}`;
  }

  const raw = buildRawEmail({
    to, toName, fromName, fromEmail, replyTo, subject,
    htmlBody: finalHtml, plainBody, listUnsubUrl,
  });

  const xml = await sesRequest({
    Action:            'SendRawEmail',
    'RawMessage.Data': Buffer.from(raw).toString('base64'),
  });

  return { messageId: extractMessageId(xml) };
}

// ── Send a campaign ───────────────────────────────────────────────────────────
// Writes one email_sends row per subscriber AT SEND TIME, capturing the
// SES MessageId. This is what makes SNS bounce/complaint webhooks work later —
// the SNS payload's mail.messageId maps back to subscriber_id via this table.
export async function sendCampaign({ campaign, subscribers, baseUrl, onProgress }) {
  const results = { sent: 0, failed: 0, errors: [] };
  const BATCH_SIZE = 10;
  const DELAY_MS   = 800;

  const insertSend = db.prepare(`INSERT INTO email_sends
    (id, campaign_id, subscriber_id, message_id, status, sent_at)
    VALUES (?, ?, ?, ?, 'sent', datetime('now'))`);

  const markFailed = db.prepare(`INSERT INTO email_sends
    (id, campaign_id, subscriber_id, status, sent_at)
    VALUES (?, ?, ?, 'failed', datetime('now'))`);

  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async sub => {
      try {
        const firstName = sub.name ? sub.name.trim().split(/\s+/)[0] : '';
        const htmlBody  = (campaign.html_body  || '').replace(/\[Name\]/gi, firstName);
        const plainBody = (campaign.plain_body || htmlToPlain(campaign.html_body || '')).replace(/\[Name\]/gi, firstName);

        const { messageId } = await sendEmail({
          to:          sub.email,
          toName:      sub.name,
          fromName:    campaign.from_name,
          fromEmail:   campaign.from_email,
          replyTo:     campaign.reply_to,
          subject:     campaign.subject,
          htmlBody,
          plainBody,
          campaignId:    campaign.id,
          subscriberId:  sub.id,
          baseUrl,
        });

        insertSend.run(uuid(), campaign.id, sub.id, messageId);
        results.sent++;
      } catch (err) {
        try { markFailed.run(uuid(), campaign.id, sub.id); } catch {}
        results.failed++;
        results.errors.push({ email: sub.email, error: err.message });
      }
    }));
    if (onProgress) onProgress(Math.round(((i + batch.length) / subscribers.length) * 100));
    if (i + BATCH_SIZE < subscribers.length) await sleep(DELAY_MS);
  }
  return results;
}

// ── SDK still used for read-only queries (quota, verified domains) ────────────
const sdkClient = new SESClient({
  region: REGION,
  credentials: { accessKeyId: AK, secretAccessKey: SK },
});

export async function getQuota() {
  const data = await sdkClient.send(new GetSendQuotaCommand({}));
  return { max24HourSend: data.Max24HourSend, maxSendRate: data.MaxSendRate, sentLast24Hours: data.SentLast24Hours };
}

export async function getVerifiedDomains() {
  const listData = await sdkClient.send(new ListIdentitiesCommand({ IdentityType: 'Domain', MaxItems: 100 }));
  const identities = listData.Identities || [];
  if (!identities.length) return [];
  const attrData = await sdkClient.send(new GetIdentityVerificationAttributesCommand({ Identities: identities }));
  const attrs = attrData.VerificationAttributes || {};
  return identities.filter(id => attrs[id]?.VerificationStatus === 'Success').sort();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function htmlToPlain(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
