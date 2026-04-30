/**
 * SES email sender — bypasses AWS SDK entirely.
 * Makes raw HTTPS POST directly to SES API, signed with AWS Signature V4.
 * This is exactly how Sendy works (class.amazonses.php) and avoids the SDK
 * middleware that attaches account-level default configuration sets,
 * which cause AWS to inject the awstrack.me tracking pixel.
 */

import https from 'https';
import crypto from 'crypto';
import { SESClient, GetSendQuotaCommand, ListIdentitiesCommand, GetIdentityVerificationAttributesCommand } from '@aws-sdk/client-ses';

const REGION  = process.env.AWS_SES_REGION || 'eu-north-1';
const HOST    = `email.${REGION}.amazonaws.com`;
const AK      = process.env.AWS_ACCESS_KEY_ID;
const SK      = process.env.AWS_SECRET_ACCESS_KEY;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── AWS Signature V4 ──────────────────────────────────────────────────────────
function hmac(key, data, enc) {
  return crypto.createHmac('sha256', key).update(data).digest(enc);
}

function sign(date, region, service, secret) {
  const k1 = hmac('AWS4' + secret, date, 'binary');
  const k2  = hmac(k1, region, 'binary');
  const k3  = hmac(k2, service, 'binary');
  return hmac(k3, 'aws4_request', 'binary');
}

function buildAuthHeader(params, body) {
  const now      = new Date();
  const amzDate  = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date     = amzDate.slice(0, 8);
  const method   = 'POST';
  const uri      = '/';
  const payload  = body;
  const payHash  = crypto.createHash('sha256').update(payload).digest('hex');

  const canonHeaders = `content-type:application/x-www-form-urlencoded\nhost:${HOST}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonReq = [method, uri, '', canonHeaders, signedHeaders, payHash].join('\n');

  const credScope  = `${date}/${REGION}/email/aws4_request`;
  const strToSign  = ['AWS4-HMAC-SHA256', amzDate, credScope, crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');
  const signingKey = sign(date, REGION, 'email', SK);
  const signature  = hmac(signingKey, strToSign, 'hex');

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date':  amzDate,
  };
}

// ── Raw HTTPS POST to SES API ─────────────────────────────────────────────────
function sesRequest(params) {
  return new Promise((resolve, reject) => {
    const body    = new URLSearchParams(params).toString();
    const authHdr = buildAuthHeader(params, body);

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

// ── Build raw MIME email ──────────────────────────────────────────────────────
function buildRawEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody }) {
  const boundary   = `b_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const toAddress  = toName ? `${toName} <${to}>` : to;
  const plain      = plainBody || htmlToPlain(htmlBody);
  const subjEnc    = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;

  return [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${toAddress}`,
    `Reply-To: ${replyTo || fromEmail}`,
    `Subject: ${subjEnc}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
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
export async function sendEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody }) {
  const raw = buildRawEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody });
  await sesRequest({
    Action:            'SendRawEmail',
    'RawMessage.Data': Buffer.from(raw).toString('base64'),
  });
}

// ── Send a campaign ───────────────────────────────────────────────────────────
export async function sendCampaign({ campaign, subscribers, baseUrl, onProgress }) {
  const results = { sent: 0, failed: 0, errors: [] };
  const BATCH_SIZE = 10;
  const DELAY_MS   = 800;

  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async sub => {
      try {
        const firstName = sub.name ? sub.name.trim().split(/\s+/)[0] : '';
        const htmlBody  = (campaign.html_body  || '').replace(/\[Name\]/gi, firstName);
        const plainBody = (campaign.plain_body || htmlToPlain(campaign.html_body || '')).replace(/\[Name\]/gi, firstName);
        await sendEmail({ to: sub.email, toName: sub.name, fromName: campaign.from_name, fromEmail: campaign.from_email, replyTo: campaign.reply_to, subject: campaign.subject, htmlBody, plainBody });
        results.sent++;
      } catch (err) {
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
