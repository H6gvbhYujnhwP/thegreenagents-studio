import { SESClient, SendRawEmailCommand, GetSendQuotaCommand, ListIdentitiesCommand, GetIdentityVerificationAttributesCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({
  region: process.env.AWS_SES_REGION || 'eu-north-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Build a raw MIME email (same approach as Sendy — bypasses AWS pixel injection) ──
function buildRawEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody }) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const toAddress = toName ? `${toName} <${to}>` : to;
  const plain = plainBody || htmlToPlain(htmlBody);

  // Encode subject for non-ASCII characters
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;

  const raw = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${toAddress}`,
    `Reply-To: ${replyTo || fromEmail}`,
    `Subject: ${encodedSubject}`,
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

  return Buffer.from(raw);
}

// ── Send a single email using SendRawEmail (no AWS pixel injection) ───────────
export async function sendEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody }) {
  const rawMessage = buildRawEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody });
  const cmd = new SendRawEmailCommand({
    RawMessage: { Data: rawMessage },
  });
  return ses.send(cmd);
}

// ── Send a campaign to a list of subscribers ──────────────────────────────────
export async function sendCampaign({ campaign, subscribers, baseUrl, onProgress }) {
  const results = { sent: 0, failed: 0, errors: [] };
  const BATCH_SIZE = 10;
  const DELAY_MS   = 800; // ~12/sec, safely under 14/sec SES limit

  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (sub) => {
      try {
        // Replace [Name] with subscriber's first name
        const firstName = sub.name ? sub.name.trim().split(/\s+/)[0] : '';
        const htmlBody  = (campaign.html_body  || '').replace(/\[Name\]/gi, firstName);
        const plainBody = (campaign.plain_body || htmlToPlain(campaign.html_body || '')).replace(/\[Name\]/gi, firstName);

        await sendEmail({
          to:        sub.email,
          toName:    sub.name,
          fromName:  campaign.from_name,
          fromEmail: campaign.from_email,
          replyTo:   campaign.reply_to,
          subject:   campaign.subject,
          htmlBody,
          plainBody,
        });
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

// ── Get SES account quota ─────────────────────────────────────────────────────
export async function getQuota() {
  const cmd  = new GetSendQuotaCommand({});
  const data = await ses.send(cmd);
  return {
    max24HourSend:   data.Max24HourSend,
    maxSendRate:     data.MaxSendRate,
    sentLast24Hours: data.SentLast24Hours,
  };
}

// ── Get verified domain identities from AWS ───────────────────────────────────
export async function getVerifiedDomains() {
  const listCmd  = new ListIdentitiesCommand({ IdentityType: 'Domain', MaxItems: 100 });
  const listData = await ses.send(listCmd);
  const identities = listData.Identities || [];
  if (identities.length === 0) return [];

  const attrCmd  = new GetIdentityVerificationAttributesCommand({ Identities: identities });
  const attrData = await ses.send(attrCmd);
  const attrs    = attrData.VerificationAttributes || {};

  return identities.filter(id => attrs[id]?.VerificationStatus === 'Success').sort();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function htmlToPlain(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}
