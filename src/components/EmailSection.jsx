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
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
}

// ── Shared UI ─────────────────────────────────────────────────────────────────

function Btn({ children, onClick, variant='default', small, disabled, style={} }) {
  const v = {
    default: { background:'#f0f0ed', color:TEXT },
    primary: { background:GREEN, color:'#fff' },
    danger:  { background:'#fdecea', color:DANGER },
    ghost:   { background:'transparent', color:MUTED, border:`0.5px solid ${BORDER}` },
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

// ── Modal wrapper ─────────────────────────────────────────────────────────────

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

// ── Brand modal ───────────────────────────────────────────────────────────────

function BrandModal({ clients, initial, verifiedDomains, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [form, setForm] = useState({
    client_id:  initial?.client_id  || '',
    name:       initial?.name       || '',
    from_name:  initial?.from_name  || '',
    from_email: initial?.from_email || '',
    reply_to:   initial?.reply_to   || '',
    color:      initial?.color      || '#1D9E75',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  async function save() {
    if (!form.client_id||!form.name||!form.from_name||!form.from_email) { setErr('Fill all required fields'); return; }
    setSaving(true); setErr('');
    const url    = editing ? `/api/email/brands/${initial.id}` : '/api/email/brands';
    const method = editing ? 'PUT' : 'POST';
    const r = await fetch(url,{ method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) });
    const d = await r.json();
    if (d.error) { setErr(d.error); setSaving(false); return; }
    onSaved(); onClose();
  }

  return (
    <Modal title={editing?'Edit brand':'New brand'} onClose={onClose}>
      <SelInput label="Client *" value={form.client_id} onChange={v=>set('client_id',v)}
        options={clients.map(c=>({value:c.id,label:c.name}))} required />
      <Input label="Brand name *" value={form.name} onChange={v=>set('name',v)} placeholder="Tower Leasing" required />
      <Input label="From name *" value={form.from_name} onChange={v=>set('from_name',v)} placeholder="Tower Leasing" required />
      <div style={{ marginBottom:14 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>From email *</label>
        <select value={form.from_email} onChange={e=>set('from_email',e.target.value)}
          style={{ width:'100%', padding:'8px 12px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:CARD }}>
          <option value="">— select verified domain —</option>
          {verifiedDomains.map(d=>[
            <option key={`hello@${d}`} value={`hello@${d}`}>hello@{d}</option>,
            <option key={`noreply@${d}`} value={`noreply@${d}`}>noreply@{d}</option>,
            <option key={`contact@${d}`} value={`contact@${d}`}>contact@{d}</option>,
          ])}
        </select>
      </div>
      <Input label="Reply-to (leave blank to use from email)" value={form.reply_to} onChange={v=>set('reply_to',v)} />
      <div style={{ marginBottom:14 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>Brand colour</label>
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

// ── Campaign modal ────────────────────────────────────────────────────────────

function CampaignModal({ brand, lists, verifiedDomains, initial, onClose, onSaved }) {
  const editing = !!initial?.id;
  const brandLists = lists.filter(l=>l.client_id===brand.client_id);
  const [form, setForm] = useState({
    client_id:    brand.client_id,
    list_id:      initial?.list_id      || '',
    title:        initial?.title        || '',
    subject:      initial?.subject      || '',
    from_name:    initial?.from_name    || brand.from_name,
    from_email:   initial?.from_email   || brand.from_email,
    reply_to:     initial?.reply_to     || brand.reply_to,
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
    const r = await fetch(url,{ method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(form) });
    const d = await r.json();
    if (d.error) { setErr(d.error); setSaving(false); return; }
    onSaved(); onClose();
  }

  return (
    <Modal title={editing?'Edit campaign':'New campaign'} onClose={onClose} wide>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
        <SelInput label="Mailing list *" value={form.list_id} onChange={v=>set('list_id',v)}
          options={brandLists.map(l=>({value:l.id,label:l.name}))} required />
        <Input label="Campaign title *" value={form.title} onChange={v=>set('title',v)} placeholder="May outreach wave 1" required />
        <Input label="Email subject *" value={form.subject} onChange={v=>set('subject',v)} placeholder="Is waiting costing your business?" required />
        <Input label="From name" value={form.from_name} onChange={v=>set('from_name',v)} />
        <div style={{ marginBottom:14 }}>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>From email</label>
          <select value={form.from_email} onChange={e=>set('from_email',e.target.value)}
            style={{ width:'100%', padding:'8px 12px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:CARD }}>
            <option value="">— select —</option>
            {/* Always show brand's saved email first */}
            {brand.from_email && <option value={brand.from_email}>{brand.from_email} (brand default)</option>}
            {verifiedDomains.map(d=>[
              brand.from_email!==`hello@${d}`    && <option key={`hello@${d}`}    value={`hello@${d}`}>hello@{d}</option>,
              brand.from_email!==`noreply@${d}`  && <option key={`noreply@${d}`}  value={`noreply@${d}`}>noreply@{d}</option>,
              brand.from_email!==`contact@${d}`  && <option key={`contact@${d}`}  value={`contact@${d}`}>contact@{d}</option>,
            ])}
          </select>
        </div>
        <Input label="Reply-to" value={form.reply_to} onChange={v=>set('reply_to',v)} />
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

// ── List modal ────────────────────────────────────────────────────────────────

function ListModal({ brand, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    await fetch('/api/email/lists',{ method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ client_id:brand.client_id, name, from_name:brand.from_name, from_email:brand.from_email, reply_to:brand.reply_to }) });
    onSaved(); onClose();
  }

  return (
    <Modal title="New mailing list" onClose={onClose}>
      <Input label="List name *" value={name} onChange={setName} placeholder="May prospects — SME finance" required />
      <div style={{ fontSize:12, color:MUTED, marginBottom:16 }}>
        From email: <b>{brand.from_email}</b> · Reply-to: <b>{brand.reply_to}</b><br/>
        Inherited from brand settings. Change in brand settings if needed.
      </div>
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving||!name.trim()}>{saving?'Creating...':'Create list'}</Btn>
      </div>
    </Modal>
  );
}

// ── Import modal ──────────────────────────────────────────────────────────────

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
    const r = await fetch(`/api/email/lists/${list.id}/import`,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({csv}) });
    const d = await r.json();
    setResult(d); setSaving(false);
    if (d.ok) onSaved();
  }

  return (
    <Modal title={`Import — ${list.name}`} onClose={onClose}>
      <p style={{ fontSize:13, color:MUTED, marginBottom:12 }}>CSV format: <code>email, name</code> (name optional). Header row optional.</p>
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

// ── Subscribers modal ─────────────────────────────────────────────────────────

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
    await fetch(`/api/email/lists/${list.id}/subscribers`,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,name}) });
    setEmail(''); setName(''); load(); onSaved();
  }

  async function unsub(id) {
    await fetch(`/api/email/lists/${list.id}/subscribers/${id}`,{ method:'DELETE' });
    load(); onSaved();
  }

  return (
    <Modal title={`Subscribers — ${list.name}`} onClose={onClose} wide>
      <div style={{ display:'flex', gap:6, marginBottom:14 }}>
        {['subscribed','unsubscribed','bounced'].map(s=>(
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

// ── Domain health card ────────────────────────────────────────────────────────

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

// ── Brand detail panel ────────────────────────────────────────────────────────

function BrandPanel({ brand, lists, verifiedDomains, clients, onRefresh, onEditBrand }) {
  const [tab, setTab]   = useState('campaigns');
  const [campaigns, setCampaigns] = useState([]);
  const [domains, setDomains]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [modal, setModal]         = useState(null);
  const [modalData, setModalData] = useState({});

  const brandLists = lists.filter(l=>l.client_id===brand.client_id);

  useEffect(()=>{
    loadCampaigns();
  },[brand.id]);

  // Poll every 5s while any campaign is in 'sending' state
  useEffect(()=>{
    const hasSending = campaigns.some(c=>c.status==='sending');
    if (!hasSending) return;
    const timer = setInterval(loadCampaigns, 5000);
    return ()=>clearInterval(timer);
  },[campaigns]);

  async function loadCampaigns() {
    setLoading(true);
    const r = await fetch(`/api/email/campaigns?client_id=${brand.client_id}`);
    const d = await r.json();
    setCampaigns(Array.isArray(d)?d:[]);
    setLoading(false);
  }

  async function deleteCampaign(id) {
    if (!confirm('Delete this campaign?')) return;
    await fetch(`/api/email/campaigns/${id}`,{ method:'DELETE' });
    const r = await fetch(`/api/email/campaigns?client_id=${brand.client_id}`);
    const d = await r.json(); setCampaigns(Array.isArray(d)?d:[]);
    onRefresh();
  }

  const [sendStatus, setSendStatus] = useState(null); // { id, msg, ok }

  async function sendNow(id) {
    if (!confirm('Send this campaign now to all active subscribers?')) return;
    setSendStatus({ id, msg: 'Starting send…', ok: null });
    const r = await fetch(`/api/email/campaigns/${id}/send`,{ method:'POST' });
    const d = await r.json();
    if (d.ok) {
      setSendStatus({ id, msg: `Sending to ${d.subscribers} subscribers — status updates automatically…`, ok: true });
    } else {
      setSendStatus({ id, msg: d.error||'Send failed', ok: false });
    }
    loadCampaigns();
  }

  async function deleteList(id) {
    if (!confirm('Delete this list and all subscribers?')) return;
    await fetch(`/api/email/lists/${id}`,{ method:'DELETE' });
    onRefresh();
  }

  const [domainsLoading, setDomainsLoading] = useState(false);

  // Auto-check all verified domains when the Domains tab is opened
  useEffect(()=>{
    if (tab !== 'domains') return;
    if (verifiedDomains.length === 0) return;
    setDomainsLoading(true);
    setDomains([]);
    Promise.all(
      verifiedDomains.map(d =>
        fetch(`/api/email/domain-health/${d}`).then(r=>r.json())
      )
    ).then(results => {
      setDomains(results);
      setDomainsLoading(false);
    });
  },[tab, brand.id]);

  const tabs = ['campaigns','lists','domains','settings'];

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0 }}>
      {/* Brand header */}
      <div style={{ padding:'14px 20px', borderBottom:`0.5px solid ${BORDER}`, background:CARD, display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ width:32, height:32, borderRadius:8, background:brand.color||GREEN, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:12, fontWeight:600, flexShrink:0 }}>
          {initials(brand.name)}
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:15, fontWeight:500, color:TEXT }}>{brand.name}</div>
          <div style={{ fontSize:12, color:MUTED }}>{brand.from_email}</div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {tab==='campaigns' && <Btn small variant="primary" onClick={()=>setModal('new-campaign')}>+ New campaign</Btn>}
          {tab==='lists'     && <Btn small variant="primary" onClick={()=>setModal('new-list')}>+ New list</Btn>}
          <Btn small onClick={()=>onEditBrand(brand)}>Edit brand</Btn>
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
          brandLists.length===0 ? (
            <div style={{ background:CARD, border:`0.5px dashed ${BORDER}`, borderRadius:12, padding:48, textAlign:'center', color:MUTED }}>
              No lists yet.<br/><br/>
              <Btn variant="primary" onClick={()=>setModal('new-list')}>Create first list</Btn>
            </div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              {brandLists.map(l=>(
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
          <div>
            {domainsLoading ? (
              <div style={{ color:MUTED, textAlign:'center', padding:40, fontSize:13 }}>Checking all domains…</div>
            ) : domains.length===0 ? (
              <div style={{ color:MUTED, textAlign:'center', padding:40, fontSize:13 }}>No verified domains found.</div>
            ) : (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                {domains.map(d=><DomainCard key={d.domain} data={d} />)}
              </div>
            )}
          </div>
        )}

        {/* Settings */}
        {tab==='settings' && (
          <div style={{ maxWidth:480 }}>
            <div style={{ background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:10, padding:'16px 18px' }}>
              <div style={{ fontSize:13, fontWeight:500, color:TEXT, marginBottom:14 }}>Brand settings</div>
              {[
                { label:'Brand name',  value:brand.name },
                { label:'From name',   value:brand.from_name },
                { label:'From email',  value:brand.from_email },
                { label:'Reply-to',    value:brand.reply_to },
              ].map(({label,value})=>(
                <div key={label} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:`0.5px solid ${BORDER}`, fontSize:13 }}>
                  <span style={{ color:MUTED }}>{label}</span>
                  <span style={{ color:TEXT }}>{value}</span>
                </div>
              ))}
              <div style={{ marginTop:14 }}>
                <Btn variant="primary" onClick={()=>onEditBrand(brand)}>Edit brand settings</Btn>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {modal==='new-campaign'  && <CampaignModal brand={brand} lists={lists} verifiedDomains={verifiedDomains} onClose={()=>setModal(null)} onSaved={()=>{ const go=async()=>{ const r=await fetch(`/api/email/campaigns?client_id=${brand.client_id}`); const d=await r.json(); setCampaigns(Array.isArray(d)?d:[]); onRefresh(); }; go(); }} />}
      {modal==='edit-campaign' && <CampaignModal brand={brand} lists={lists} verifiedDomains={verifiedDomains} initial={modalData} onClose={()=>setModal(null)} onSaved={()=>{ const go=async()=>{ const r=await fetch(`/api/email/campaigns?client_id=${brand.client_id}`); const d=await r.json(); setCampaigns(Array.isArray(d)?d:[]); onRefresh(); }; go(); }} />}
      {modal==='new-list'      && <ListModal brand={brand} onClose={()=>setModal(null)} onSaved={onRefresh} />}
      {modal==='import'        && <ImportModal list={modalData} onClose={()=>setModal(null)} onSaved={onRefresh} />}
      {modal==='view-subs'     && <SubsModal list={modalData} onClose={()=>setModal(null)} onSaved={onRefresh} />}
    </div>
  );
}

// ── Main EmailSection ─────────────────────────────────────────────────────────

export default function EmailSection({ clients }) {
  const [brands, setBrands]   = useState([]);
  const [lists, setLists]     = useState([]);
  const [selected, setSelected] = useState(null);
  const [search, setSearch]   = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(null);
  const [modalData, setModalData] = useState({});
  const [verifiedDomains, setVerifiedDomains] = useState([]);

  useEffect(()=>{ loadAll(); },[]);

  async function loadAll() {
    setLoading(true);
    const [b,l,vd] = await Promise.all([
      fetch('/api/email/brands').then(r=>r.json()),
      fetch('/api/email/lists').then(r=>r.json()),
      fetch('/api/email/verified-domains').then(r=>r.json()),
    ]);
    setBrands(Array.isArray(b)?b:[]);
    setLists(Array.isArray(l)?l:[]);
    setVerifiedDomains(Array.isArray(vd)?vd:[]);
    setLoading(false);
  }

  const filtered = brands.filter(b=>b.name.toLowerCase().includes(search.toLowerCase())||b.from_email.toLowerCase().includes(search.toLowerCase()));

  const selectedBrand = brands.find(b=>b.id===selected);

  return (
    <div style={{ flex:1, display:'flex', height:'100vh', overflow:'hidden' }}>

      {/* ── Left panel — brand list ── */}
      <div style={{ width:240, background:CARD, borderRight:`0.5px solid ${BORDER}`, display:'flex', flexDirection:'column', flexShrink:0 }}>

        {/* Search */}
        <div style={{ padding:'14px 12px', borderBottom:`0.5px solid ${BORDER}` }}>
          <input
            value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search brands..."
            style={{ width:'100%', padding:'7px 10px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:BG, outline:'none', boxSizing:'border-box' }}
          />
        </div>

        {/* Brand list */}
        <div style={{ flex:1, overflowY:'auto' }}>
          {loading ? (
            <div style={{ color:MUTED, textAlign:'center', padding:32, fontSize:13 }}>Loading...</div>
          ) : filtered.length===0 ? (
            <div style={{ color:MUTED, textAlign:'center', padding:32, fontSize:13 }}>
              {search ? 'No brands match' : 'No brands yet'}
            </div>
          ) : filtered.map(b=>(
            <div key={b.id} onClick={()=>setSelected(b.id)} style={{
              display:'flex', alignItems:'center', gap:10, padding:'10px 12px',
              cursor:'pointer', borderBottom:`0.5px solid ${BORDER}`,
              background:selected===b.id?`${GREEN}12`:CARD,
              borderLeft:selected===b.id?`3px solid ${GREEN}`:'3px solid transparent',
            }}>
              <div style={{ width:30, height:30, borderRadius:7, background:b.color||GREEN, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:600, flexShrink:0 }}>
                {initials(b.name)}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:selected===b.id?500:400, color:TEXT, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{b.name}</div>
                <div style={{ fontSize:11, color:MUTED }}>{b.list_count||0} lists · {b.subscriber_count||0} subs</div>
              </div>
              {b.last_campaign_status==='scheduled' && <Badge label="live" color="#c27a00" bg="#fff3cd" />}
            </div>
          ))}
        </div>

        {/* Add brand button */}
        <div style={{ padding:'12px', borderTop:`0.5px solid ${BORDER}` }}>
          <Btn variant="primary" style={{ width:'100%', justifyContent:'center' }} onClick={()=>setModal('new-brand')}>
            + New brand
          </Btn>
        </div>
      </div>

      {/* ── Right panel ── */}
      {selectedBrand ? (
        <BrandPanel
          key={selectedBrand.id}
          brand={selectedBrand}
          lists={lists}
          verifiedDomains={verifiedDomains}
          clients={clients}
          onRefresh={loadAll}
          onEditBrand={b=>{ setModalData(b); setModal('edit-brand'); }}
        />
      ) : (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:BG, flexDirection:'column', gap:12 }}>
          <div style={{ fontSize:14, color:MUTED }}>Select a brand to get started</div>
          {brands.length===0 && !loading && (
            <Btn variant="primary" onClick={()=>setModal('new-brand')}>Create your first brand</Btn>
          )}
        </div>
      )}

      {/* Modals */}
      {modal==='new-brand'  && <BrandModal clients={clients} verifiedDomains={verifiedDomains} onClose={()=>setModal(null)} onSaved={loadAll} />}
      {modal==='edit-brand' && <BrandModal clients={clients} verifiedDomains={verifiedDomains} initial={modalData} onClose={()=>setModal(null)} onSaved={loadAll} />}
    </div>
  );
}
