import React, { useState, useEffect, useRef } from 'react';

const GREEN  = '#1D9E75';
const DARK   = '#0F6E56';
const BG     = '#f5f5f3';
const CARD   = '#fff';
const BORDER = '#e0e0dc';
const TEXT   = '#1a1a1a';
const MUTED  = '#888';
const DANGER = '#c0392b';

const BRAND_COLORS = ['#1D9E75','#0F6E56','#534AB7','#185FA5','#993C1D','#854F0B','#3B6D11','#D4537E','#5F5E5A'];

function initials(name) {
  return name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
}

// ── Shared UI ──────────────────────────────────────────────────────────────────

function Btn({ children, onClick, variant='default', small, disabled, style={} }) {
  const v = {
    default: { background:'#f0f0ed', color:TEXT },
    primary: { background:GREEN, color:'#fff' },
    danger:  { background:'#fdecea', color:DANGER },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      border:'none', borderRadius:7, cursor:disabled?'not-allowed':'pointer',
      fontWeight:500, fontSize:small?11:13, padding:small?'4px 10px':'8px 18px',
      opacity:disabled?0.5:1, ...v[variant], ...style
    }}>{children}</button>
  );
}

function Input({ label, value, onChange, placeholder, type='text', required, rows, style={} }) {
  const base = { width:'100%', padding:'8px 12px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:CARD, outline:'none', boxSizing:'border-box', ...style };
  return (
    <div style={{ marginBottom:14 }}>
      {label && <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{label}{required&&' *'}</label>}
      {rows
        ? <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{ ...base, fontFamily:'monospace', resize:'vertical' }} />
        : <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={base} />
      }
    </div>
  );
}

function SelInput({ label, value, onChange, options, required }) {
  return (
    <div style={{ marginBottom:14 }}>
      {label && <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{label}{required&&' *'}</label>}
      <select value={value} onChange={e=>onChange(e.target.value)}
        style={{ width:'100%', padding:'8px 12px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:CARD, outline:'none' }}>
        <option value="">— select —</option>
        {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function Badge({ label, color=GREEN, bg }) {
  return <span style={{ fontSize:10, padding:'2px 8px', borderRadius:20, fontWeight:500, background:bg||`${color}18`, color, whiteSpace:'nowrap' }}>{label}</span>;
}

function statusBadge(status) {
  const m = {
    draft:     { l:'Draft',     c:MUTED,    b:'#f0f0ed' },
    scheduled: { l:'Scheduled', c:'#c27a00', b:'#fff3cd' },
    sending:   { l:'Sending',   c:GREEN,     b:`${GREEN}15` },
    sent:      { l:'Sent',      c:GREEN,     b:`${GREEN}15` },
    failed:    { l:'Failed',    c:DANGER,    b:'#fdecea' },
  };
  const s = m[status]||{ l:status, c:MUTED, b:'#f0f0ed' };
  return <Badge label={s.l} color={s.c} bg={s.b} />;
}

function Modal({ title, children, onClose, wide }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ background:CARD, borderRadius:12, padding:28, width:wide?760:480, maxWidth:'95vw', maxHeight:'90vh', overflowY:'auto', boxShadow:'0 8px 40px rgba(0,0,0,0.15)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h2 style={{ fontSize:16, fontWeight:500, color:TEXT }}>{title}</h2>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:22, color:MUTED, cursor:'pointer', lineHeight:1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Email Client modal ─────────────────────────────────────────────────────────

function ClientModal({ initial, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [name, setName] = useState(initial?.name || '');
  const [color, setColor] = useState(initial?.color || '#1D9E75');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    if (!name.trim()) { setErr('Name required'); return; }
    setSaving(true); setErr('');
    const url    = editing ? `/api/email/clients/${initial.id}` : '/api/email/clients';
    const method = editing ? 'PUT' : 'POST';
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name, color }) });
    const d = await r.json();
    if (d.error) { setErr(d.error); setSaving(false); return; }
    onSaved(); onClose();
  }

  return (
    <Modal title={editing ? 'Edit client' : 'New client'} onClose={onClose}>
      <Input label="Client name *" value={name} onChange={setName} placeholder="Tower Leasing" required />
      <div style={{ marginBottom:14 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>Colour</label>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {BRAND_COLORS.map(c=>(
            <div key={c} onClick={()=>setColor(c)} style={{ width:24, height:24, borderRadius:6, background:c, cursor:'pointer', border:color===c?`2px solid ${TEXT}`:'2px solid transparent' }} />
          ))}
        </div>
      </div>
      {err && <div style={{ color:DANGER, fontSize:13, marginBottom:10 }}>{err}</div>}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving}>{saving?'Saving...':editing?'Save changes':'Create client'}</Btn>
      </div>
    </Modal>
  );
}

// ── Brand modal ────────────────────────────────────────────────────────────────

function BrandModal({ emailClient, initial, verifiedDomains, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [form, setForm] = useState({
    name:       initial?.name       || emailClient.name,
    from_name:  initial?.from_name  || '',
    from_email: initial?.from_email || '',
    reply_to:   initial?.reply_to   || '',
    color:      initial?.color      || emailClient.color || '#1D9E75',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  async function save() {
    if (!form.name||!form.from_name||!form.from_email) { setErr('Fill all required fields'); return; }
    setSaving(true); setErr('');
    const url    = editing ? `/api/email/brands/${initial.id}` : '/api/email/brands';
    const method = editing ? 'PUT' : 'POST';
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ...form, email_client_id: emailClient.id }) });
    const d = await r.json();
    if (d.error) { setErr(d.error); setSaving(false); return; }
    onSaved(); onClose();
  }

  return (
    <Modal title={editing ? 'Edit brand' : 'New sending identity'} onClose={onClose}>
      <Input label="Brand / identity name *" value={form.name} onChange={v=>set('name',v)} placeholder="Tower Leasing" required />
      <Input label="From name *" value={form.from_name} onChange={v=>set('from_name',v)} placeholder="Wez at Tower Leasing" required />
      <Input label="From email *" value={form.from_email} onChange={v=>set('from_email',v)} placeholder={`hello@${emailClient.name}`} required />
      <Input label="Reply-to (leave blank to match from email)" value={form.reply_to} onChange={v=>set('reply_to',v)} />
      <div style={{ marginBottom:14 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>Colour</label>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {BRAND_COLORS.map(c=>(
            <div key={c} onClick={()=>set('color',c)} style={{ width:24, height:24, borderRadius:6, background:c, cursor:'pointer', border:form.color===c?`2px solid ${TEXT}`:'2px solid transparent' }} />
          ))}
        </div>
      </div>
      {err && <div style={{ color:DANGER, fontSize:13, marginBottom:10 }}>{err}</div>}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving}>{saving?'Saving...':editing?'Save changes':'Create brand'}</Btn>
      </div>
    </Modal>
  );
}

// ── Campaign modal ─────────────────────────────────────────────────────────────

function CampaignModal({ emailClient, lists, verifiedDomains, initial, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [form, setForm] = useState({
    list_id:      initial?.list_id      || '',
    title:        initial?.title        || '',
    subject:      initial?.subject      || '',
    from_name:    initial?.from_name    || '',
    from_email:   initial?.from_email   || '',
    reply_to:     initial?.reply_to     || '',
    html_body:    initial?.html_body    || '',
    scheduled_at: initial?.scheduled_at || '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  async function save() {
    if (!form.list_id||!form.title||!form.subject||!form.from_email||!form.html_body) { setErr('Fill all required fields'); return; }
    setSaving(true); setErr('');
    const url    = editing ? `/api/email/campaigns/${initial.id}` : '/api/email/campaigns';
    const method = editing ? 'PUT' : 'POST';
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ...form, email_client_id: emailClient.id }) });
    const d = await r.json();
    if (d.error) { setErr(d.error); setSaving(false); return; }
    onSaved(); onClose();
  }

  return (
    <Modal title={editing ? 'Edit campaign' : 'New campaign'} onClose={onClose} wide>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
        <div style={{ marginBottom:14 }}>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>Mailing list *</label>
          <select value={form.list_id} onChange={e=>set('list_id',e.target.value)}
            style={{ width:'100%', padding:'8px 12px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:CARD }}>
            <option value="">— select list —</option>
            {lists.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <Input label="Campaign title *" value={form.title} onChange={v=>set('title',v)} placeholder="May outreach wave 1" required />
        <Input label="Email subject *" value={form.subject} onChange={v=>set('subject',v)} placeholder="Is waiting costing your business?" required />
        <Input label="From name" value={form.from_name} onChange={v=>set('from_name',v)} placeholder="Wez at Sweetbyte" />
        <Input label="From email *" value={form.from_email} onChange={v=>set('from_email',v)} placeholder={`hello@${emailClient.name}`} required />
        <Input label="Reply-to (leave blank to match from email)" value={form.reply_to} onChange={v=>set('reply_to',v)} placeholder={form.from_email||`hello@${emailClient.name}`} />
        <Input label="Schedule send (optional)" value={form.scheduled_at} onChange={v=>set('scheduled_at',v)} type="datetime-local" />
      </div>
      <Input label="Email body (HTML) *" value={form.html_body} onChange={v=>set('html_body',v)}
        placeholder="Paste HTML or write plain text. Unsubscribe link auto-appended." rows={10} required />
      {err && <div style={{ color:DANGER, fontSize:13, marginBottom:10 }}>{err}</div>}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving}>{saving?'Saving...':editing?'Save changes':'Create campaign'}</Btn>
      </div>
    </Modal>
  );
}

// ── List modal ─────────────────────────────────────────────────────────────────

function ListModal({ emailClient, verifiedDomains, onClose, onSaved }) {
  const [form, setForm] = useState({ name:'', from_name:'', from_email:'', reply_to:'' });
  const [saving, setSaving] = useState(false);
  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  async function save() {
    if (!form.name||!form.from_name||!form.from_email) return;
    setSaving(true);
    await fetch('/api/email/lists', { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ ...form, reply_to: form.reply_to || form.from_email, email_client_id: emailClient.id }) });
    onSaved(); onClose();
  }

  return (
    <Modal title="New mailing list" onClose={onClose}>
      <Input label="List name *" value={form.name} onChange={v=>set('name',v)} placeholder="May prospects — SME finance" required />
      <Input label="From name *" value={form.from_name} onChange={v=>set('from_name',v)} placeholder="Wez at Tower Leasing" required />
      <Input label="From email *" value={form.from_email} onChange={v=>set('from_email',v)} placeholder={`hello@${emailClient.name}`} required />
      <Input label="Reply-to (leave blank to match from email)" value={form.reply_to} onChange={v=>set('reply_to',v)} />
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving||!form.name||!form.from_name||!form.from_email}>{saving?'Creating...':'Create list'}</Btn>
      </div>
    </Modal>
  );
}

// ── Import modal ───────────────────────────────────────────────────────────────

function ImportModal({ list, onClose, onSaved }) {
  const [csv, setCsv]     = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef();

  function handleFile(e) {
    const f = e.target.files[0]; if (!f) return;
    new Promise(res => { const r=new FileReader(); r.onload=ev=>res(ev.target.result); r.readAsText(f); }).then(setCsv);
  }

  async function importNow() {
    setSaving(true);
    const r = await fetch(`/api/email/lists/${list.id}/import`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({csv}) });
    const d = await r.json();
    setResult(d); setSaving(false);
    if (d.ok) onSaved();
  }

  return (
    <Modal title={`Import — ${list.name}`} onClose={onClose}>
      <p style={{ fontSize:13, color:MUTED, marginBottom:12 }}>
        Supports Sendy exports directly — Name, Email and Status columns are mapped automatically.
        Simple format (email, name) also works.
      </p>
      <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFile} style={{ fontSize:13, marginBottom:12 }} />
      {csv && <Input label="Preview / edit" value={csv} onChange={setCsv} rows={8} />}
      {result && (
        <div style={{ padding:'8px 12px', background:result.ok?`${GREEN}15`:'#fdecea', borderRadius:7, fontSize:13, color:result.ok?DARK:DANGER, marginBottom:12 }}>
          {result.ok ? `Added ${result.added} subscribers.` : result.error}
        </div>
      )}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Close</Btn>
        {!result?.ok && <Btn variant="primary" onClick={importNow} disabled={saving||!csv.trim()}>{saving?'Importing...':'Import'}</Btn>}
      </div>
    </Modal>
  );
}

// ── Subscribers modal ──────────────────────────────────────────────────────────

function SubsModal({ list, onClose, onSaved }) {
  const [subs, setSubs]   = useState([]);
  const [filter, setFilter] = useState('subscribed');
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [name, setName]   = useState('');

  async function load() {
    setLoading(true);
    const r = await fetch(`/api/email/lists/${list.id}/subscribers?status=${filter}`);
    setSubs(await r.json()); setLoading(false);
  }
  useEffect(()=>{ load(); },[filter]);

  async function add() {
    if (!email) return;
    await fetch(`/api/email/lists/${list.id}/subscribers`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,name}) });
    setEmail(''); setName(''); load(); onSaved();
  }

  async function unsub(id) {
    await fetch(`/api/email/lists/${list.id}/subscribers/${id}`, { method:'DELETE' });
    load(); onSaved();
  }

  return (
    <Modal title={`Subscribers — ${list.name}`} onClose={onClose} wide>
      <div style={{ display:'flex', gap:6, marginBottom:14 }}>
        {['subscribed','unsubscribed','bounced','spam'].map(s=>(
          <button key={s} onClick={()=>setFilter(s)} style={{
            padding:'4px 14px', fontSize:12, border:`0.5px solid ${BORDER}`, borderRadius:20,
            background:filter===s?GREEN:'transparent', color:filter===s?'#fff':MUTED, cursor:'pointer', textTransform:'capitalize'
          }}>{s}</button>
        ))}
      </div>
      <div style={{ display:'flex', gap:8, marginBottom:14 }}>
        <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email address"
          style={{ flex:2, padding:'7px 12px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13 }} />
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Name (optional)"
          style={{ flex:1, padding:'7px 12px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13 }} />
        <Btn small variant="primary" onClick={add}>Add</Btn>
      </div>
      {loading ? <div style={{ textAlign:'center', color:MUTED, padding:24 }}>Loading...</div> : (
        <div style={{ maxHeight:280, overflowY:'auto' }}>
          {subs.length===0 ? <div style={{ textAlign:'center', color:MUTED, padding:24, fontSize:13 }}>No {filter} subscribers</div>
            : subs.map(s=>(
              <div key={s.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'7px 0', borderBottom:`0.5px solid ${BORDER}`, fontSize:13 }}>
                <div><span style={{ color:TEXT }}>{s.email}</span>{s.name&&<span style={{ color:MUTED, marginLeft:8 }}>{s.name}</span>}</div>
                {s.status==='subscribed' && <Btn small variant="danger" onClick={()=>unsub(s.id)}>Unsubscribe</Btn>}
              </div>
            ))
          }
        </div>
      )}
      <div style={{ display:'flex', justifyContent:'flex-end', marginTop:14 }}>
        <Btn onClick={onClose}>Close</Btn>
      </div>
    </Modal>
  );
}

// ── Domain health card ─────────────────────────────────────────────────────────

function DomainCard({ data }) {
  const checks = [
    { label:'SPF',   r:data.spf   },
    { label:'DKIM',  r:data.dkim  },
    { label:'DMARC', r:data.dmarc },
    { label:'MX',    r:data.mx    },
  ];
  const allPass = checks.every(c=>c.r?.status==='pass');
  return (
    <div style={{ background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:10, padding:'14px 16px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
        <div style={{ fontSize:13, fontWeight:500, color:TEXT }}>{data.domain}</div>
        <Badge label={allPass?'All pass':'Issues found'} color={allPass?GREEN:DANGER} />
      </div>
      {checks.map(({label,r})=>(
        <div key={label} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom:`0.5px solid ${BORDER}`, fontSize:12 }}>
          <span style={{ color:MUTED }}>{label}</span>
          <span style={{ color:r?.status==='pass'?GREEN:DANGER, fontWeight:500 }}>{r?.status==='pass'?'Pass':r?.status==='missing'?'Missing':'—'}</span>
        </div>
      ))}
      {data.dkim?.selector && <div style={{ fontSize:11, color:MUTED, marginTop:5 }}>Selector: {data.dkim.selector}</div>}
    </div>
  );
}

// ── Client detail panel ────────────────────────────────────────────────────────

function ClientPanel({ emailClient, verifiedDomains, onRefresh, onEditClient }) {
  const [tab, setTab]       = useState('campaigns');
  const [campaigns, setCampaigns] = useState([]);
  const [lists, setLists]   = useState([]);
  const [domains, setDomains] = useState([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modal, setModal]   = useState(null);
  const [modalData, setModalData] = useState({});
  const [sendStatus, setSendStatus] = useState(null);

  useEffect(()=>{ loadAll(); },[emailClient.id]);

  // Poll while any campaign is sending
  useEffect(()=>{
    const hasSending = campaigns.some(c=>c.status==='sending');
    if (!hasSending) return;
    const timer = setInterval(loadCampaigns, 5000);
    return ()=>clearInterval(timer);
  },[campaigns]);

  // Auto-check all domains when Domains tab opens
  useEffect(()=>{
    if (tab !== 'domains') return;
    if (verifiedDomains.length === 0) return;
    setDomainsLoading(true);
    setDomains([]);
    Promise.all(verifiedDomains.map(d=>fetch(`/api/email/domain-health/${d}`).then(r=>r.json())))
      .then(results => { setDomains(results); setDomainsLoading(false); });
  },[tab, emailClient.id]);

  async function loadAll() {
    setLoading(true);
    const [c, l] = await Promise.all([
      fetch(`/api/email/campaigns?email_client_id=${emailClient.id}`).then(r=>r.json()),
      fetch(`/api/email/lists?email_client_id=${emailClient.id}`).then(r=>r.json()),
    ]);
    setCampaigns(Array.isArray(c)?c:[]);
    setLists(Array.isArray(l)?l:[]);
    setLoading(false);
  }

  async function loadCampaigns() {
    const r = await fetch(`/api/email/campaigns?email_client_id=${emailClient.id}`);
    const d = await r.json();
    setCampaigns(Array.isArray(d)?d:[]);
  }

  async function deleteCampaign(id) {
    if (!confirm('Delete this campaign?')) return;
    await fetch(`/api/email/campaigns/${id}`, { method:'DELETE' });
    loadCampaigns(); onRefresh();
  }

  async function sendNow(id) {
    if (!confirm('Send this campaign now to all active subscribers?')) return;
    setSendStatus({ id, msg:'Starting send…', ok:null });
    const r = await fetch(`/api/email/campaigns/${id}/send`, { method:'POST' });
    const d = await r.json();
    if (d.ok) setSendStatus({ id, msg:`Sending to ${d.subscribers} subscribers — status updates automatically…`, ok:true });
    else setSendStatus({ id, msg:d.error||'Send failed', ok:false });
    loadCampaigns();
  }

  async function deleteList(id) {
    if (!confirm('Delete this list and all subscribers?')) return;
    await fetch(`/api/email/lists/${id}`, { method:'DELETE' });
    loadAll(); onRefresh();
  }

  const tabs = ['campaigns','lists','domains'];

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0 }}>
      {/* Client header */}
      <div style={{ padding:'14px 20px', borderBottom:`0.5px solid ${BORDER}`, background:CARD, display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ width:32, height:32, borderRadius:8, background:emailClient.color||GREEN, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:12, fontWeight:600, flexShrink:0 }}>
          {initials(emailClient.name)}
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:15, fontWeight:500, color:TEXT }}>{emailClient.name}</div>
          <div style={{ fontSize:12, color:MUTED }}>{emailClient.list_count||0} lists · {emailClient.subscriber_count||0} subscribers</div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {tab==='campaigns' && <Btn small variant="primary" onClick={()=>setModal('new-campaign')}>+ New campaign</Btn>}
          {tab==='lists'     && <Btn small variant="primary" onClick={()=>setModal('new-list')}>+ New list</Btn>}
          <Btn small onClick={()=>onEditClient(emailClient)}>Edit</Btn>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', borderBottom:`0.5px solid ${BORDER}`, background:CARD }}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{
            padding:'9px 18px', fontSize:13, border:'none', background:'transparent', cursor:'pointer',
            color:tab===t?GREEN:MUTED, fontWeight:tab===t?500:400,
            borderBottom:tab===t?`2px solid ${GREEN}`:'2px solid transparent',
            textTransform:'capitalize',
          }}>{t}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex:1, overflow:'auto', padding:20, background:BG }}>

        {/* Campaigns */}
        {tab==='campaigns' && (
          loading ? <div style={{ color:MUTED, textAlign:'center', padding:40 }}>Loading...</div> :
          campaigns.length===0 ? (
            <div style={{ background:CARD, border:`0.5px dashed ${BORDER}`, borderRadius:12, padding:48, textAlign:'center', color:MUTED }}>
              No campaigns yet.<br/><br/>
              <Btn variant="primary" onClick={()=>setModal('new-campaign')}>Create first campaign</Btn>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {campaigns.map(c=>(
                <div key={c.id} style={{ background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:10, padding:'14px 16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
                    <div>
                      <div style={{ fontSize:14, fontWeight:500, color:TEXT, marginBottom:2 }}>{c.title}</div>
                      <div style={{ fontSize:12, color:MUTED }}>
                        {c.list_name} · {c.from_email}
                        {c.scheduled_at && ` · Scheduled ${new Date(c.scheduled_at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`}
                        {c.sent_at && ` · Sent ${new Date(c.sent_at).toLocaleString('en-GB',{day:'numeric',month:'short'})} · ${c.sent_count} recipients`}
                      </div>
                    </div>
                    {statusBadge(c.status)}
                  </div>
                  <div style={{ fontSize:12, color:MUTED, marginBottom:8 }}>Subject: <span style={{ color:TEXT }}>{c.subject}</span></div>
                  {c.status==='sent' && (
                    <div style={{ display:'flex', gap:16, fontSize:12, color:MUTED, marginBottom:8 }}>
                      <span>Opens: <b style={{ color:TEXT }}>{c.open_count}</b></span>
                      <span>Clicks: <b style={{ color:TEXT }}>{c.click_count}</b></span>
                      <span>Bounces: <b style={{ color:TEXT }}>{c.bounce_count}</b></span>
                      <span>Unsubs: <b style={{ color:TEXT }}>{c.unsubscribe_count}</b></span>
                    </div>
                  )}
                  <div style={{ display:'flex', gap:6 }}>
                    {(c.status==='draft'||c.status==='scheduled') && <>
                      <Btn small onClick={()=>{ setModalData(c); setModal('edit-campaign'); }}>Edit</Btn>
                      <Btn small variant="primary" onClick={()=>sendNow(c.id)}>Send now</Btn>
                    </>}
                    {c.status==='sending' && <span style={{ fontSize:12, color:GREEN }}>⏳ Sending…</span>}
                    {c.status!=='sending' && <Btn small variant="danger" onClick={()=>deleteCampaign(c.id)}>Delete</Btn>}
                  </div>
                  {sendStatus?.id===c.id && (
                    <div style={{ marginTop:8, padding:'6px 10px', borderRadius:6, fontSize:12, background:sendStatus.ok===false?'#fdecea':sendStatus.ok?`${GREEN}15`:'#f5f5f3', color:sendStatus.ok===false?DANGER:sendStatus.ok?DARK:MUTED }}>
                      {sendStatus.msg}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        )}

        {/* Lists */}
        {tab==='lists' && (
          lists.length===0 ? (
            <div style={{ background:CARD, border:`0.5px dashed ${BORDER}`, borderRadius:12, padding:48, textAlign:'center', color:MUTED }}>
              No lists yet.<br/><br/>
              <Btn variant="primary" onClick={()=>setModal('new-list')}>Create first list</Btn>
            </div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              {lists.map(l=>(
                <div key={l.id} style={{ background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:10, padding:'14px 16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
                    <div style={{ fontSize:14, fontWeight:500, color:TEXT }}>{l.name}</div>
                    <span style={{ fontSize:12, color:GREEN, fontWeight:500 }}>{l.subscriber_count} subscribers</span>
                  </div>
                  <div style={{ fontSize:12, color:MUTED, marginBottom:10 }}>From: {l.from_name} &lt;{l.from_email}&gt;</div>
                  <div style={{ display:'flex', gap:6 }}>
                    <Btn small onClick={()=>{ setModalData(l); setModal('view-subs'); }}>Subscribers</Btn>
                    <Btn small onClick={()=>{ setModalData(l); setModal('import'); }}>Import CSV</Btn>
                    <Btn small variant="danger" onClick={()=>deleteList(l.id)}>Delete</Btn>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* Domains */}
        {tab==='domains' && (
          domainsLoading ? (
            <div style={{ color:MUTED, textAlign:'center', padding:40, fontSize:13 }}>Checking all domains…</div>
          ) : domains.length===0 ? (
            <div style={{ color:MUTED, textAlign:'center', padding:40, fontSize:13 }}>No verified domains found.</div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              {domains.map(d=><DomainCard key={d.domain} data={d} />)}
            </div>
          )
        )}
      </div>

      {/* Modals */}
      {modal==='new-campaign'  && <CampaignModal emailClient={emailClient} lists={lists} verifiedDomains={verifiedDomains} onClose={()=>setModal(null)} onSaved={()=>{ loadCampaigns(); onRefresh(); }} />}
      {modal==='edit-campaign' && <CampaignModal emailClient={emailClient} lists={lists} verifiedDomains={verifiedDomains} initial={modalData} onClose={()=>setModal(null)} onSaved={()=>{ loadCampaigns(); onRefresh(); }} />}
      {modal==='new-list'      && <ListModal emailClient={emailClient} verifiedDomains={verifiedDomains} onClose={()=>setModal(null)} onSaved={()=>{ loadAll(); onRefresh(); }} />}
      {modal==='import'        && <ImportModal list={modalData} onClose={()=>setModal(null)} onSaved={loadAll} />}
      {modal==='view-subs'     && <SubsModal list={modalData} onClose={()=>setModal(null)} onSaved={loadAll} />}
    </div>
  );
}

// ── Main EmailSection ──────────────────────────────────────────────────────────

export default function EmailSection() {
  const [clients, setClients]   = useState([]);
  const [selected, setSelected] = useState(null);
  const [search, setSearch]     = useState('');
  const [loading, setLoading]   = useState(true);
  const [modal, setModal]       = useState(null);
  const [modalData, setModalData] = useState({});
  const [verifiedDomains, setVerifiedDomains] = useState([]);

  useEffect(()=>{ loadAll(); },[]);

  async function loadAll() {
    setLoading(true);
    // 1. Fetch verified domains from AWS and existing clients in parallel
    const [vd, c] = await Promise.all([
      fetch('/api/email/verified-domains').then(r=>r.json()),
      fetch('/api/email/clients').then(r=>r.json()),
    ]);
    const domains = Array.isArray(vd) ? vd : [];
    let currentClients = Array.isArray(c) ? c : [];
    setVerifiedDomains(domains);

    // 2. Auto-create a client for any domain not already in the list
    const existingNames = currentClients.map(cl => cl.name.toLowerCase());
    const toCreate = domains.filter(d => !existingNames.includes(d.toLowerCase()));
    if (toCreate.length > 0) {
      await Promise.all(toCreate.map(domain =>
        fetch('/api/email/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: domain, color: '#1D9E75' }),
        })
      ));
      // Reload clients after auto-creation
      const refreshed = await fetch('/api/email/clients').then(r=>r.json());
      currentClients = Array.isArray(refreshed) ? refreshed : [];
    }

    setClients(currentClients);
    setLoading(false);
  }

  const filtered = clients.filter(c=>c.name.toLowerCase().includes(search.toLowerCase()));
  const selectedClient = clients.find(c=>c.id===selected);

  return (
    <div style={{ flex:1, display:'flex', height:'100vh', overflow:'hidden' }}>

      {/* ── Left panel — client list ── */}
      <div style={{ width:240, background:CARD, borderRight:`0.5px solid ${BORDER}`, display:'flex', flexDirection:'column', flexShrink:0 }}>

        <div style={{ padding:'14px 12px', borderBottom:`0.5px solid ${BORDER}` }}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search clients..."
            style={{ width:'100%', padding:'7px 10px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:BG, outline:'none', boxSizing:'border-box' }} />
        </div>

        <div style={{ flex:1, overflowY:'auto' }}>
          {loading ? (
            <div style={{ color:MUTED, textAlign:'center', padding:32, fontSize:13 }}>Loading...</div>
          ) : filtered.length===0 ? (
            <div style={{ color:MUTED, textAlign:'center', padding:32, fontSize:13 }}>
              {search ? 'No clients match' : 'No clients yet'}
            </div>
          ) : filtered.map(c=>(
            <div key={c.id} onClick={()=>setSelected(c.id)} style={{
              display:'flex', alignItems:'center', gap:10, padding:'10px 12px',
              cursor:'pointer', borderBottom:`0.5px solid ${BORDER}`,
              background:selected===c.id?`${GREEN}12`:CARD,
              borderLeft:selected===c.id?`3px solid ${GREEN}`:'3px solid transparent',
            }}>
              <div style={{ width:30, height:30, borderRadius:7, background:c.color||GREEN, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:600, flexShrink:0 }}>
                {initials(c.name)}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:selected===c.id?500:400, color:TEXT, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{c.name}</div>
                <div style={{ fontSize:11, color:MUTED }}>{c.list_count||0} lists · {c.subscriber_count||0} subs</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding:'12px', borderTop:`0.5px solid ${BORDER}` }}>
          <Btn variant="primary" style={{ width:'100%', justifyContent:'center' }} onClick={()=>setModal('new-client')}>
            + New client
          </Btn>
        </div>
      </div>

      {/* ── Right panel ── */}
      {selectedClient ? (
        <ClientPanel
          key={selectedClient.id}
          emailClient={selectedClient}
          verifiedDomains={verifiedDomains}
          onRefresh={loadAll}
          onEditClient={c=>{ setModalData(c); setModal('edit-client'); }}
        />
      ) : (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:BG, flexDirection:'column', gap:12 }}>
          <div style={{ fontSize:14, color:MUTED }}>Select a client to get started</div>
          {clients.length===0 && !loading && (
            <Btn variant="primary" onClick={()=>setModal('new-client')}>Add your first email client</Btn>
          )}
        </div>
      )}

      {/* Modals */}
      {modal==='new-client'  && <ClientModal onClose={()=>setModal(null)} onSaved={loadAll} />}
      {modal==='edit-client' && <ClientModal initial={modalData} onClose={()=>setModal(null)} onSaved={loadAll} />}
    </div>
  );
}
