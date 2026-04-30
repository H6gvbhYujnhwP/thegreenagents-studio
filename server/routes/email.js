import express from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendCampaign, getQuota } from '../services/ses.js';
import dns from 'dns';
import { promisify } from 'util';

const router  = express.Router();
const resolve = promisify(dns.resolveTxt);
const resolveMx = promisify(dns.resolveMx);

// All routes except unsubscribe require auth
router.use((req, res, next) => {
  if (req.path.startsWith('/unsubscribe')) return next();
  requireAuth(req, res, next);
});

// ── STATS ────────────────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const lists       = db.prepare('SELECT COUNT(*) as c FROM email_lists').get().c;
    const subscribers = db.prepare("SELECT COUNT(*) as c FROM email_subscribers WHERE status='subscribed'").get().c;
    const campaigns   = db.prepare('SELECT COUNT(*) as c FROM email_campaigns').get().c;
    const sent        = db.prepare("SELECT COALESCE(SUM(sent_count),0) as c FROM email_campaigns WHERE status='sent'").get().c;
    let quota = null;
    try { quota = await getQuota(); } catch(e) { /* SES unreachable in dev */ }
    res.json({ lists, subscribers, campaigns, sent, quota });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LISTS ────────────────────────────────────────────────────────────────────

router.get('/lists', (req, res) => {
  const { client_id } = req.query;
  const rows = client_id
    ? db.prepare('SELECT * FROM email_lists WHERE client_id=? ORDER BY created_at DESC').all(client_id)
    : db.prepare('SELECT el.*, c.name as client_name FROM email_lists el JOIN clients c ON el.client_id=c.id ORDER BY el.created_at DESC').all();
  res.json(rows);
});

router.post('/lists', (req, res) => {
  const { client_id, name, from_name, from_email, reply_to } = req.body;
  if (!client_id || !name || !from_name || !from_email || !reply_to) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const id = uuid();
  db.prepare('INSERT INTO email_lists (id,client_id,name,from_name,from_email,reply_to) VALUES (?,?,?,?,?,?)')
    .run(id, client_id, name, from_name, from_email, reply_to);
  res.json(db.prepare('SELECT * FROM email_lists WHERE id=?').get(id));
});

router.delete('/lists/:id', (req, res) => {
  db.prepare('DELETE FROM email_subscribers WHERE list_id=?').run(req.params.id);
  db.prepare('DELETE FROM email_lists WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── SUBSCRIBERS ──────────────────────────────────────────────────────────────

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
    // update count
    db.prepare("UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?")
      .run(req.params.id, req.params.id);
    res.json({ ok: true, id });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Already subscribed' });
    res.status(500).json({ error: err.message });
  }
});

// Bulk import from CSV text
router.post('/lists/:id/import', (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV data' });

  const lines  = csv.trim().split('\n').filter(Boolean);
  const insert = db.prepare('INSERT OR IGNORE INTO email_subscribers (id,list_id,email,name) VALUES (?,?,?,?)');
  const insertMany = db.transaction((rows) => {
    let added = 0;
    for (const line of rows) {
      const [emailRaw, nameRaw] = line.split(',');
      const email = emailRaw?.trim().toLowerCase();
      if (!email || !email.includes('@')) continue;
      insert.run(uuid(), req.params.id, email, nameRaw?.trim() || null);
      added++;
    }
    return added;
  });

  // skip header row if it contains "email"
  const dataRows = lines[0]?.toLowerCase().includes('email') ? lines.slice(1) : lines;
  const added = insertMany(dataRows);

  // update count
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

// ── CAMPAIGNS ────────────────────────────────────────────────────────────────

router.get('/campaigns', (req, res) => {
  const { client_id } = req.query;
  const rows = client_id
    ? db.prepare(`SELECT ec.*, el.name as list_name, c.name as client_name
        FROM email_campaigns ec
        JOIN email_lists el ON ec.list_id=el.id
        JOIN clients c ON ec.client_id=c.id
        WHERE ec.client_id=? ORDER BY ec.created_at DESC`).all(client_id)
    : db.prepare(`SELECT ec.*, el.name as list_name, c.name as client_name
        FROM email_campaigns ec
        JOIN email_lists el ON ec.list_id=el.id
        JOIN clients c ON ec.client_id=c.id
        ORDER BY ec.created_at DESC`).all();
  res.json(rows);
});

router.post('/campaigns', (req, res) => {
  const { client_id, list_id, title, subject, from_name, from_email, reply_to, html_body, plain_body, scheduled_at } = req.body;
  if (!client_id || !list_id || !title || !subject || !from_name || !from_email || !html_body) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const id = uuid();
  db.prepare(`INSERT INTO email_campaigns
    (id,client_id,list_id,title,subject,from_name,from_email,reply_to,html_body,plain_body,status,scheduled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, client_id, list_id, title, subject, from_name, from_email, reply_to || from_email, html_body, plain_body || null, scheduled_at ? 'scheduled' : 'draft', scheduled_at || null);
  res.json(db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(id));
});

router.put('/campaigns/:id', (req, res) => {
  const { title, subject, from_name, from_email, reply_to, html_body, plain_body, scheduled_at, list_id } = req.body;
  const current = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  if (current.status === 'sent') return res.status(400).json({ error: 'Cannot edit a sent campaign' });

  const status = scheduled_at ? 'scheduled' : 'draft';
  db.prepare(`UPDATE email_campaigns SET
    title=?, subject=?, from_name=?, from_email=?, reply_to=?, html_body=?, plain_body=?,
    scheduled_at=?, status=?, list_id=COALESCE(?,list_id)
    WHERE id=?`)
    .run(title ?? current.title, subject ?? current.subject, from_name ?? current.from_name,
      from_email ?? current.from_email, reply_to ?? current.reply_to,
      html_body ?? current.html_body, plain_body ?? current.plain_body,
      scheduled_at ?? current.scheduled_at, status, list_id ?? null, req.params.id);
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

// ── SEND ─────────────────────────────────────────────────────────────────────

router.post('/campaigns/:id/send', async (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (campaign.status === 'sent') return res.status(400).json({ error: 'Already sent' });
  if (campaign.status === 'sending') return res.status(400).json({ error: 'Currently sending' });

  const subscribers = db.prepare("SELECT * FROM email_subscribers WHERE list_id=? AND status='subscribed'").all(campaign.list_id);
  if (subscribers.length === 0) return res.status(400).json({ error: 'No active subscribers in list' });

  // Mark as sending immediately
  db.prepare("UPDATE email_campaigns SET status='sending' WHERE id=?").run(campaign.id);

  const baseUrl = `${req.protocol}://${req.get('host')}`;

  // Fire and forget — respond immediately, send in background
  res.json({ ok: true, subscribers: subscribers.length });

  try {
    const results = await sendCampaign({
      campaign,
      subscribers,
      baseUrl,
      onProgress: (pct) => {
        db.prepare('UPDATE email_campaigns SET sent_count=? WHERE id=?')
          .run(Math.round(subscribers.length * pct / 100), campaign.id);
      },
    });

    // Record individual sends
    const insertSend = db.prepare('INSERT OR IGNORE INTO email_sends (id,campaign_id,subscriber_id,status) VALUES (?,?,?,?)');
    const insertAll  = db.transaction(() => {
      for (const sub of subscribers) {
        insertSend.run(uuid(), campaign.id, sub.id, 'sent');
      }
    });
    insertAll();

    db.prepare(`UPDATE email_campaigns SET status='sent', sent_at=datetime('now'), sent_count=? WHERE id=?`)
      .run(results.sent, campaign.id);
  } catch (err) {
    db.prepare("UPDATE email_campaigns SET status='failed' WHERE id=?").run(campaign.id);
    console.error('[email/send] error:', err.message);
  }
});

// ── UNSUBSCRIBE (public — no auth) ───────────────────────────────────────────

router.get('/unsubscribe', (req, res) => {
  const { sid, cid } = req.query;
  if (!sid) return res.status(400).send('Invalid unsubscribe link');

  const sub = db.prepare('SELECT * FROM email_subscribers WHERE id=?').get(sid);
  if (!sub) return res.status(404).send('Subscriber not found');

  db.prepare("UPDATE email_subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') WHERE id=?").run(sid);
  db.prepare("UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?")
    .run(sub.list_id, sub.list_id);

  if (cid) {
    db.prepare('UPDATE email_campaigns SET unsubscribe_count=unsubscribe_count+1 WHERE id=?').run(cid);
  }

  res.send(`<!DOCTYPE html><html><head><title>Unsubscribed</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f3;}
    .box{text-align:center;padding:40px;max-width:400px;}h1{font-size:22px;font-weight:500;color:#1a1a1a;margin-bottom:12px;}
    p{color:#666;font-size:14px;line-height:1.6;}</style></head>
    <body><div class="box"><h1>You've been unsubscribed</h1>
    <p>Your email address has been removed from this mailing list. You won't receive any further emails from this campaign.</p>
    </div></body></html>`);
});

// ── DOMAIN HEALTH ────────────────────────────────────────────────────────────

router.get('/domain-health/:domain', async (req, res) => {
  const domain = req.params.domain;
  const results = { domain, spf: null, dkim: null, dmarc: null, mx: null, error: null };

  try {
    // SPF
    try {
      const txt = await resolve(domain);
      const spfRecord = txt.flat().find(r => r.startsWith('v=spf1'));
      results.spf = spfRecord
        ? { status: 'pass', record: spfRecord }
        : { status: 'missing', record: null };
    } catch { results.spf = { status: 'missing', record: null }; }

    // DMARC
    try {
      const dmarc = await resolve(`_dmarc.${domain}`);
      const rec   = dmarc.flat().find(r => r.startsWith('v=DMARC1'));
      results.dmarc = rec
        ? { status: 'pass', record: rec }
        : { status: 'missing', record: null };
    } catch { results.dmarc = { status: 'missing', record: null }; }

    // MX
    try {
      const mx = await resolveMx(domain);
      results.mx = mx.length > 0
        ? { status: 'pass', records: mx.map(r => r.exchange) }
        : { status: 'missing', records: [] };
    } catch { results.mx = { status: 'missing', records: [] }; }

    // DKIM — we check the common selectors used by SES and Google
    const selectors = ['amazonses', 'google', 'default', 'mail', 'dkim'];
    let dkimFound   = false;
    for (const sel of selectors) {
      try {
        const rec = await resolve(`${sel}._domainkey.${domain}`);
        if (rec.flat().some(r => r.includes('v=DKIM1'))) {
          results.dkim = { status: 'pass', selector: sel };
          dkimFound = true;
          break;
        }
      } catch { /* try next selector */ }
    }
    if (!dkimFound) results.dkim = { status: 'missing', selector: null };

  } catch (err) {
    results.error = err.message;
  }

  res.json(results);
});

// ── VERIFIED SES DOMAINS (for from-address picker) ───────────────────────────
// Returns the list of domains we know are verified, sourced from env or hardcoded
router.get('/verified-domains', (req, res) => {
  // These are the verified identities we confirmed from the AWS console screenshots
  const domains = [
    'thegreenagents.com',
    'sweetbyte.co.uk',
    'clear-a-way.co.uk',
    'itcloudpros.uk',
    'mail.engineersolutions.co.uk',
    'syncsure.cloud',
    'socialecho.ai',
    'clearerpaths.co.uk',
    'mail.weprintcatalogues.com',
  ];
  res.json(domains);
});

export default router;
