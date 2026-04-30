import { SESClient, SendEmailCommand, GetSendQuotaCommand, ListIdentitiesCommand, GetIdentityVerificationAttributesCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({
  region: process.env.AWS_SES_REGION || 'eu-north-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Send a single email ───────────────────────────────────────────────────────
// Uses ConfigurationSetName 'no-tracking' if it exists in your AWS account,
// which disables the AWS tracking pixel. Create it in AWS SES console:
// SES → Configuration Sets → Create → name it 'no-tracking' → disable open/click tracking.
export async function sendEmail({ to, toName, fromName, fromEmail, replyTo, subject, htmlBody, plainBody }) {
  const plain = plainBody || htmlToPlain(htmlBody);

  const params = {
    Source: `${fromName} <${fromEmail}>`,
    Destination: { ToAddresses: [toName ? `${toName} <${to}>` : to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: htmlBody, Charset: 'UTF-8' },
        Text: { Data: plain,    Charset: 'UTF-8' },
      },
    },
    ReplyToAddresses: [replyTo || fromEmail],
  };

  // If NO_TRACKING_CONFIG_SET env var is set, use it to suppress AWS pixel
  // Set this to the name of a Configuration Set in SES with tracking disabled
  if (process.env.SES_CONFIGURATION_SET) {
    params.ConfigurationSetName = process.env.SES_CONFIGURATION_SET;
  }

  return ses.send(new SendEmailCommand(params));
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
