import { SESClient, SendEmailCommand, GetSendQuotaCommand, ListIdentitiesCommand, GetIdentityVerificationAttributesCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({
  region: process.env.AWS_SES_REGION || 'eu-north-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Send a single email (used internally by campaign sender) ──────────────────
export async function sendEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody }) {
  const cmd = new SendEmailCommand({
    Source: `${fromName} <${fromEmail}>`,
    Destination: { ToAddresses: [toName ? `${toName} <${to}>` : to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: htmlBody, Charset: 'UTF-8' },
        Text: { Data: plainBody || htmlToPlain(htmlBody), Charset: 'UTF-8' },
      },
    },
    ReplyToAddresses: [replyTo || fromEmail],
  });
  return ses.send(cmd);
}

// ── Get SES account quota ─────────────────────────────────────────────────────
export async function getQuota() {
  const cmd = new GetSendQuotaCommand({});
  const data = await ses.send(cmd);
  return {
    max24HourSend: data.Max24HourSend,
    maxSendRate:   data.MaxSendRate,
    sentLast24Hours: data.SentLast24Hours,
  };
}

// ── Get verified domain identities from AWS ───────────────────────────────────
// Returns only domain-level verified identities (not individual email addresses)
export async function getVerifiedDomains() {
  // Fetch all identities of type Domain
  const listCmd = new ListIdentitiesCommand({ IdentityType: 'Domain', MaxItems: 100 });
  const listData = await ses.send(listCmd);
  const identities = listData.Identities || [];
  if (identities.length === 0) return [];

  // Check verification status — only return ones that are actually verified
  const attrCmd = new GetIdentityVerificationAttributesCommand({ Identities: identities });
  const attrData = await ses.send(attrCmd);
  const attrs = attrData.VerificationAttributes || {};

  return identities.filter(id => attrs[id]?.VerificationStatus === 'Success').sort();
}

// ── Send a campaign to a list of subscribers ──────────────────────────────────
export async function sendCampaign({ campaign, subscribers, baseUrl, onProgress }) {
  const results = { sent: 0, failed: 0, errors: [] };
  const BATCH_SIZE = 10;
  const DELAY_MS   = 800;

  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (sub) => {
      try {
        await sendEmail({
          to:        sub.email,
          toName:    sub.name,
          fromName:  campaign.from_name,
          fromEmail: campaign.from_email,
          replyTo:   campaign.reply_to,
          subject:   campaign.subject,
          htmlBody:  campaign.html_body,
          plainBody: campaign.plain_body || htmlToPlain(campaign.html_body),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function htmlToPlain(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
