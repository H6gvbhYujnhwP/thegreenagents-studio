import express from 'express';
import { v4 as uuid } from 'uuid';
import https from 'https';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendCampaign, getQuota, getVerifiedDomains } from '../services/ses.js';
import { getLinkUrl, TRANSPARENT_GIF } from '../services/tracking.js';
import { getTouchCountsBulk, shouldTrackRecipient } from '../services/touch-count.js';
import dns from 'dns';
import { promisify } from 'util';

const router  = express.Router();
const resolve = promisify(dns.resolveTxt);
const resolveMx = promisify(dns.resolveMx);

// ── Public routes (no auth) ───────────────────────────────────────────────────
// These are hit by recipients' email clients and by AWS SNS — never by the
// logged-in user — so they bypass requireAuth.
const PUBLIC_PREFIXES = ['/unsubscribe', '/track/', '/sns'];

router.use((req, res, next) => {
  if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) return next();
  requireAuth(req, res, next);
});

// ═════════════════════════════════════════════════════════════════════════════
// TRACKING ENDPOINTS (public — recipient's email client hits these)
// ═════════════════════════════════════════════════════════════════════════════

// ── Open tracking pixel ──────────────────────────────────────────────────────
// URL: /api/email/track/open/:campaignId/:subscriberId.gif
// The .gif extension is cosmetic — helps some spam filters trust it more.
router.get('/track/open/:campaignId/:subscriberId.gif', (req, res) => {
  trackOpen(req.params.campaignId, req.params.subscriberId);
  // Always return the GIF — never let DB problems break image rendering
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', TRANSPARENT_GIF.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.end(TRANSPARENT_GIF);
});

// Fallback without .gif extension (in case some client strips it)
router.get('/track/open/:campaignId/:subscriberId', (req, res) => {
  trackOpen(req.params.campaignId, req.params.subscriberId);
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', TRANSPARENT_GIF.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(TRANSPARENT_GIF);
});

function trackOpen(campaignId, subscriberId) {
  try {
    // Find the email_sends row for this (campaign, subscriber)
    const send = db.prepare(`SELECT id, opened_at, open_count FROM email_sends
                             WHERE campaign_id=? AND subscriber_id=?`).get(campaignId, subscriberId);
    if (!send) return; // unknown — could be a stale link or a forwarded email

    if (!send.opened_at) {
      // First open — bump campaign open_count
      db.prepare(`UPDATE email_sends SET status='opened', opened_at=datetime('now'), open_count=open_count+1
                  WHERE id=?`).run(send.id);
      db.prepare(`UPDATE email_campaigns SET open_count=open_count+1 WHERE id=?`).run(campaignId);
    } else {
      // Repeat open — count it on the send row only (campaign open_count is unique opens)
      db.prepare(`UPDATE email_sends SET open_count=open_count+1 WHERE id=?`).run(send.id);
    }
  } catch (err) {
    console.error('[track/open] error:', err.message);
  }
}

// ── Click tracking ───────────────────────────────────────────────────────────
// URL: /api/email/track/click/:campaignId/:subscriberId/:hash
// Records click, then 302-redirects to the original URL.
router.get('/track/click/:campaignId/:subscriberId/:hash', (req, res) => {
  const { campaignId, subscriberId, hash } = req.params;
  const url = getLinkUrl(campaignId, hash);
  if (!url) return res.status(404).send('Link not found');

  try {
    // Record the click
    db.prepare(`INSERT INTO email_link_clicks (id, campaign_id, subscriber_id, url, clicked_at)
                VALUES (?, ?, ?, ?, datetime('now'))`).run(uuid(), campaignId, subscriberId, url);

    // Update the send row — first click marks it; subsequent clicks bump count
    const send = db.prepare(`SELECT id, clicked_at FROM email_sends
                             WHERE campaign_id=? AND subscriber_id=?`).get(campaignId, subscriberId);
    if (send) {
      if (!send.clicked_at) {
        db.prepare(`UPDATE email_sends SET status='clicked', clicked_at=datetime('now'), click_count=click_count+1
                    WHERE id=?`).run(send.id);
        db.prepare(`UPDATE email_campaigns SET click_count=click_count+1 WHERE id=?`).run(campaignId);
      } else {
        db.prepare(`UPDATE email_sends SET click_count=click_count+1 WHERE id=?`).run(send.id);
      }
    }
  } catch (err) {
    console.error('[track/click] error:', err.message);
    // Still redirect even if DB write fails — recipient experience matters most
  }

  res.redirect(302, url);
});

// ── SNS webhooks for bounces + complaints (split, to mirror Sendy) ───────────
// We share the same SNS topics as Sendy:
//   - bounces topic   → POSTs to /api/email/sns/bounces
//   - complaints topic → POSTs to /api/email/sns/complaints
// Both apps subscribe to both topics; SNS fans out to all subscribers.
//
// Each endpoint handles three message Types from SNS:
//   - SubscriptionConfirmation: GET the SubscribeURL to confirm (one-time)
//   - Notification: parse Message field for the actual SES event
//   - UnsubscribeConfirmation: ignored (logged only)
//
// We accept text/plain bodies because AWS SNS sends Content-Type: text/plain.
// express.json() at the app level only parses application/json, so we re-parse here.

const snsTextParser = express.text({ type: '*/*', limit: '500kb' });

function parseSnsBody(req) {
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return null;
  }
}

function logSnsEvent(body, rawBody, source) {
  try {
    db.prepare(`INSERT INTO email_sns_events (id, type, payload) VALUES (?, ?, ?)`)
      .run(uuid(), `${source}:${body?.Type || 'unknown'}`, typeof rawBody === 'string' ? rawBody : JSON.stringify(body));
  } catch {}
}

function handleSubscriptionConfirmation(body, source) {
  try {
    const u = new URL(body.SubscribeURL);
    if (!u.hostname.endsWith('amazonaws.com')) {
      console.warn(`[sns:${source}] refusing to confirm non-AWS SubscribeURL:`, u.hostname);
      return false;
    }
    https.get(body.SubscribeURL, () => {
      console.log(`[sns:${source}] subscription confirmed for topic:`, body.TopicArn);
    }).on('error', err => console.error(`[sns:${source}] confirm error:`, err.message));
    return true;
  } catch (err) {
    console.error(`[sns:${source}] bad SubscribeURL:`, err.message);
    return false;
  }
}

// Bounces endpoint — subscribes to the existing 'bounces' SNS topic
router.post('/sns/bounces', snsTextParser, (req, res) => {
  const body = parseSnsBody(req);
  if (!body) return res.status(400).json({ error: 'Invalid JSON' });
  logSnsEvent(body, req.body, 'bounces');

  if (body.Type === 'SubscriptionConfirmation' && body.SubscribeURL) {
    handleSubscriptionConfirmation(body, 'bounces');
    return res.json({ ok: true });
  }

  if (body.Type === 'Notification' && body.Message) {
    let msg;
    try { msg = JSON.parse(body.Message); }
    catch { return res.json({ ok: true }); }
    if (msg.notificationType === 'Bounce') {
      handleBounce(msg, msg?.mail?.messageId);
    }
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

// Complaints endpoint — subscribes to the existing 'complaints' SNS topic
router.post('/sns/complaints', snsTextParser, (req, res) => {
  const body = parseSnsBody(req);
  if (!body) return res.status(400).json({ error: 'Invalid JSON' });
  logSnsEvent(body, req.body, 'complaints');

  if (body.Type === 'SubscriptionConfirmation' && body.SubscribeURL) {
    handleSubscriptionConfirmation(body, 'complaints');
    return res.json({ ok: true });
  }

  if (body.Type === 'Notification' && body.Message) {
    let msg;
    try { msg = JSON.parse(body.Message); }
    catch { return res.json({ ok: true }); }
    if (msg.notificationType === 'Complaint') {
      handleComplaint(msg, msg?.mail?.messageId);
    }
    return res.json({ ok: true });
  }

  res.json({ ok: true });
});

function handleBounce(msg, messageId) {
  const isPermanent = msg.bounce?.bounceType === 'Permanent';
  const recipients  = msg.bounce?.bouncedRecipients || [];

  for (const r of recipients) {
    const email = (r.emailAddress || '').toLowerCase().trim();
    if (!email) continue;

    // Look up the send row by messageId first (most reliable)
    let send = messageId ? db.prepare(`SELECT * FROM email_sends WHERE message_id=?`).get(messageId) : null;

    // Fallback — find by email + campaign via the most recent send
    if (!send) {
      const sub = db.prepare(`SELECT id FROM email_subscribers WHERE email=? ORDER BY created_at DESC LIMIT 1`).get(email);
      if (sub) {
        send = db.prepare(`SELECT * FROM email_sends WHERE subscriber_id=? ORDER BY sent_at DESC LIMIT 1`).get(sub.id);
      }
    }

    if (send) {
      db.prepare(`UPDATE email_sends SET status='bounced', bounced_at=datetime('now') WHERE id=?`).run(send.id);
      db.prepare(`UPDATE email_campaigns SET bounce_count=bounce_count+1 WHERE id=?`).run(send.campaign_id);

      // Permanent bounces — mark subscriber so we never email them again
      if (isPermanent) {
        db.prepare(`UPDATE email_subscribers SET status='bounced', bounced_at=datetime('now') WHERE id=?`)
          .run(send.subscriber_id);
        // Refresh subscriber count on the list
        const sub = db.prepare(`SELECT list_id FROM email_subscribers WHERE id=?`).get(send.subscriber_id);
        if (sub) {
          db.prepare(`UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?`)
            .run(sub.list_id, sub.list_id);
        }
      }
    }
  }
}

function handleComplaint(msg, messageId) {
  const recipients = msg.complaint?.complainedRecipients || [];

  for (const r of recipients) {
    const email = (r.emailAddress || '').toLowerCase().trim();
    if (!email) continue;

    let send = messageId ? db.prepare(`SELECT * FROM email_sends WHERE message_id=?`).get(messageId) : null;

    if (!send) {
      const sub = db.prepare(`SELECT id FROM email_subscribers WHERE email=? ORDER BY created_at DESC LIMIT 1`).get(email);
      if (sub) {
        send = db.prepare(`SELECT * FROM email_sends WHERE subscriber_id=? ORDER BY sent_at DESC LIMIT 1`).get(sub.id);
      }
    }

    if (send) {
      db.prepare(`UPDATE email_campaigns SET spam_count=spam_count+1 WHERE id=?`).run(send.campaign_id);
      // Mark subscriber as spam — Sendy does the same, never email them again
      db.prepare(`UPDATE email_subscribers SET status='spam', spam_at=datetime('now') WHERE id=?`)
        .run(send.subscriber_id);
      const sub = db.prepare(`SELECT list_id FROM email_subscribers WHERE id=?`).get(send.subscriber_id);
      if (sub) {
        db.prepare(`UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?`)
          .run(sub.list_id, sub.list_id);
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS (auth required — for debugging only)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/email/diag — runs four checks and returns JSON:
//   1. Env vars: present? expected length? whitespace?
//   2. Server time: if Render's clock is skewed >5min from real time, AWS rejects
//   3. SDK signing path: GetSendQuota via the AWS SDK (different signer than ours)
//   4. Raw signing path: GetSendQuota via OUR raw Signature V4 code
//
// If 3 passes but 4 fails, the bug is in our raw signer — not credentials.
// If both 3 and 4 pass, sending should work; signature errors are intermittent.
// If 3 fails too, the credentials are bad.
router.get('/diag', async (req, res) => {
  const out = {
    timestamp: new Date().toISOString(),
    env: {},
    server_time: {},
    sdk_check: {},
    raw_check: {},
  };

  // ── 1. Env vars ──
  const ak = process.env.AWS_ACCESS_KEY_ID || '';
  const sk = process.env.AWS_SECRET_ACCESS_KEY || '';
  out.env = {
    AWS_ACCESS_KEY_ID:     ak ? `SET (${ak.length} chars, starts "${ak.slice(0,4)}", ends "${ak.slice(-2)}")` : 'MISSING',
    AWS_ACCESS_KEY_ID_ok:  ak.length === 20 && /^[A-Z0-9]+$/.test(ak) && ak === ak.trim(),
    AWS_SECRET_ACCESS_KEY: sk ? `SET (${sk.length} chars, ends "${sk.slice(-2)}")` : 'MISSING',
    AWS_SECRET_ACCESS_KEY_ok: sk.length === 40 && sk === sk.trim(),
    AWS_SES_REGION:        process.env.AWS_SES_REGION || 'eu-north-1 (default)',
    PUBLIC_URL:            process.env.PUBLIC_URL || 'NOT SET (using request host)',
    SES_CONFIGURATION_SET: process.env.SES_CONFIGURATION_SET || 'NOT SET (no X-SES-CONFIGURATION-SET header will be added — AWS account default applies)',
    has_whitespace_in_ak:  ak !== ak.trim(),
    has_whitespace_in_sk:  sk !== sk.trim(),
  };

  // ── 2. Server time skew ──
  // We can't ping NTP from here without an extra dep, but we can show what we think
  // the time is — you can compare against your watch / a NTP site.
  out.server_time = {
    iso:      new Date().toISOString(),
    epoch_ms: Date.now(),
    note:     'Compare against time.is. If skew >5min, AWS will reject signatures.',
  };

  // ── 3. SDK signing path ──
  // Uses @aws-sdk/client-ses, which has its own (well-tested) Signature V4 implementation.
  // If this works, credentials are valid.
  try {
    const { getQuota } = await import('../services/ses.js');
    const quota = await getQuota();
    out.sdk_check = { ok: true, quota };
  } catch (err) {
    out.sdk_check = { ok: false, error: err.message };
  }

  // ── 4. Raw signing path ──
  // Calls GetSendQuota via OUR raw HTTPS + Signature V4 code. Does NOT send any
  // email. If this fails but #3 passes, the bug is in our signer.
  try {
    const result = await rawSesGetSendQuota();
    out.raw_check = { ok: true, response_snippet: result.slice(0, 200) };
  } catch (err) {
    out.raw_check = { ok: false, error: err.message };
  }

  res.json(out);
});

// GET /api/email/diag/raw-mime — returns the raw MIME we'd send for a test email.
// Does NOT send anything. Used to verify what headers actually reach the
// buildRawEmail output (specifically the X-SES-CONFIGURATION-SET header).
router.get('/diag/raw-mime', async (req, res) => {
  const fromEmail = req.query.from || 'test@example.com';
  const toEmail   = req.query.to   || 'recipient@example.com';

  const headers = [
    `From: Test Sender <${fromEmail}>`,
    `To: ${toEmail}`,
    `Reply-To: ${fromEmail}`,
    `Subject: =?UTF-8?B?${Buffer.from('Diag MIME Dump').toString('base64')}?=`,
    `MIME-Version: 1.0`,
  ];
  const configSet = process.env.SES_CONFIGURATION_SET;
  if (configSet) headers.push(`X-SES-CONFIGURATION-SET: ${configSet}`);
  headers.push(`Content-Type: multipart/alternative; boundary="b_diag"`);

  const mime = [
    ...headers, '',
    '--b_diag',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable', '',
    'This is the diag MIME dump.', '',
    '--b_diag--',
  ].join('\r\n');

  res.json({
    SES_CONFIGURATION_SET_env: configSet || 'NOT SET',
    config_set_header_in_mime: mime.includes('X-SES-CONFIGURATION-SET'),
    raw_mime_preview: mime,
    explanation: configSet
      ? "If 'config_set_header_in_mime' is true, the header IS being added. If you still see awstrack.me pixels in real sends, the issue is AWS-side — config set name mismatch, or AWS not honoring it for that identity."
      : "SES_CONFIGURATION_SET env var is empty in this Node process. Header won't be added.",
  });
});

// Helper: call SES GetSendQuota via our raw signer (same code path as SendRawEmail)
async function rawSesGetSendQuota() {
  // We deliberately import the internal sesRequest — but it's not exported.
  // So we replicate the signed call here using the same primitives.
  const https  = await import('https');
  const crypto = await import('crypto');

  const REGION = process.env.AWS_SES_REGION || 'eu-north-1';
  const HOST   = `email.${REGION}.amazonaws.com`;
  const AK     = process.env.AWS_ACCESS_KEY_ID;
  const SK     = process.env.AWS_SECRET_ACCESS_KEY;

  const params = { Action: 'GetSendQuota' };
  const sorted = Object.keys(params).sort().reduce((acc, k) => { acc[k] = params[k]; return acc; }, {});
  const body   = new URLSearchParams(sorted).toString();

  const now      = new Date();
  const amzDate  = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date     = amzDate.slice(0, 8);
  const payHash  = crypto.createHash('sha256').update(body).digest('hex');
  const canonHeaders  = `content-type:application/x-www-form-urlencoded\nhost:${HOST}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonReq      = ['POST', '/', '', canonHeaders, signedHeaders, payHash].join('\n');
  const credScope  = `${date}/${REGION}/email/aws4_request`;
  const strToSign  = ['AWS4-HMAC-SHA256', amzDate, credScope, crypto.createHash('sha256').update(canonReq).digest('hex')].join('\n');

  const hmac = (key, data, enc) => crypto.createHmac('sha256', key).update(data).digest(enc);
  // Keep keys as Buffers between HMAC stages — see ses.js for why.
  const k1 = hmac('AWS4' + SK, date);
  const k2 = hmac(k1, REGION);
  const k3 = hmac(k2, 'email');
  const signingKey = hmac(k3, 'aws4_request');
  const signature  = hmac(signingKey, strToSign, 'hex');

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST, port: 443, path: '/', method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'host':         HOST,
        'x-amz-date':   amzDate,
        'Authorization': `AWS4-HMAC-SHA256 Credential=${AK}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    };
    const r = https.request(opts, response => {
      let data = '';
      response.on('data', c => data += c);
      response.on('end', () => {
        if (response.statusCode === 200) resolve(data);
        else reject(new Error(`SES error ${response.statusCode}: ${data}`));
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// UNSUBSCRIBE (public — recipient clicks footer link, or Gmail one-click POSTs)
// ═════════════════════════════════════════════════════════════════════════════

// GET = recipient clicked unsubscribe link in email
router.get('/unsubscribe', (req, res) => {
  const { sid, cid } = req.query;
  doUnsub(sid, cid);
  res.send(`<!DOCTYPE html><html><head><title>Unsubscribed</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f3;}
    .box{text-align:center;padding:40px;max-width:400px;}h1{font-size:22px;font-weight:500;color:#1a1a1a;margin-bottom:12px;}
    p{color:#666;font-size:14px;line-height:1.6;}</style></head>
    <body><div class="box"><h1>You've been unsubscribed</h1>
    <p>Your email address has been removed from this mailing list.</p>
    </div></body></html>`);
});

// POST = RFC 8058 one-click unsubscribe (Gmail/Outlook header button)
router.post('/unsubscribe', express.urlencoded({ extended: true }), (req, res) => {
  const sid = req.query.sid || req.body?.sid;
  const cid = req.query.cid || req.body?.cid;
  doUnsub(sid, cid);
  res.json({ ok: true });
});

function doUnsub(sid, cid) {
  if (!sid) return false;
  const sub = db.prepare('SELECT * FROM email_subscribers WHERE id=?').get(sid);
  if (!sub) return false;
  db.prepare("UPDATE email_subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') WHERE id=?").run(sid);
  db.prepare("UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?")
    .run(sub.list_id, sub.list_id);
  if (cid) db.prepare('UPDATE email_campaigns SET unsubscribe_count=unsubscribe_count+1 WHERE id=?').run(cid);
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// ALL ROUTES BELOW REQUIRE AUTH
// ═════════════════════════════════════════════════════════════════════════════

// ── STATS ─────────────────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const lists       = db.prepare('SELECT COUNT(*) as c FROM email_lists').get().c;
    const subscribers = db.prepare("SELECT COUNT(*) as c FROM email_subscribers WHERE status='subscribed'").get().c;
    const campaigns   = db.prepare('SELECT COUNT(*) as c FROM email_campaigns').get().c;
    const sent        = db.prepare("SELECT COALESCE(SUM(sent_count),0) as c FROM email_campaigns WHERE status='sent'").get().c;
    let quota = null;
    try { quota = await getQuota(); } catch(e) {}
    res.json({ lists, subscribers, campaigns, sent, quota });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EMAIL CLIENTS (completely separate from LinkedIn clients) ──────────────────

router.get('/clients', (req, res) => {
  const rows = db.prepare(`
    SELECT ec.*,
      (SELECT COUNT(*) FROM email_lists WHERE email_client_id=ec.id) as list_count,
      (SELECT COALESCE(SUM(s.cnt),0) FROM (SELECT COUNT(*) as cnt FROM email_subscribers es JOIN email_lists el ON es.list_id=el.id WHERE el.email_client_id=ec.id AND es.status='subscribed') s) as subscriber_count,
      (SELECT COUNT(*) FROM email_campaigns WHERE email_client_id=ec.id) as campaign_count
    FROM email_clients ec
    ORDER BY ec.name ASC
  `).all();
  res.json(rows);
});

router.post('/clients', (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuid();
  db.prepare('INSERT INTO email_clients (id,name,color) VALUES (?,?,?)')
    .run(id, name.trim(), color || '#1D9E75');
  res.json(db.prepare('SELECT * FROM email_clients WHERE id=?').get(id));
});

router.put('/clients/:id', (req, res) => {
  const { name, color, test_email } = req.body;
  const c = db.prepare('SELECT * FROM email_clients WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE email_clients SET name=?,color=?,test_email=? WHERE id=?')
    .run(name ?? c.name, color ?? c.color, test_email ?? c.test_email, req.params.id);
  res.json(db.prepare('SELECT * FROM email_clients WHERE id=?').get(req.params.id));
});

router.delete('/clients/:id', (req, res) => {
  const lists    = db.prepare('SELECT id FROM email_lists WHERE email_client_id=?').all(req.params.id);
  const campaigns = db.prepare('SELECT id FROM email_campaigns WHERE email_client_id=?').all(req.params.id);
  db.transaction(() => {
    for (const l of lists) db.prepare('DELETE FROM email_subscribers WHERE list_id=?').run(l.id);
    for (const c of campaigns) db.prepare('DELETE FROM email_sends WHERE campaign_id=?').run(c.id);
    db.prepare('DELETE FROM email_lists WHERE email_client_id=?').run(req.params.id);
    db.prepare('DELETE FROM email_campaigns WHERE email_client_id=?').run(req.params.id);
    db.prepare('DELETE FROM email_brands WHERE email_client_id=?').run(req.params.id);
    db.prepare('DELETE FROM email_clients WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// ── BRANDS ────────────────────────────────────────────────────────────────────

router.get('/brands', (req, res) => {
  const { email_client_id } = req.query;
  const rows = email_client_id
    ? db.prepare('SELECT * FROM email_brands WHERE email_client_id=? ORDER BY name ASC').all(email_client_id)
    : db.prepare('SELECT * FROM email_brands ORDER BY name ASC').all();
  res.json(rows);
});

router.post('/brands', (req, res) => {
  const { email_client_id, name, from_name, from_email, reply_to, color } = req.body;
  if (!email_client_id || !name || !from_name || !from_email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const id = uuid();
  db.prepare('INSERT INTO email_brands (id,email_client_id,name,from_name,from_email,reply_to,color) VALUES (?,?,?,?,?,?,?)')
    .run(id, email_client_id, name, from_name, from_email, reply_to || from_email, color || '#1D9E75');
  res.json(db.prepare('SELECT * FROM email_brands WHERE id=?').get(id));
});

router.put('/brands/:id', (req, res) => {
  const { name, from_name, from_email, reply_to, color } = req.body;
  const b = db.prepare('SELECT * FROM email_brands WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE email_brands SET name=?,from_name=?,from_email=?,reply_to=?,color=? WHERE id=?')
    .run(name ?? b.name, from_name ?? b.from_name, from_email ?? b.from_email, reply_to ?? b.reply_to, color ?? b.color, req.params.id);
  res.json(db.prepare('SELECT * FROM email_brands WHERE id=?').get(req.params.id));
});

router.delete('/brands/:id', (req, res) => {
  db.prepare('DELETE FROM email_brands WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── LISTS ─────────────────────────────────────────────────────────────────────

router.get('/lists', (req, res) => {
  const { email_client_id } = req.query;
  const q = `
    SELECT l.*,
      (SELECT COUNT(*) FROM email_subscribers WHERE list_id=l.id AND status='subscribed')   as subscriber_count,
      (SELECT COUNT(*) FROM email_subscribers WHERE list_id=l.id AND status='bounced')      as bounced_count,
      (SELECT COUNT(*) FROM email_subscribers WHERE list_id=l.id AND status='unsubscribed') as unsubscribed_count,
      (SELECT COUNT(*) FROM email_subscribers WHERE list_id=l.id AND status='spam')         as spam_count
    FROM email_lists l
    ${email_client_id ? 'WHERE l.email_client_id=?' : ''}
    ORDER BY l.created_at DESC
  `;
  const rows = email_client_id
    ? db.prepare(q).all(email_client_id)
    : db.prepare(q).all();
  res.json(rows);
});

router.post('/lists', (req, res) => {
  const { email_client_id, name, from_name, from_email, reply_to } = req.body;
  if (!email_client_id || !name || !from_name || !from_email || !reply_to) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const id = uuid();
  db.prepare('INSERT INTO email_lists (id,email_client_id,name,from_name,from_email,reply_to) VALUES (?,?,?,?,?,?)')
    .run(id, email_client_id, name, from_name, from_email, reply_to);
  res.json(db.prepare('SELECT * FROM email_lists WHERE id=?').get(id));
});

router.delete('/lists/:id', (req, res) => {
  db.prepare('DELETE FROM email_subscribers WHERE list_id=?').run(req.params.id);
  db.prepare('DELETE FROM email_lists WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── SUBSCRIBERS ───────────────────────────────────────────────────────────────

router.get('/lists/:id/subscribers', (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM email_subscribers WHERE list_id=? AND status=? ORDER BY created_at DESC').all(req.params.id, status)
    : db.prepare('SELECT * FROM email_subscribers WHERE list_id=? ORDER BY created_at DESC').all(req.params.id);
  res.json(rows);
});

router.post('/lists/:id/subscribers', (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const id = uuid();
  try {
    db.prepare('INSERT INTO email_subscribers (id,list_id,email,name) VALUES (?,?,?,?)')
      .run(id, req.params.id, email.toLowerCase().trim(), name || null);
    db.prepare("UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?")
      .run(req.params.id, req.params.id);
    res.json({ ok: true, id });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Already subscribed' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/lists/:id/import', (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV data' });

  const lines = csv.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return res.json({ ok: true, added: 0 });

  // Parse header row to find column positions (handles Sendy and simple formats)
  const headerLine = lines[0].replace(/"/g, '').toLowerCase();
  const headers = headerLine.split(',').map(h => h.trim());
  const emailIdx  = headers.findIndex(h => h === 'email');
  const nameIdx   = headers.findIndex(h => h === 'name');
  const statusIdx = headers.findIndex(h => h === 'status');

  // If no header row found, treat first column as email, second as name
  const hasHeader = emailIdx !== -1;
  const dataRows  = hasHeader ? lines.slice(1) : lines;

  // Map Sendy status values to our internal status values
  function mapStatus(raw) {
    if (!raw) return 'subscribed';
    const s = raw.toLowerCase().trim();
    if (s === 'bounced')      return 'bounced';
    if (s === 'unsubscribed') return 'unsubscribed';
    if (s === 'spam' || s === 'marked as spam') return 'spam';
    if (s === 'unconfirmed')  return 'unsubscribed'; // treat unconfirmed as unsub
    return 'subscribed'; // Active, Subscribed etc
  }

  const insert = db.prepare('INSERT OR IGNORE INTO email_subscribers (id,list_id,email,name,status) VALUES (?,?,?,?,?)');
  const insertMany = db.transaction((rows) => {
    let added = 0;
    for (const line of rows) {
      // Handle quoted CSV values properly
      const cols = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g)
        ?.map(v => v.replace(/^"|"$/g, '').trim()) || line.split(',').map(v => v.trim());

      const email  = hasHeader ? cols[emailIdx]  : cols[0];
      const name   = hasHeader ? cols[nameIdx]   : cols[1];
      const status = hasHeader && statusIdx !== -1 ? mapStatus(cols[statusIdx]) : 'subscribed';

      if (!email || !email.includes('@')) continue;
      insert.run(uuid(), req.params.id, email.toLowerCase(), name || null, status);
      added++;
    }
    return added;
  });

  const added = insertMany(dataRows);

  // Update subscriber count (active only)
  db.prepare("UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?")
    .run(req.params.id, req.params.id);

  res.json({ ok: true, added });
});

router.delete('/lists/:listId/subscribers/:subId', (req, res) => {
  db.prepare("UPDATE email_subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') WHERE id=? AND list_id=?")
    .run(req.params.subId, req.params.listId);
  db.prepare("UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?")
    .run(req.params.listId, req.params.listId);
  res.json({ ok: true });
});

// ── CAMPAIGNS ─────────────────────────────────────────────────────────────────

router.get('/campaigns', (req, res) => {
  const { email_client_id } = req.query;
  const rows = email_client_id
    ? db.prepare(`SELECT ec.*, el.name as list_name FROM email_campaigns ec JOIN email_lists el ON ec.list_id=el.id WHERE ec.email_client_id=? ORDER BY ec.created_at DESC`).all(email_client_id)
    : db.prepare(`SELECT ec.*, el.name as list_name FROM email_campaigns ec JOIN email_lists el ON ec.list_id=el.id ORDER BY ec.created_at DESC`).all();
  res.json(rows);
});

router.post('/campaigns', (req, res) => {
  const {
    email_client_id, list_id, title, subject, from_name, from_email, reply_to,
    html_body, plain_body, scheduled_at,
    // Tracking — all optional; defaults are the column-level defaults (off / 3 / 6 / 0).
    tracking_mode, tracking_threshold, tracking_window,
    track_opens, track_clicks, track_unsub,
  } = req.body;
  if (!email_client_id || !list_id || !title || !subject || !from_name || !from_email || !html_body) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const id = uuid();
  db.prepare(`INSERT INTO email_campaigns
    (id, email_client_id, list_id, title, subject, from_name, from_email, reply_to,
     html_body, plain_body, status, scheduled_at,
     tracking_mode, tracking_threshold, tracking_window,
     track_opens, track_clicks, track_unsub)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, email_client_id, list_id, title, subject, from_name, from_email, reply_to || from_email,
      html_body, plain_body || null, scheduled_at ? 'scheduled' : 'draft', scheduled_at || null,
      tracking_mode || 'off',
      Number.isInteger(tracking_threshold) ? tracking_threshold : 3,
      Number.isInteger(tracking_window) ? tracking_window : 6,
      track_opens ? 1 : 0, track_clicks ? 1 : 0, track_unsub ? 1 : 0,
    );
  res.json(db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(id));
});

router.put('/campaigns/:id', (req, res) => {
  const {
    title, subject, from_name, from_email, reply_to, html_body, plain_body, scheduled_at, list_id,
    tracking_mode, tracking_threshold, tracking_window,
    track_opens, track_clicks, track_unsub,
  } = req.body;
  const current = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  if (current.status === 'sent') return res.status(400).json({ error: 'Cannot edit a sent campaign' });
  const status = scheduled_at ? 'scheduled' : 'draft';
  db.prepare(`UPDATE email_campaigns SET
    title=?, subject=?, from_name=?, from_email=?, reply_to=?,
    html_body=?, plain_body=?, scheduled_at=?, status=?,
    list_id=COALESCE(?, list_id),
    tracking_mode=COALESCE(?, tracking_mode),
    tracking_threshold=COALESCE(?, tracking_threshold),
    tracking_window=COALESCE(?, tracking_window),
    track_opens=COALESCE(?, track_opens),
    track_clicks=COALESCE(?, track_clicks),
    track_unsub=COALESCE(?, track_unsub)
    WHERE id=?`).run(
      title ?? current.title, subject ?? current.subject,
      from_name ?? current.from_name, from_email ?? current.from_email,
      reply_to ?? current.reply_to, html_body ?? current.html_body,
      plain_body ?? current.plain_body, scheduled_at ?? current.scheduled_at,
      status, list_id ?? null,
      tracking_mode ?? null,
      Number.isInteger(tracking_threshold) ? tracking_threshold : null,
      Number.isInteger(tracking_window) ? tracking_window : null,
      track_opens === undefined ? null : (track_opens ? 1 : 0),
      track_clicks === undefined ? null : (track_clicks ? 1 : 0),
      track_unsub === undefined ? null : (track_unsub ? 1 : 0),
      req.params.id,
    );
  res.json(db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id));
});

router.delete('/campaigns/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.status === 'sending') return res.status(400).json({ error: 'Cannot delete while sending' });
  db.prepare('DELETE FROM email_sends WHERE campaign_id=?').run(req.params.id);
  db.prepare('DELETE FROM email_campaigns WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── TOUCH-COUNT ENDPOINTS (for the smart-tracking UI) ────────────────────────

// GET /api/email/lists/:id/touch-counts?window=6
// Returns per-subscriber touch count for a list, used in the subscriber list UI
// to show the "1st contact / 2nd contact" badge.
router.get('/lists/:id/touch-counts', (req, res) => {
  const window = Number.isInteger(parseInt(req.query.window)) ? parseInt(req.query.window) : 6;
  const subs = db.prepare("SELECT id FROM email_subscribers WHERE list_id=? AND status='subscribed'").all(req.params.id);
  const counts = getTouchCountsBulk(subs.map(s => s.id), window);
  res.json({
    window_months: window,
    counts: Object.fromEntries(counts),
  });
});

// GET /api/email/campaigns/:id/send-preview
// Returns the breakdown for the pre-send dialog: how many recipients fall into
// each touch-count bucket, and how many would be tracked vs. sent clean.
router.get('/campaigns/:id/send-preview', (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  const list = db.prepare('SELECT * FROM email_lists WHERE id=?').get(campaign.list_id);
  if (!list) return res.status(404).json({ error: 'Campaign list missing' });

  const subs = db.prepare("SELECT id FROM email_subscribers WHERE list_id=? AND status='subscribed'").all(campaign.list_id);
  const window    = campaign.tracking_window || 6;
  const mode      = campaign.tracking_mode || 'off';
  const threshold = campaign.tracking_threshold || 3;
  const alwaysWarm = !!(list && list.always_warm);

  const counts = getTouchCountsBulk(subs.map(s => s.id), window);

  // Histogram: 1st, 2nd, 3rd, 4+ contact (touchCount + 1 = nth contact for this send)
  const buckets = { '1st': 0, '2nd': 0, '3rd': 0, '4+': 0 };
  let trackedCount = 0;
  for (const sub of subs) {
    const touchCount = counts.get(sub.id) || 0;
    const nth = touchCount + 1;
    if (nth === 1) buckets['1st']++;
    else if (nth === 2) buckets['2nd']++;
    else if (nth === 3) buckets['3rd']++;
    else buckets['4+']++;
    if (shouldTrackRecipient({ mode, threshold, touchCount, alwaysWarm })) trackedCount++;
  }

  res.json({
    total_recipients: subs.length,
    buckets,
    tracking: {
      mode, threshold, window_months: window, always_warm: alwaysWarm,
      track_opens:  !!campaign.track_opens,
      track_clicks: !!campaign.track_clicks,
      track_unsub:  !!campaign.track_unsub,
      will_track:   trackedCount,
      will_send_clean: subs.length - trackedCount,
    },
    schedule: {
      status:        campaign.status,            // 'draft' | 'scheduled' | 'sending' | 'paused'
      scheduled_at:  campaign.scheduled_at,      // ISO date string if scheduled
      daily_limit:   campaign.daily_limit,       // drip batch size
      drip_start_at: campaign.drip_start_at,
      drip_sent:     campaign.drip_sent,
      send_order:    campaign.send_order,
      is_drip:       !!campaign.daily_limit && campaign.daily_limit > 0,
      is_scheduled:  !!campaign.scheduled_at && campaign.status === 'scheduled',
    },
    list_name: list.name,
  });
});

// PUT /api/email/lists/:id/always-warm — toggle the list-level override
router.put('/lists/:id/always-warm', (req, res) => {
  const { always_warm } = req.body;
  const list = db.prepare('SELECT * FROM email_lists WHERE id=?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE email_lists SET always_warm=? WHERE id=?')
    .run(always_warm ? 1 : 0, req.params.id);
  res.json({ ok: true, always_warm: !!always_warm });
});

// ── SEND ──────────────────────────────────────────────────────────────────────

router.post('/campaigns/:id/send', async (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (campaign.status === 'sent') return res.status(400).json({ error: 'Already sent' });
  if (campaign.status === 'sending') return res.status(400).json({ error: 'Currently sending' });

  const list = db.prepare('SELECT * FROM email_lists WHERE id=?').get(campaign.list_id);
  const subscribers = db.prepare("SELECT * FROM email_subscribers WHERE list_id=? AND status='subscribed'").all(campaign.list_id);
  if (subscribers.length === 0) return res.status(400).json({ error: 'No active subscribers in list' });

  db.prepare("UPDATE email_campaigns SET status='sending' WHERE id=?").run(campaign.id);
  // baseUrl comes from the request — on Render this is studio.thegreenagents.com.
  // PUBLIC_URL env var can override (useful for local dev where req.host is localhost).
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const alwaysWarm = !!(list && list.always_warm);
  res.json({ ok: true, subscribers: subscribers.length });

  try {
    const results = await sendCampaign({
      campaign, subscribers, baseUrl, alwaysWarm,
      onProgress: (pct) => {
        db.prepare('UPDATE email_campaigns SET sent_count=? WHERE id=?')
          .run(Math.round(subscribers.length * pct / 100), campaign.id);
      },
    });
    // Note: email_sends rows are now written inside sendCampaign() at send time
    // (with message_id for SNS bounce/complaint mapping). No bulk insert here.
    // Re-read status before marking sent — user may have cancelled mid-send.
    const finalStatus = db.prepare('SELECT status FROM email_campaigns WHERE id=?').get(campaign.id);
    if (finalStatus && finalStatus.status === 'cancelled') {
      // Preserve the cancelled status; just record the partial sent count
      db.prepare(`UPDATE email_campaigns SET sent_count=? WHERE id=?`).run(results.sent, campaign.id);
    } else {
      db.prepare(`UPDATE email_campaigns SET status='sent', sent_at=datetime('now'), sent_count=? WHERE id=?`)
        .run(results.sent, campaign.id);
    }
  } catch (err) {
    db.prepare("UPDATE email_campaigns SET status='failed' WHERE id=?").run(campaign.id);
    console.error('[email/send] error:', err.message);
  }
});

// ── DOMAIN HEALTH ─────────────────────────────────────────────────────────────

router.get('/domain-health/:domain', async (req, res) => {
  const domain = req.params.domain;
  const results = { domain, spf: null, dkim: null, dmarc: null, mx: null, error: null };
  try {
    try { const txt = await resolve(domain); const spfRecord = txt.flat().find(r=>r.startsWith('v=spf1')); results.spf = spfRecord ? { status:'pass', record:spfRecord } : { status:'missing', record:null }; } catch { results.spf = { status:'missing', record:null }; }
    try { const dmarc = await resolve(`_dmarc.${domain}`); const rec = dmarc.flat().find(r=>r.startsWith('v=DMARC1')); results.dmarc = rec ? { status:'pass', record:rec } : { status:'missing', record:null }; } catch { results.dmarc = { status:'missing', record:null }; }
    try { const mx = await resolveMx(domain); results.mx = mx.length>0 ? { status:'pass', records:mx.map(r=>r.exchange) } : { status:'missing', records:[] }; } catch { results.mx = { status:'missing', records:[] }; }
    const selectors = ['amazonses','google','default','mail','dkim'];
    let dkimFound = false;
    for (const sel of selectors) {
      try { const rec = await resolve(`${sel}._domainkey.${domain}`); if (rec.flat().some(r=>r.includes('v=DKIM1'))) { results.dkim = { status:'pass', selector:sel }; dkimFound=true; break; } } catch {}
    }
    if (!dkimFound) results.dkim = { status:'missing', selector:null };
  } catch (err) { results.error = err.message; }
  res.json(results);
});

// ── VERIFIED SES DOMAINS (live from AWS) ──────────────────────────────────────

router.get('/verified-domains', async (req, res) => {
  try {
    const domains = await getVerifiedDomains();
    res.json(domains);
  } catch (err) {
    console.error('[verified-domains] AWS error, using fallback:', err.message);
    res.json(['thegreenagents.com','sweetbyte.co.uk','clear-a-way.co.uk','itcloudpros.uk','mail.engineersolutions.co.uk','syncsure.cloud','socialecho.ai','clearerpaths.co.uk','mail.weprintcatalogues.com']);
  }
});

export default router;

// ── CAMPAIGN QUEUE (per list) ─────────────────────────────────────────────────

// Get all campaigns for a list, ordered by queue position
router.get('/lists/:id/queue', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, el.name as list_name,
      (SELECT COUNT(*) FROM email_subscribers WHERE list_id=c.list_id AND status='subscribed') as total_subscribers
    FROM email_campaigns c
    LEFT JOIN email_lists el ON c.list_id=el.id
    WHERE c.list_id=?
    ORDER BY c.queue_position ASC, c.created_at ASC
  `).all(req.params.id);
  res.json(rows);
});

// Reorder queue
router.post('/lists/:id/queue/reorder', (req, res) => {
  const { order } = req.body; // array of campaign ids in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' });
  const update = db.prepare('UPDATE email_campaigns SET queue_position=? WHERE id=?');
  db.transaction(() => { order.forEach((id, i) => update.run(i + 1, id)); })();
  res.json({ ok: true });
});

// ── DRIP SEND ─────────────────────────────────────────────────────────────────

router.post('/campaigns/:id/start-drip', async (req, res) => {
  const { daily_limit, drip_start_at, send_order } = req.body;
  if (!daily_limit || daily_limit < 1) return res.status(400).json({ error: 'Daily limit required' });

  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });

  db.prepare(`UPDATE email_campaigns SET
    daily_limit=?, drip_start_at=?, send_order=?, status='scheduled', drip_sent=0
    WHERE id=?`).run(daily_limit, drip_start_at || new Date().toISOString(), send_order || 'top', req.params.id);

  res.json({ ok: true });
});

router.post('/campaigns/:id/pause', (req, res) => {
  const c = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const newStatus = c.status === 'paused' ? 'sending' : 'paused';
  db.prepare('UPDATE email_campaigns SET status=? WHERE id=?').run(newStatus, req.params.id);
  res.json({ ok: true, status: newStatus });
});

// Cancel — stop further sends but keep stats. Distinct from delete which removes
// all data. Once a campaign is cancelled, you can still view the report for the
// portion that already sent.
router.post('/campaigns/:id/cancel', (req, res) => {
  const c = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!['sending', 'paused', 'scheduled'].includes(c.status)) {
    return res.status(400).json({ error: `Cannot cancel a ${c.status} campaign` });
  }
  db.prepare(`UPDATE email_campaigns SET status='cancelled' WHERE id=?`).run(req.params.id);
  res.json({ ok: true, status: 'cancelled' });
});

// ── TEST SEND ─────────────────────────────────────────────────────────────────

router.post('/campaigns/:id/test', async (req, res) => {
  const { test_email } = req.body;
  if (!test_email) return res.status(400).json({ error: 'Test email required' });

  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });

  try {
    const testFooter = `<p style="margin-top:32px;font-size:11px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:16px;"><strong>TEST SEND</strong> — This is a preview only.</p>`;
    const rawHtml = campaign.html_body.replace(/\[Name\]/gi, 'there');
    const html = rawHtml.includes('</body>') ? rawHtml.replace('</body>', `${testFooter}</body>`) : rawHtml + testFooter;

    const { sendEmail } = await import('../services/ses.js');
    // NOTE: no campaignId/subscriberId/baseUrl — test sends skip tracking
    // injection so they don't pollute real campaign stats.
    await sendEmail({
      to:        test_email,
      toName:    'Test Recipient',
      fromName:  campaign.from_name,
      fromEmail: campaign.from_email,
      replyTo:   campaign.reply_to || campaign.from_email,
      subject:   `[TEST] ${campaign.subject}`,
      htmlBody:  html,
      plainBody: `TEST SEND\n\n${campaign.plain_body || campaign.html_body.replace(/<[^>]+>/g,'')}`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[test-send] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CAMPAIGN REPORT ───────────────────────────────────────────────────────────

router.get('/campaigns/:id/report', (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });

  // Link click stats
  const linkClicks = db.prepare(`
    SELECT url,
      COUNT(DISTINCT subscriber_id) as unique_clicks,
      COUNT(*) as total_clicks
    FROM email_link_clicks
    WHERE campaign_id=?
    GROUP BY url
    ORDER BY unique_clicks DESC
  `).all(req.params.id);

  // Openers count
  const openers = db.prepare(`
    SELECT COUNT(*) as c FROM email_sends
    WHERE campaign_id=? AND opened_at IS NOT NULL
  `).get(req.params.id);

  res.json({
    campaign,
    link_clicks: linkClicks,
    openers_count: openers.c,
  });
});

// ── EXPORTS ───────────────────────────────────────────────────────────────────

router.get('/campaigns/:id/export/:type', (req, res) => {
  const { type } = req.params;
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });

  let rows = [];
  const header = 'Name,Email,Status\n';

  if (type === 'openers') {
    rows = db.prepare(`
      SELECT es.name, es.email, 'Opened' as status
      FROM email_subscribers es
      JOIN email_sends esnd ON esnd.subscriber_id=es.id
      WHERE esnd.campaign_id=? AND esnd.opened_at IS NOT NULL
    `).all(req.params.id);
  } else if (type === 'clickers') {
    rows = db.prepare(`
      SELECT DISTINCT es.name, es.email, 'Clicked' as status
      FROM email_subscribers es
      JOIN email_link_clicks elc ON elc.subscriber_id=es.id
      WHERE elc.campaign_id=?
    `).all(req.params.id);
  } else if (type === 'non-openers') {
    rows = db.prepare(`
      SELECT es.name, es.email, 'Not opened' as status
      FROM email_subscribers es
      JOIN email_sends esnd ON esnd.subscriber_id=es.id
      WHERE esnd.campaign_id=? AND esnd.opened_at IS NULL
    `).all(req.params.id);
  } else if (type === 'bounced') {
    rows = db.prepare(`
      SELECT es.name, es.email, 'Bounced' as status
      FROM email_subscribers es
      WHERE es.list_id=? AND es.status='bounced'
    `).all(campaign.list_id);
  }

  const csv = header + rows.map(r => `"${r.name||''}","${r.email}","${r.status}"`).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-${req.params.id}.csv"`);
  res.send(csv);
});
