import React, { useState, useEffect, useRef } from 'react';

const GREEN   = '#1D9E75';
const DARK    = '#0F6E56';
const BG      = '#f5f5f3';
const CARD    = '#fff';
const BORDER  = '#e0e0dc';
const TEXT    = '#1a1a1a';
const MUTED   = '#888';
const DANGER  = '#c0392b';

// ── Shared UI helpers ─────────────────────────────────────────────────────────

function Badge({ label, color = GREEN, bg }) {
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 20, fontWeight: 500,
      background: bg || `${color}18`, color
    }}>{label}</span>
  );
}

function Btn({ children, onClick, variant = 'default', small, disabled, style = {} }) {
  const base = {
    border: 'none', borderRadius: 7, cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: 500, fontSize: small ? 12 : 13, padding: small ? '5px 12px' : '8px 18px',
    opacity: disabled ? 0.5 : 1, transition: 'opacity 0.15s', ...style,
  };
  const variants = {
    default: { background: '#f0f0ed', color: TEXT },
    primary: { background: GREEN, color: '#fff' },
    danger:  { background: '#fdecea', color: DANGER },
    ghost:   { background: 'transparent', color: MUTED, border: `0.5px solid ${BORDER}` },
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant] }}>{children}</button>;
}

function Input({ label, value, onChange, placeholder, type = 'text', required, style = {} }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}{required && ' *'}</label>}
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ width: '100%', padding: '8px 12px', border: `0.5px solid ${BORDER}`, borderRadius: 7, fontSize: 13, color: TEXT, background: CARD, outline: 'none', ...style }}
      />
    </div>
  );
}

function Select({ label, value, onChange, options, required }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}{required && ' *'}</label>}
      <select
        value={value} onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '8px 12px', border: `0.5px solid ${BORDER}`, borderRadius: 7, fontSize: 13, color: TEXT, background: CARD, outline: 'none' }}
      >
        <option value="">— select —</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 8, padding: '14px 16px' }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 500, color: TEXT }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: GREEN, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function SectionLabel({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 500, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>{children}</div>;
}

function statusBadge(status) {
  const map = {
    draft:     { label: 'Draft',     color: MUTED,    bg: '#f0f0ed' },
    scheduled: { label: 'Scheduled', color: '#c27a00', bg: '#fff3cd' },
    sending:   { label: 'Sending',   color: GREEN,     bg: `${GREEN}15` },
    sent:      { label: 'Sent',      color: GREEN,     bg: `${GREEN}15` },
    failed:    { label: 'Failed',    color: DANGER,    bg: '#fdecea' },
  };
  const s = map[status] || { label: status, color: MUTED, bg: '#f0f0ed' };
  return <Badge label={s.label} color={s.color} bg={s.bg} />;
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function EmailSection({ clients }) {
  const [tab, setTab]             = useState('campaigns');
  const [stats, setStats]         = useState({});
  const [campaigns, setCampaigns] = useState([]);
  const [lists, setLists]         = useState([]);
  const [domains, setDomains]     = useState([]);
  const [verifiedDomains, setVerifiedDomains] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [modal, setModal]         = useState(null); // 'new-campaign' | 'new-list' | 'import' | 'domain' | 'view-subs'
  const [modalData, setModalData] = useState({});

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [s, c, l, vd] = await Promise.all([
        fetch('/api/email/stats').then(r => r.json()),
        fetch('/api/email/campaigns').then(r => r.json()),
        fetch('/api/email/lists').then(r => r.json()),
        fetch('/api/email/verified-domains').then(r => r.json()),
      ]);
      setStats(s);
      setCampaigns(Array.isArray(c) ? c : []);
      setLists(Array.isArray(l) ? l : []);
      setVerifiedDomains(Array.isArray(vd) ? vd : []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function deleteCampaign(id) {
    if (!confirm('Delete this campaign?')) return;
    await fetch(`/api/email/campaigns/${id}`, { method: 'DELETE' });
    loadAll();
  }

  async function sendCampaign(id) {
    if (!confirm('Send this campaign now to all active subscribers?')) return;
    const r = await fetch(`/api/email/campaigns/${id}/send`, { method: 'POST' });
    const d = await r.json();
    if (d.ok) { alert(`Sending to ${d.subscribers} subscribers. This runs in the background.`); loadAll(); }
    else alert(d.error || 'Send failed');
  }

  async function deleteList(id) {
    if (!confirm('Delete this list and all its subscribers?')) return;
    await fetch(`/api/email/lists/${id}`, { method: 'DELETE' });
    loadAll();
  }

  async function checkDomain(domain) {
    setDomains(prev => prev.filter(d => d.domain !== domain));
    const r = await fetch(`/api/email/domain-health/${domain}`);
    const d = await r.json();
    setDomains(prev => [...prev.filter(x => x.domain !== domain), d]);
  }

  const tabs = ['campaigns', 'lists', 'domain health'];

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 28, background: BG }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 500, color: TEXT }}>Email</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {tab === 'campaigns' && <Btn variant="primary" onClick={() => setModal('new-campaign')}>+ New campaign</Btn>}
          {tab === 'lists'     && <Btn variant="primary" onClick={() => setModal('new-list')}>+ New list</Btn>}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
        <StatCard label="Mailing lists"   value={stats.lists}       sub="total" />
        <StatCard label="Subscribers"     value={stats.subscribers?.toLocaleString()} sub="active" />
        <StatCard label="Campaigns"       value={stats.campaigns}   sub="all time" />
        <StatCard label="Emails sent"     value={stats.sent?.toLocaleString()} sub={stats.quota ? `${stats.quota.sentLast24Hours?.toFixed(0)} in last 24h` : 'all time'} />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: `0.5px solid ${BORDER}` }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 18px', fontSize: 13, border: 'none', background: 'transparent', cursor: 'pointer',
            color: tab === t ? GREEN : MUTED, fontWeight: tab === t ? 500 : 400,
            borderBottom: tab === t ? `2px solid ${GREEN}` : '2px solid transparent',
            textTransform: 'capitalize',
          }}>{t}</button>
        ))}
      </div>

      {loading && <div style={{ color: MUTED, textAlign: 'center', padding: '40px 0' }}>Loading...</div>}

      {/* ── CAMPAIGNS TAB ── */}
      {!loading && tab === 'campaigns' && (
        <div>
          <SectionLabel>All campaigns</SectionLabel>
          {campaigns.length === 0 ? (
            <div style={{ background: CARD, border: `0.5px dashed ${BORDER}`, borderRadius: 12, padding: 48, textAlign: 'center', color: MUTED }}>
              No campaigns yet. Create your first one.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {campaigns.map(c => (
                <div key={c.id} style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 10, padding: '16px 18px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500, color: TEXT, marginBottom: 2 }}>{c.title}</div>
                      <div style={{ fontSize: 12, color: MUTED }}>
                        {c.client_name} · {c.list_name} · From: {c.from_email}
                      </div>
                    </div>
                    {statusBadge(c.status)}
                  </div>

                  <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
                    Subject: <span style={{ color: TEXT }}>{c.subject}</span>
                    {c.scheduled_at && <span style={{ marginLeft: 12 }}>Scheduled: {new Date(c.scheduled_at).toLocaleString('en-GB')}</span>}
                    {c.sent_at      && <span style={{ marginLeft: 12 }}>Sent: {new Date(c.sent_at).toLocaleString('en-GB')} · {c.sent_count} recipients</span>}
                  </div>

                  {c.status === 'sent' && (
                    <div style={{ display: 'flex', gap: 16, fontSize: 12, color: MUTED, marginBottom: 10 }}>
                      <span>Opens: <b style={{ color: TEXT }}>{c.open_count}</b></span>
                      <span>Clicks: <b style={{ color: TEXT }}>{c.click_count}</b></span>
                      <span>Bounces: <b style={{ color: TEXT }}>{c.bounce_count}</b></span>
                      <span>Unsubs: <b style={{ color: TEXT }}>{c.unsubscribe_count}</b></span>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(c.status === 'draft' || c.status === 'scheduled') && (
                      <>
                        <Btn small onClick={() => { setModalData(c); setModal('edit-campaign'); }}>Edit</Btn>
                        <Btn small variant="primary" onClick={() => sendCampaign(c.id)}>Send now</Btn>
                      </>
                    )}
                    {c.status !== 'sending' && (
                      <Btn small variant="danger" onClick={() => deleteCampaign(c.id)}>Delete</Btn>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── LISTS TAB ── */}
      {!loading && tab === 'lists' && (
        <div>
          <SectionLabel>Mailing lists</SectionLabel>
          {lists.length === 0 ? (
            <div style={{ background: CARD, border: `0.5px dashed ${BORDER}`, borderRadius: 12, padding: 48, textAlign: 'center', color: MUTED }}>
              No lists yet. Create your first mailing list.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
              {lists.map(l => (
                <div key={l.id} style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 10, padding: '16px 18px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 500, color: TEXT, marginBottom: 2 }}>{l.name}</div>
                      <div style={{ fontSize: 12, color: MUTED }}>{l.client_name}</div>
                    </div>
                    <Badge label={`${l.subscriber_count} subscribers`} color={GREEN} />
                  </div>
                  <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
                    From: {l.from_name} &lt;{l.from_email}&gt;
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Btn small onClick={() => { setModalData(l); setModal('view-subs'); }}>View subscribers</Btn>
                    <Btn small onClick={() => { setModalData(l); setModal('import'); }}>Import CSV</Btn>
                    <Btn small variant="danger" onClick={() => deleteList(l.id)}>Delete</Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── DOMAIN HEALTH TAB ── */}
      {!loading && tab === 'domain health' && (
        <div>
          <SectionLabel>Domain health checker</SectionLabel>
          <p style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
            Checks SPF, DKIM, DMARC and MX records for your verified sending domains. Run this before new campaigns to protect deliverability.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
            {verifiedDomains.map(d => (
              <Btn key={d} small onClick={() => checkDomain(d)}>Check {d}</Btn>
            ))}
            <Btn small variant="ghost" onClick={() => { setModal('custom-domain'); }}>+ Custom domain</Btn>
          </div>

          {domains.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
              {domains.map(d => (
                <DomainCard key={d.domain} data={d} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── MODALS ── */}
      {modal === 'new-campaign'  && <CampaignModal clients={clients} lists={lists} verifiedDomains={verifiedDomains} onClose={() => setModal(null)} onSaved={loadAll} />}
      {modal === 'edit-campaign' && <CampaignModal clients={clients} lists={lists} verifiedDomains={verifiedDomains} initial={modalData} onClose={() => setModal(null)} onSaved={loadAll} />}
      {modal === 'new-list'      && <ListModal clients={clients} verifiedDomains={verifiedDomains} onClose={() => setModal(null)} onSaved={loadAll} />}
      {modal === 'import'        && <ImportModal list={modalData} onClose={() => setModal(null)} onSaved={loadAll} />}
      {modal === 'view-subs'     && <SubscribersModal list={modalData} onClose={() => setModal(null)} onSaved={loadAll} />}
      {modal === 'custom-domain' && <CustomDomainModal onClose={() => setModal(null)} onCheck={d => { setModal(null); checkDomain(d); }} />}
    </div>
  );
}

// ── Domain health card ────────────────────────────────────────────────────────

function DomainCard({ data }) {
  const checks = [
    { label: 'SPF',   result: data.spf   },
    { label: 'DKIM',  result: data.dkim  },
    { label: 'DMARC', result: data.dmarc },
    { label: 'MX',    result: data.mx    },
  ];
  const allPass = checks.every(c => c.result?.status === 'pass');

  return (
    <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 10, padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: TEXT }}>{data.domain}</div>
        <Badge label={allPass ? 'All pass' : 'Issues found'} color={allPass ? GREEN : DANGER} />
      </div>
      {checks.map(({ label, result }) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: `0.5px solid ${BORDER}`, fontSize: 12 }}>
          <span style={{ color: MUTED }}>{label}</span>
          <span style={{ color: result?.status === 'pass' ? GREEN : DANGER, fontWeight: 500 }}>
            {result?.status === 'pass' ? 'Pass' : result?.status === 'missing' ? 'Missing' : '—'}
          </span>
        </div>
      ))}
      {data.dkim?.selector && (
        <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>DKIM selector: {data.dkim.selector}</div>
      )}
    </div>
  );
}

// ── Campaign modal ────────────────────────────────────────────────────────────

function CampaignModal({ clients, lists, verifiedDomains, initial, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [form, setForm] = useState({
    client_id:   initial?.client_id   || '',
    list_id:     initial?.list_id     || '',
    title:       initial?.title       || '',
    subject:     initial?.subject     || '',
    from_name:   initial?.from_name   || 'The Green Agents',
    from_email:  initial?.from_email  || '',
    reply_to:    initial?.reply_to    || '',
    html_body:   initial?.html_body   || '',
    scheduled_at: initial?.scheduled_at || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  const clientLists = lists.filter(l => !form.client_id || l.client_id === form.client_id);
  const domainOptions = verifiedDomains.map(d => ({ value: `hello@${d}`, label: `hello@${d}` }));

  async function save() {
    if (!form.client_id || !form.list_id || !form.title || !form.subject || !form.from_email || !form.html_body) {
      setErr('Please fill all required fields'); return;
    }
    setSaving(true); setErr('');
    try {
      const url    = editing ? `/api/email/campaigns/${initial.id}` : '/api/email/campaigns';
      const method = editing ? 'PUT' : 'POST';
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const d = await r.json();
      if (d.error) { setErr(d.error); setSaving(false); return; }
      onSaved(); onClose();
    } catch (e) { setErr(e.message); setSaving(false); }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Modal title={editing ? 'Edit campaign' : 'New campaign'} onClose={onClose} wide>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
        <Select label="Client *" value={form.client_id} onChange={v => set('client_id', v)}
          options={clients.map(c => ({ value: c.id, label: c.name }))} required />
        <Select label="Mailing list *" value={form.list_id} onChange={v => set('list_id', v)}
          options={clientLists.map(l => ({ value: l.id, label: l.name }))} required />
        <Input label="Campaign title *" value={form.title} onChange={v => set('title', v)} placeholder="May outreach — Tower Leasing" required />
        <Input label="Email subject *" value={form.subject} onChange={v => set('subject', v)} placeholder="Is waiting costing your business?" required />
        <Input label="From name *" value={form.from_name} onChange={v => set('from_name', v)} placeholder="The Green Agents" required />
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>From email *</label>
          <select value={form.from_email} onChange={e => set('from_email', e.target.value)}
            style={{ width: '100%', padding: '8px 12px', border: `0.5px solid ${BORDER}`, borderRadius: 7, fontSize: 13, color: TEXT, background: CARD }}>
            <option value="">— select verified domain —</option>
            {verifiedDomains.map(d => [
              <option key={`hello@${d}`} value={`hello@${d}`}>hello@{d}</option>,
              <option key={`noreply@${d}`} value={`noreply@${d}`}>noreply@{d}</option>,
              <option key={`contact@${d}`} value={`contact@${d}`}>contact@{d}</option>,
            ])}
          </select>
        </div>
        <Input label="Reply-to" value={form.reply_to} onChange={v => set('reply_to', v)} placeholder="Same as from email" />
        <Input label="Schedule send (optional)" value={form.scheduled_at} onChange={v => set('scheduled_at', v)} type="datetime-local" />
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>Email body (HTML) *</label>
        <textarea
          value={form.html_body}
          onChange={e => set('html_body', e.target.value)}
          placeholder="Paste HTML email body here, or write plain text. An unsubscribe link will be automatically appended."
          rows={10}
          style={{ width: '100%', padding: '10px 12px', border: `0.5px solid ${BORDER}`, borderRadius: 7, fontSize: 13, color: TEXT, background: CARD, fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box' }}
        />
      </div>

      {err && <div style={{ color: DANGER, fontSize: 13, marginBottom: 10 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : editing ? 'Save changes' : 'Create campaign'}</Btn>
      </div>
    </Modal>
  );
}

// ── List modal ────────────────────────────────────────────────────────────────

function ListModal({ clients, verifiedDomains, onClose, onSaved }) {
  const [form, setForm] = useState({ client_id: '', name: '', from_name: 'The Green Agents', from_email: '', reply_to: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!form.client_id || !form.name || !form.from_name || !form.from_email) {
      setErr('Please fill all required fields'); return;
    }
    setSaving(true); setErr('');
    try {
      const r = await fetch('/api/email/lists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, reply_to: form.reply_to || form.from_email }) });
      const d = await r.json();
      if (d.error) { setErr(d.error); setSaving(false); return; }
      onSaved(); onClose();
    } catch(e) { setErr(e.message); setSaving(false); }
  }

  return (
    <Modal title="New mailing list" onClose={onClose}>
      <Select label="Client *" value={form.client_id} onChange={v => set('client_id', v)}
        options={clients.map(c => ({ value: c.id, label: c.name }))} required />
      <Input label="List name *" value={form.name} onChange={v => set('name', v)} placeholder="Tower Leasing — May prospects" required />
      <Input label="From name *" value={form.from_name} onChange={v => set('from_name', v)} required />
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>From email *</label>
        <select value={form.from_email} onChange={e => set('from_email', e.target.value)}
          style={{ width: '100%', padding: '8px 12px', border: `0.5px solid ${BORDER}`, borderRadius: 7, fontSize: 13, color: TEXT, background: CARD }}>
          <option value="">— select —</option>
          {verifiedDomains.map(d => [
            <option key={`hello@${d}`} value={`hello@${d}`}>hello@{d}</option>,
            <option key={`noreply@${d}`} value={`noreply@${d}`}>noreply@{d}</option>,
          ])}
        </select>
      </div>
      <Input label="Reply-to (leave blank to use from email)" value={form.reply_to} onChange={v => set('reply_to', v)} />
      {err && <div style={{ color: DANGER, fontSize: 13, marginBottom: 10 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Create list'}</Btn>
      </div>
    </Modal>
  );
}

// ── Import CSV modal ──────────────────────────────────────────────────────────

function ImportModal({ list, onClose, onSaved }) {
  const [csv, setCsv]     = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef();

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setCsv(ev.target.result);
    reader.readAsText(file);
  }

  async function importNow() {
    if (!csv.trim()) return;
    setSaving(true);
    const r = await fetch(`/api/email/lists/${list.id}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
    const d = await r.json();
    setResult(d);
    setSaving(false);
    if (d.ok) onSaved();
  }

  return (
    <Modal title={`Import subscribers — ${list.name}`} onClose={onClose}>
      <p style={{ fontSize: 13, color: MUTED, marginBottom: 12 }}>
        Upload a CSV file with columns: <code>email, name</code> (name is optional). One per line. Header row is optional.
      </p>
      <div style={{ marginBottom: 14 }}>
        <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFile} style={{ fontSize: 13 }} />
      </div>
      {csv && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>Preview / edit</label>
          <textarea value={csv} onChange={e => setCsv(e.target.value)} rows={8}
            style={{ width: '100%', padding: '8px 12px', border: `0.5px solid ${BORDER}`, borderRadius: 7, fontSize: 12, fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical' }} />
        </div>
      )}
      {result && (
        <div style={{ padding: '8px 12px', background: result.ok ? `${GREEN}15` : '#fdecea', borderRadius: 7, fontSize: 13, color: result.ok ? DARK : DANGER, marginBottom: 12 }}>
          {result.ok ? `Added ${result.added} subscribers successfully.` : result.error}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn onClick={onClose}>Close</Btn>
        {!result?.ok && <Btn variant="primary" onClick={importNow} disabled={saving || !csv.trim()}>{saving ? 'Importing...' : 'Import'}</Btn>}
      </div>
    </Modal>
  );
}

// ── Subscribers modal ─────────────────────────────────────────────────────────

function SubscribersModal({ list, onClose, onSaved }) {
  const [subs, setSubs]   = useState([]);
  const [filter, setFilter] = useState('subscribed');
  const [loading, setLoading] = useState(true);
  const [addEmail, setAddEmail] = useState('');
  const [addName, setAddName]   = useState('');

  async function load() {
    setLoading(true);
    const r = await fetch(`/api/email/lists/${list.id}/subscribers?status=${filter}`);
    setSubs(await r.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, [filter]);

  async function addSub() {
    if (!addEmail) return;
    await fetch(`/api/email/lists/${list.id}/subscribers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: addEmail, name: addName }) });
    setAddEmail(''); setAddName(''); load(); onSaved();
  }

  async function unsub(subId) {
    await fetch(`/api/email/lists/${list.id}/subscribers/${subId}`, { method: 'DELETE' });
    load(); onSaved();
  }

  return (
    <Modal title={`Subscribers — ${list.name}`} onClose={onClose} wide>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['subscribed','unsubscribed','bounced'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            style={{ padding: '5px 14px', fontSize: 12, border: `0.5px solid ${BORDER}`, borderRadius: 20, background: filter === s ? GREEN : 'transparent', color: filter === s ? '#fff' : MUTED, cursor: 'pointer', textTransform: 'capitalize' }}>
            {s}
          </button>
        ))}
      </div>

      {/* Quick add */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input value={addEmail} onChange={e => setAddEmail(e.target.value)} placeholder="Email address"
          style={{ flex: 2, padding: '7px 12px', border: `0.5px solid ${BORDER}`, borderRadius: 7, fontSize: 13 }} />
        <input value={addName} onChange={e => setAddName(e.target.value)} placeholder="Name (optional)"
          style={{ flex: 1, padding: '7px 12px', border: `0.5px solid ${BORDER}`, borderRadius: 7, fontSize: 13 }} />
        <Btn small variant="primary" onClick={addSub}>Add</Btn>
      </div>

      {loading ? <div style={{ color: MUTED, textAlign: 'center', padding: 24 }}>Loading...</div> : (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {subs.length === 0 ? (
            <div style={{ color: MUTED, textAlign: 'center', padding: 24, fontSize: 13 }}>No {filter} subscribers</div>
          ) : subs.map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `0.5px solid ${BORDER}`, fontSize: 13 }}>
              <div>
                <span style={{ color: TEXT }}>{s.email}</span>
                {s.name && <span style={{ color: MUTED, marginLeft: 8 }}>{s.name}</span>}
              </div>
              {s.status === 'subscribed' && (
                <Btn small variant="danger" onClick={() => unsub(s.id)}>Unsubscribe</Btn>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Btn onClick={onClose}>Close</Btn>
      </div>
    </Modal>
  );
}

// ── Custom domain modal ───────────────────────────────────────────────────────

function CustomDomainModal({ onClose, onCheck }) {
  const [domain, setDomain] = useState('');
  return (
    <Modal title="Check custom domain" onClose={onClose}>
      <Input label="Domain" value={domain} onChange={setDomain} placeholder="yourdomain.com" />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={() => domain && onCheck(domain.trim().toLowerCase())}>Check</Btn>
      </div>
    </Modal>
  );
}

// ── Generic modal wrapper ─────────────────────────────────────────────────────

function Modal({ title, children, onClose, wide }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: CARD, borderRadius: 12, padding: 28, width: wide ? 760 : 480, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 500, color: TEXT }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: MUTED, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
