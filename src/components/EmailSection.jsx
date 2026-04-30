import React, { useState, useEffect, useRef } from 'react';

const GREEN  = '#1D9E75';
const DARK   = '#0F6E56';
const BG     = '#f5f5f3';
const CARD   = '#fff';
const BORDER = '#e0e0dc';
const TEXT   = '#1a1a1a';
const MUTED  = '#888';
const DANGER = '#c0392b';
const AMBER  = '#854F0B';
const BRAND_COLORS = ['#1D9E75','#0F6E56','#534AB7','#185FA5','#993C1D','#854F0B','#3B6D11','#D4537E','#5F5E5A'];

function initials(n='') { return n.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)||'?'; }

// ── Shared UI ─────────────────────────────────────────────────────────────────

function Btn({ children, onClick, variant='default', small, disabled, style={} }) {
  const v = { default:{background:'#f0f0ed',color:TEXT}, primary:{background:GREEN,color:'#fff'}, danger:{background:'#fdecea',color:DANGER} };
  return <button onClick={onClick} disabled={disabled} style={{ border:'none', borderRadius:7, cursor:disabled?'not-allowed':'pointer', fontWeight:500, fontSize:small?11:13, padding:small?'4px 10px':'8px 18px', opacity:disabled?0.5:1, ...v[variant], ...style }}>{children}</button>;
}

function Input({ label, value, onChange, placeholder, type='text', required, rows, style={} }) {
  const base = { width:'100%', padding:'8px 12px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:CARD, outline:'none', boxSizing:'border-box', ...style };
  return (
    <div style={{ marginBottom:14 }}>
      {label && <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{label}{required&&' *'}</label>}
      {rows ? <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{ ...base, fontFamily:'monospace', resize:'vertical' }} />
             : <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={base} />}
    </div>
  );
}

function Badge({ label, color=GREEN, bg }) {
  return <span style={{ fontSize:11, padding:'2px 8px', borderRadius:20, fontWeight:500, background:bg||`${color}18`, color, whiteSpace:'nowrap' }}>{label}</span>;
}

function statusBadge(s) {
  const m = { draft:{l:'Draft',c:MUTED,b:'#f0f0ed'}, scheduled:{l:'Scheduled',c:AMBER,b:'#fff3cd'}, sending:{l:'Sending…',c:GREEN,b:`${GREEN}15`}, sent:{l:'Sent',c:GREEN,b:`${GREEN}15`}, failed:{l:'Failed',c:DANGER,b:'#fdecea'} };
  const x = m[s]||{l:s,c:MUTED,b:'#f0f0ed'};
  return <Badge label={x.l} color={x.c} bg={x.b} />;
}

function subBadge(s) {
  if (s==='subscribed')   return <Badge label="Subscribed"   color={GREEN}  bg={`${GREEN}18`} />;
  if (s==='bounced')      return <Badge label="Bounced"      color={DANGER} bg="#fdecea" />;
  if (s==='unsubscribed') return <Badge label="Unsubscribed" color={AMBER}  bg="#fff3cd" />;
  if (s==='spam')         return <Badge label="Spam"         color={DANGER} bg="#fdecea" />;
  return <Badge label={s} color={MUTED} />;
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

// ── TH / TD helpers ───────────────────────────────────────────────────────────

const TH = ({ children, w }) => <th style={{ textAlign:'left', padding:'8px 14px', fontSize:11, fontWeight:500, color:MUTED, background:BG, borderBottom:`0.5px solid ${BORDER}`, whiteSpace:'nowrap', width:w }}>{children}</th>;
const TD = ({ children, muted, center }) => <td style={{ padding:'9px 14px', fontSize:12, color:muted?MUTED:TEXT, textAlign:center?'center':'left', borderBottom:`0.5px solid ${BORDER}`, verticalAlign:'middle' }}>{children}</td>;

// ── Email Client modal ────────────────────────────────────────────────────────

function ClientModal({ initial, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [name, setName] = useState(initial?.name||'');
  const [color, setColor] = useState(initial?.color||'#1D9E75');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    if (!name.trim()) { setErr('Name required'); return; }
    setSaving(true);
    const r = await fetch(editing?`/api/email/clients/${initial.id}`:'/api/email/clients', { method:editing?'PUT':'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name,color}) });
    const d = await r.json();
    if (d.error) { setErr(d.error); setSaving(false); return; }
    onSaved(); onClose();
  }
  return (
    <Modal title={editing?'Edit client':'New client'} onClose={onClose}>
      <Input label="Client name *" value={name} onChange={setName} placeholder="e.g. Tower Leasing" required />
      <div style={{ marginBottom:14 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>Colour</label>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {BRAND_COLORS.map(c=><div key={c} onClick={()=>setColor(c)} style={{ width:24, height:24, borderRadius:6, background:c, cursor:'pointer', border:color===c?`2px solid ${TEXT}`:'2px solid transparent' }} />)}
        </div>
      </div>
      {err && <div style={{ color:DANGER, fontSize:13, marginBottom:10 }}>{err}</div>}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving}>{saving?'Saving…':editing?'Save changes':'Create client'}</Btn>
      </div>
    </Modal>
  );
}

// ── List modal ────────────────────────────────────────────────────────────────

function ListModal({ emailClient, onClose, onSaved }) {
  const [form, setForm] = useState({ name:'', from_name:'', from_email:'', reply_to:'' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k,v) => setForm(f=>({...f,[k]:v}));
  async function save() {
    if (!form.name||!form.from_name||!form.from_email) { setErr('Fill all required fields'); return; }
    setSaving(true);
    const r = await fetch('/api/email/lists', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ...form, reply_to:form.reply_to||form.from_email, email_client_id:emailClient.id }) });
    const d = await r.json();
    if (d.error) { setErr(d.error); setSaving(false); return; }
    onSaved(); onClose();
  }
  return (
    <Modal title="New mailing list" onClose={onClose}>
      <Input label="List name *" value={form.name} onChange={v=>set('name',v)} placeholder="Suffolk prospects wave 1" required />
      <Input label="From name *" value={form.from_name} onChange={v=>set('from_name',v)} placeholder="Wez at Sweetbyte" required />
      <Input label="From email *" value={form.from_email} onChange={v=>set('from_email',v)} placeholder={`hello@${emailClient.name}`} required />
      <Input label="Reply-to (leave blank to match from email)" value={form.reply_to} onChange={v=>set('reply_to',v)} />
      {err && <div style={{ color:DANGER, fontSize:13, marginBottom:10 }}>{err}</div>}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving}>{saving?'Creating…':'Create list'}</Btn>
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
    new Promise(res=>{ const r=new FileReader(); r.onload=ev=>res(ev.target.result); r.readAsText(f); }).then(setCsv);
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
      <p style={{ fontSize:13, color:MUTED, marginBottom:12 }}>Supports Sendy exports directly — Name, Email and Status columns mapped automatically.</p>
      <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFile} style={{ fontSize:13, marginBottom:12 }} />
      {csv && <Input label="Preview / edit" value={csv} onChange={setCsv} rows={8} />}
      {result && <div style={{ padding:'8px 12px', background:result.ok?`${GREEN}15`:'#fdecea', borderRadius:7, fontSize:13, color:result.ok?DARK:DANGER, marginBottom:12 }}>{result.ok?`✓ Added ${result.added} subscribers.`:result.error}</div>}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Close</Btn>
        {!result?.ok && <Btn variant="primary" onClick={importNow} disabled={saving||!csv.trim()}>{saving?'Importing…':'Import'}</Btn>}
      </div>
    </Modal>
  );
}

// ── Campaign modal ────────────────────────────────────────────────────────────

function CampaignModal({ emailClient, lists, initial, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [form, setForm] = useState({
    list_id:      initial?.list_id      || (lists.length===1 ? lists[0].id : ''),
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
    const missing = [];
    if (!form.list_id)   missing.push('mailing list');
    if (!form.title)     missing.push('campaign title');
    if (!form.subject)   missing.push('email subject');
    if (!form.from_email) missing.push('from email');
    if (!form.html_body) missing.push('email body');
    if (missing.length) { setErr(`Please fill in: ${missing.join(', ')}`); return; }
    setSaving(true); setErr('');
    const r = await fetch(editing?`/api/email/campaigns/${initial.id}`:'/api/email/campaigns', { method:editing?'PUT':'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...form, email_client_id:emailClient.id}) });
    const d = await r.json();
    if (d.error) { setErr(d.error); setSaving(false); return; }
    onSaved(); onClose();
  }
  return (
    <Modal title={editing?'Edit campaign':'New campaign'} onClose={onClose} wide>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
        <div style={{ marginBottom:14 }}>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>Mailing list *</label>
          <select value={form.list_id} onChange={e=>set('list_id',e.target.value)} style={{ width:'100%', padding:'8px 12px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:CARD }}>
            <option value="">— select list —</option>
            {lists.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <Input label="Campaign title *" value={form.title} onChange={v=>set('title',v)} placeholder="May outreach wave 1" required />
        <Input label="Email subject *" value={form.subject} onChange={v=>set('subject',v)} placeholder="Is waiting costing your business?" required />
        <Input label="From name" value={form.from_name} onChange={v=>set('from_name',v)} placeholder="Wez at Sweetbyte" />
        <Input label="From email *" value={form.from_email} onChange={v=>set('from_email',v)} placeholder={`hello@${emailClient.name}`} required />
        <Input label="Reply-to (leave blank to match from email)" value={form.reply_to} onChange={v=>set('reply_to',v)} />
        <Input label="Schedule send (optional)" value={form.scheduled_at} onChange={v=>set('scheduled_at',v)} type="datetime-local" />
      </div>
      <Input label="Email body (HTML) *" value={form.html_body} onChange={v=>set('html_body',v)} placeholder="Paste HTML or write plain text. Unsubscribe link auto-appended." rows={10} required />
      {err && <div style={{ color:DANGER, fontSize:13, marginBottom:10 }}>{err}</div>}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving}>{saving?'Saving…':editing?'Save changes':'Create campaign'}</Btn>
      </div>
    </Modal>
  );
}

// ── Domain health card ────────────────────────────────────────────────────────

function DomainCard({ data }) {
  const checks = [{ label:'SPF', r:data.spf }, { label:'DKIM', r:data.dkim }, { label:'DMARC', r:data.dmarc }, { label:'MX', r:data.mx }];
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
          <span style={{ color:r?.status==='pass'?GREEN:DANGER, fontWeight:500 }}>{r?.status==='pass'?'Pass':'Missing'}</span>
        </div>
      ))}
      {data.dkim?.selector && <div style={{ fontSize:11, color:MUTED, marginTop:5 }}>Selector: {data.dkim.selector}</div>}
    </div>
  );
}

// ── Subscriber detail view ────────────────────────────────────────────────────

function SubscriberView({ list, emailClient, onBack, onRefresh }) {
  const [subs, setSubs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState('all');
  const [search, setSearch]   = useState('');
  const [page, setPage]       = useState(1);
  const [modal, setModal]     = useState(null);
  const PER_PAGE = 50;

  useEffect(()=>{ load(); },[]);

  async function load() {
    setLoading(true);
    const r = await fetch(`/api/email/lists/${list.id}/subscribers`);
    setSubs(await r.json()); setLoading(false);
  }

  async function unsub(id) {
    await fetch(`/api/email/lists/${list.id}/subscribers/${id}`, { method:'DELETE' });
    load(); onRefresh();
  }

  function exportCSV() {
    const rows = filtered.map(s=>`"${s.name||''}","${s.email}","${s.status}","${s.created_at||''}"`);
    const csv  = ['Name,Email,Status,Added', ...rows].join('\n');
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
    a.download = `${list.name.replace(/\s+/g,'-')}.csv`;
    a.click();
  }

  const counts = {
    all:          subs.length,
    subscribed:   subs.filter(s=>s.status==='subscribed').length,
    bounced:      subs.filter(s=>s.status==='bounced').length,
    unsubscribed: subs.filter(s=>s.status==='unsubscribed').length,
    spam:         subs.filter(s=>s.status==='spam').length,
  };

  const filtered = subs
    .filter(s => filter==='all' || s.status===filter)
    .filter(s => !search || s.email.includes(search.toLowerCase()) || (s.name||'').toLowerCase().includes(search.toLowerCase()));

  const totalPages = Math.ceil(filtered.length / PER_PAGE);
  const paginated  = filtered.slice((page-1)*PER_PAGE, page*PER_PAGE);

  const FILTERS = ['all','subscribed','bounced','unsubscribed','spam'];

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0 }}>
      {/* Header */}
      <div style={{ padding:'12px 20px', borderBottom:`0.5px solid ${BORDER}`, background:CARD, display:'flex', alignItems:'center', gap:12 }}>
        <button onClick={onBack} style={{ background:'none', border:'none', cursor:'pointer', color:MUTED, fontSize:12, padding:0, display:'flex', alignItems:'center', gap:4 }}>← Back to lists</button>
        <span style={{ color:BORDER }}>|</span>
        <span style={{ fontSize:14, fontWeight:500, color:TEXT }}>{list.name}</span>
        <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
          <Btn small onClick={()=>setModal('import')}>⬆ Import CSV</Btn>
          <Btn small onClick={exportCSV}>⬇ Export</Btn>
          <Btn small variant="primary" onClick={()=>setModal('add')}>+ Add subscriber</Btn>
        </div>
      </div>

      {/* Stats bar */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', background:CARD, borderBottom:`0.5px solid ${BORDER}` }}>
        {[
          { n:counts.subscribed,   l:'Active subscribers',  c:GREEN },
          { n:counts.bounced,      l:`Bounced · ${counts.all?((counts.bounced/counts.all)*100).toFixed(1):0}%`, c:DANGER },
          { n:counts.unsubscribed, l:`Unsubscribed · ${counts.all?((counts.unsubscribed/counts.all)*100).toFixed(1):0}%`, c:AMBER },
          { n:counts.spam,         l:'Marked as spam', c:MUTED },
        ].map((s,i)=>(
          <div key={i} style={{ padding:'12px 20px', borderRight:i<3?`0.5px solid ${BORDER}`:'none' }}>
            <div style={{ fontSize:22, fontWeight:500, color:s.c }}>{s.n.toLocaleString()}</div>
            <div style={{ fontSize:11, color:MUTED, marginTop:2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs + search */}
      <div style={{ display:'flex', alignItems:'center', gap:6, padding:'10px 20px', background:BG, borderBottom:`0.5px solid ${BORDER}` }}>
        {FILTERS.map(f=>(
          <button key={f} onClick={()=>{ setFilter(f); setPage(1); }} style={{ padding:'4px 12px', fontSize:12, border:`0.5px solid ${BORDER}`, borderRadius:20, background:filter===f?GREEN:'transparent', color:filter===f?'#fff':MUTED, cursor:'pointer', textTransform:'capitalize' }}>
            {f} ({counts[f]})
          </button>
        ))}
        <input value={search} onChange={e=>{ setSearch(e.target.value); setPage(1); }} placeholder="Search name or email…"
          style={{ marginLeft:'auto', padding:'5px 10px', border:`0.5px solid ${BORDER}`, borderRadius:6, fontSize:12, color:TEXT, background:CARD, outline:'none', width:200 }} />
      </div>

      {/* Table */}
      <div style={{ flex:1, overflow:'auto', background:BG }}>
        <table style={{ width:'100%', borderCollapse:'collapse', background:CARD }}>
          <thead>
            <tr>
              <TH>Name</TH>
              <TH>Email</TH>
              <TH>Status</TH>
              <TH>Added</TH>
              <TH>Actions</TH>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} style={{ textAlign:'center', padding:40, color:MUTED, fontSize:13 }}>Loading…</td></tr>
            ) : paginated.length===0 ? (
              <tr><td colSpan={5} style={{ textAlign:'center', padding:40, color:MUTED, fontSize:13 }}>No subscribers found</td></tr>
            ) : paginated.map(s=>(
              <tr key={s.id}>
                <TD>{s.name||<span style={{ color:MUTED }}>—</span>}</TD>
                <TD muted>{s.email}</TD>
                <TD>{subBadge(s.status)}</TD>
                <TD muted>{s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—'}</TD>
                <TD>
                  {s.status==='subscribed' && (
                    <button onClick={()=>{ if(confirm(`Unsubscribe ${s.email}?`)) unsub(s.id); }} style={{ background:'none', border:'none', color:DANGER, fontSize:11, cursor:'pointer', padding:0 }}>Unsubscribe</button>
                  )}
                  {(s.status==='bounced'||s.status==='spam') && (
                    <button onClick={()=>{ if(confirm(`Remove ${s.email}?`)) unsub(s.id); }} style={{ background:'none', border:'none', color:DANGER, fontSize:11, cursor:'pointer', padding:0 }}>Remove</button>
                  )}
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 20px', background:CARD, borderTop:`0.5px solid ${BORDER}`, fontSize:12, color:MUTED }}>
          <span>Showing {((page-1)*PER_PAGE)+1}–{Math.min(page*PER_PAGE, filtered.length)} of {filtered.length.toLocaleString()}</span>
          <div style={{ display:'flex', gap:4 }}>
            <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1} style={{ padding:'3px 9px', borderRadius:5, border:`0.5px solid ${BORDER}`, background:'transparent', fontSize:12, cursor:'pointer', color:MUTED }}>←</button>
            {Array.from({length:Math.min(5,totalPages)},(_,i)=>{ const p=Math.max(1,Math.min(page-2,totalPages-4))+i; return (
              <button key={p} onClick={()=>setPage(p)} style={{ padding:'3px 9px', borderRadius:5, border:`0.5px solid ${BORDER}`, background:page===p?GREEN:'transparent', color:page===p?'#fff':MUTED, fontSize:12, cursor:'pointer' }}>{p}</button>
            ); })}
            <button onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages} style={{ padding:'3px 9px', borderRadius:5, border:`0.5px solid ${BORDER}`, background:'transparent', fontSize:12, cursor:'pointer', color:MUTED }}>→</button>
          </div>
        </div>
      )}

      {/* Modals */}
      {modal==='import' && <ImportModal list={list} onClose={()=>setModal(null)} onSaved={()=>{ load(); onRefresh(); }} />}
      {modal==='add' && (
        <Modal title="Add subscriber" onClose={()=>setModal(null)}>
          <AddSubForm listId={list.id} onSaved={()=>{ load(); onRefresh(); setModal(null); }} onClose={()=>setModal(null)} />
        </Modal>
      )}
    </div>
  );
}

function AddSubForm({ listId, onSaved, onClose }) {
  const [email, setEmail] = useState('');
  const [name, setName]   = useState('');
  const [err, setErr]     = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!email) { setErr('Email required'); return; }
    setSaving(true);
    const r = await fetch(`/api/email/lists/${listId}/subscribers`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,name}) });
    const d = await r.json();
    if (d.error) { setErr(d.error); setSaving(false); return; }
    onSaved();
  }
  return (
    <>
      <Input label="Email *" value={email} onChange={setEmail} placeholder="john@example.com" required />
      <Input label="Name" value={name} onChange={setName} placeholder="John Smith" />
      {err && <div style={{ color:DANGER, fontSize:13, marginBottom:10 }}>{err}</div>}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={save} disabled={saving}>{saving?'Adding…':'Add subscriber'}</Btn>
      </div>
    </>
  );
}

// ── Lists table view ──────────────────────────────────────────────────────────

function ListsTable({ emailClient, lists, onNewList, onImport, onView, onDelete, onRefresh }) {
  function exportList(list) {
    fetch(`/api/email/lists/${list.id}/subscribers`)
      .then(r=>r.json())
      .then(subs=>{
        const rows = subs.map(s=>`"${s.name||''}","${s.email}","${s.status}","${s.created_at||''}"`);
        const csv  = ['Name,Email,Status,Added', ...rows].join('\n');
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
        a.download = `${list.name.replace(/\s+/g,'-')}.csv`;
        a.click();
      });
  }

  if (lists.length === 0) return (
    <div style={{ background:CARD, border:`0.5px dashed ${BORDER}`, borderRadius:12, padding:48, textAlign:'center', color:MUTED }}>
      No lists yet.<br/><br/>
      <Btn variant="primary" onClick={onNewList}>Create first list</Btn>
    </div>
  );

  return (
    <div style={{ background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:10, overflow:'hidden' }}>
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <thead>
          <tr>
            <TH>List name</TH>
            <TH>Active</TH>
            <TH>Unsubscribed</TH>
            <TH>Bounced</TH>
            <TH>Spam</TH>
            <TH>Actions</TH>
          </tr>
        </thead>
        <tbody>
          {lists.map(l=>(
            <tr key={l.id} style={{ cursor:'default' }}>
              <TD><span style={{ fontWeight:500, color:TEXT }}>{l.name}</span></TD>
              <TD><Badge label={l.subscriber_count?.toLocaleString()||'0'} color={GREEN} bg={`${GREEN}18`} /></TD>
              <TD><Badge label={l.unsubscribed_count?.toLocaleString()||'0'} color={l.unsubscribed_count>0?AMBER:MUTED} bg={l.unsubscribed_count>0?'#fff3cd':'#f0f0ed'} /></TD>
              <TD><Badge label={l.bounced_count?.toLocaleString()||'0'} color={l.bounced_count>0?DANGER:MUTED} bg={l.bounced_count>0?'#fdecea':'#f0f0ed'} /></TD>
              <TD><Badge label={l.spam_count?.toLocaleString()||'0'} color={l.spam_count>0?DANGER:MUTED} bg={l.spam_count>0?'#fdecea':'#f0f0ed'} /></TD>
              <TD>
                <div style={{ display:'flex', gap:10 }}>
                  <button onClick={()=>onView(l)} style={{ background:'none', border:'none', color:GREEN, fontSize:11, cursor:'pointer', padding:0, fontWeight:500 }}>View</button>
                  <button onClick={()=>onImport(l)} style={{ background:'none', border:'none', color:MUTED, fontSize:11, cursor:'pointer', padding:0 }}>Import</button>
                  <button onClick={()=>exportList(l)} style={{ background:'none', border:'none', color:MUTED, fontSize:11, cursor:'pointer', padding:0 }}>Export</button>
                  <button onClick={()=>{ if(confirm(`Delete list "${l.name}" and all its subscribers?`)) onDelete(l.id); }} style={{ background:'none', border:'none', color:DANGER, fontSize:11, cursor:'pointer', padding:0 }}>Delete</button>
                </div>
              </TD>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Client detail panel ───────────────────────────────────────────────────────

function ClientPanel({ emailClient, onRefresh, onEditClient }) {
  const [tab, setTab]             = useState('campaigns');
  const [campaigns, setCampaigns] = useState([]);
  const [lists, setLists]         = useState([]);
  const [domains, setDomains]     = useState([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [modal, setModal]         = useState(null);
  const [modalData, setModalData] = useState({});
  const [sendStatus, setSendStatus] = useState(null);
  const [viewingList, setViewingList] = useState(null);

  useEffect(()=>{ loadAll(); },[emailClient.id]);

  useEffect(()=>{
    const hasSending = campaigns.some(c=>c.status==='sending');
    if (!hasSending) return;
    const timer = setInterval(loadCampaigns, 5000);
    return ()=>clearInterval(timer);
  },[campaigns]);

  useEffect(()=>{
    if (tab!=='domains') return;
    setDomainsLoading(true); setDomains([]);
    fetch('/api/email/verified-domains').then(r=>r.json()).then(vd=>{
      if (!Array.isArray(vd)||vd.length===0) { setDomainsLoading(false); return; }
      Promise.all(vd.map(d=>fetch(`/api/email/domain-health/${d}`).then(r=>r.json())))
        .then(results=>{ setDomains(results); setDomainsLoading(false); });
    });
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

  async function sendNow(id) {
    if (!confirm('Send this campaign now to all active subscribers?')) return;
    setSendStatus({ id, msg:'Starting send…', ok:null });
    const r = await fetch(`/api/email/campaigns/${id}/send`, { method:'POST' });
    const d = await r.json();
    setSendStatus(d.ok ? { id, msg:`Sending to ${d.subscribers} subscribers — status updates automatically…`, ok:true } : { id, msg:d.error||'Send failed', ok:false });
    loadCampaigns();
  }

  async function deleteCampaign(id) {
    if (!confirm('Delete this campaign?')) return;
    await fetch(`/api/email/campaigns/${id}`, { method:'DELETE' });
    loadCampaigns(); onRefresh();
  }

  async function deleteList(id) {
    await fetch(`/api/email/lists/${id}`, { method:'DELETE' });
    loadAll(); onRefresh();
  }

  // If viewing a specific list's subscribers, show that view instead
  if (viewingList) {
    return <SubscriberView list={viewingList} emailClient={emailClient} onBack={()=>{ setViewingList(null); loadAll(); }} onRefresh={onRefresh} />;
  }

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0 }}>
      {/* Client header */}
      <div style={{ padding:'12px 20px', borderBottom:`0.5px solid ${BORDER}`, background:CARD, display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ width:32, height:32, borderRadius:8, background:emailClient.color||GREEN, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:12, fontWeight:600, flexShrink:0 }}>{initials(emailClient.name)}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:15, fontWeight:500, color:TEXT }}>{emailClient.name}</div>
          <div style={{ fontSize:12, color:MUTED }}>{emailClient.list_count||0} lists · {emailClient.subscriber_count||0} active subscribers</div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {tab==='campaigns' && <Btn small variant="primary" onClick={()=>setModal('new-campaign')}>+ New campaign</Btn>}
          {tab==='lists'     && <>
            <Btn small onClick={()=>setModal('new-list')}>⬆ Import CSV</Btn>
            <Btn small variant="primary" onClick={()=>setModal('new-list')}>+ New list</Btn>
          </>}
          <Btn small onClick={()=>onEditClient(emailClient)}>Edit</Btn>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', borderBottom:`0.5px solid ${BORDER}`, background:CARD }}>
        {['campaigns','lists'].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{ padding:'9px 18px', fontSize:13, border:'none', background:'transparent', cursor:'pointer', color:tab===t?GREEN:MUTED, fontWeight:tab===t?500:400, borderBottom:tab===t?`2px solid ${GREEN}`:'2px solid transparent', textTransform:'capitalize' }}>{t}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex:1, overflow:'auto', padding:20, background:BG }}>

        {/* Campaigns tab */}
        {tab==='campaigns' && (
          loading ? <div style={{ color:MUTED, textAlign:'center', padding:40 }}>Loading…</div> :
          campaigns.length===0 ? (
            <div style={{ background:CARD, border:`0.5px dashed ${BORDER}`, borderRadius:12, padding:48, textAlign:'center', color:MUTED }}>
              No campaigns yet.<br/><br/><Btn variant="primary" onClick={()=>setModal('new-campaign')}>Create first campaign</Btn>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {campaigns.map(c=>(
                <div key={c.id} style={{ background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:10, padding:'14px 16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
                    <div>
                      <div style={{ fontSize:14, fontWeight:500, color:TEXT, marginBottom:2 }}>{c.title}</div>
                      <div style={{ fontSize:12, color:MUTED }}>{c.list_name} · {c.from_email}{c.sent_at && ` · Sent ${new Date(c.sent_at).toLocaleDateString('en-GB',{day:'numeric',month:'short'})} · ${c.sent_count} recipients`}</div>
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
                    <div style={{ marginTop:8, padding:'6px 10px', borderRadius:6, fontSize:12, background:sendStatus.ok===false?'#fdecea':sendStatus.ok?`${GREEN}15`:'#f5f5f3', color:sendStatus.ok===false?DANGER:sendStatus.ok?DARK:MUTED }}>{sendStatus.msg}</div>
                  )}
                </div>
              ))}
            </div>
          )
        )}

        {/* Lists tab — Option A table */}
        {tab==='lists' && (
          loading ? <div style={{ color:MUTED, textAlign:'center', padding:40 }}>Loading…</div> : (
            <ListsTable
              emailClient={emailClient}
              lists={lists}
              onNewList={()=>setModal('new-list')}
              onImport={l=>{ setModalData(l); setModal('import'); }}
              onView={l=>setViewingList(l)}
              onDelete={deleteList}
              onRefresh={loadAll}
            />
          )
        )}

        {/* Domains tab */}
        {tab==='domains' && (
          domainsLoading ? <div style={{ color:MUTED, textAlign:'center', padding:40, fontSize:13 }}>Checking all domains…</div> :
          domains.length===0 ? <div style={{ color:MUTED, textAlign:'center', padding:40, fontSize:13 }}>No verified domains found.</div> : (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              {domains.map(d=><DomainCard key={d.domain} data={d} />)}
            </div>
          )
        )}
      </div>

      {/* Modals */}
      {modal==='new-campaign'  && <CampaignModal emailClient={emailClient} lists={lists} onClose={()=>setModal(null)} onSaved={()=>{ loadCampaigns(); onRefresh(); }} />}
      {modal==='edit-campaign' && <CampaignModal emailClient={emailClient} lists={lists} initial={modalData} onClose={()=>setModal(null)} onSaved={()=>{ loadCampaigns(); onRefresh(); }} />}
      {modal==='new-list'      && <ListModal emailClient={emailClient} onClose={()=>setModal(null)} onSaved={()=>{ loadAll(); onRefresh(); }} />}
      {modal==='import'        && <ImportModal list={modalData} onClose={()=>setModal(null)} onSaved={()=>{ loadAll(); onRefresh(); }} />}
    </div>
  );
}

// ── Main EmailSection ─────────────────────────────────────────────────────────

export default function EmailSection({ initialTab = 'customers' }) {
  const [clients, setClients]     = useState([]);
  const [selected, setSelected]   = useState(null);
  const [search, setSearch]       = useState('');
  const [loading, setLoading]     = useState(true);
  const [modal, setModal]         = useState(null);
  const [modalData, setModalData] = useState({});
  const [domains, setDomains]     = useState([]);
  const [domainsLoading, setDomainsLoading] = useState(false);

  // If sidebar navigated to Domain Health, show that view
  const isDomainView = initialTab === 'domains';

  useEffect(()=>{
    if (isDomainView) {
      loadDomains();
    } else {
      loadAll();
    }
  },[initialTab]);

  async function loadDomains() {
    setDomainsLoading(true); setDomains([]);
    const vd = await fetch('/api/email/verified-domains').then(r=>r.json());
    if (!Array.isArray(vd)||vd.length===0) { setDomainsLoading(false); return; }
    Promise.all(vd.map(d=>fetch(`/api/email/domain-health/${d}`).then(r=>r.json())))
      .then(results=>{ setDomains(results); setDomainsLoading(false); });
  }

  useEffect(()=>{ loadAll(); },[]);

  async function loadAll() {
    setLoading(true);
    const [vd, c] = await Promise.all([
      fetch('/api/email/verified-domains').then(r=>r.json()),
      fetch('/api/email/clients').then(r=>r.json()),
    ]);
    const domains = Array.isArray(vd)?vd:[];
    let current   = Array.isArray(c)?c:[];

    // Auto-create clients for any verified domain not already in the list
    const existingNames = current.map(cl=>cl.name.toLowerCase());
    const toCreate = domains.filter(d=>!existingNames.includes(d.toLowerCase()));
    if (toCreate.length > 0) {
      await Promise.all(toCreate.map(domain=>fetch('/api/email/clients',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:domain,color:'#1D9E75'}) })));
      const refreshed = await fetch('/api/email/clients').then(r=>r.json());
      current = Array.isArray(refreshed)?refreshed:[];
    }
    setClients(current);
    setLoading(false);
  }

  const filtered = clients.filter(c=>c.name.toLowerCase().includes(search.toLowerCase()));
  const selectedClient = clients.find(c=>c.id===selected);

  // ── Domain Health top-level view (from sidebar) ───────────────────────────
  if (isDomainView) {
    return (
      <div style={{ flex:1, display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden' }}>
        <div style={{ padding:'14px 20px', borderBottom:`0.5px solid ${BORDER}`, background:CARD, display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ fontSize:15, fontWeight:500, color:TEXT }}>Domain Health</div>
          <div style={{ marginLeft:'auto' }}>
            <Btn small onClick={loadDomains}>Refresh</Btn>
          </div>
        </div>
        <div style={{ flex:1, overflow:'auto', padding:20, background:BG }}>
          {domainsLoading ? (
            <div style={{ color:MUTED, textAlign:'center', padding:40 }}>Checking all domains…</div>
          ) : domains.length===0 ? (
            <div style={{ color:MUTED, textAlign:'center', padding:40 }}>No verified domains found.</div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {domains.map(d=><DomainCard key={d.domain} data={d} />)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Customers view (from sidebar) ─────────────────────────────────────────
  return (
    <div style={{ flex:1, display:'flex', height:'100vh', overflow:'hidden' }}>
      {/* Left panel */}
      <div style={{ width:240, background:CARD, borderRight:`0.5px solid ${BORDER}`, display:'flex', flexDirection:'column', flexShrink:0 }}>
        <div style={{ padding:'14px 12px', borderBottom:`0.5px solid ${BORDER}` }}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search clients…"
            style={{ width:'100%', padding:'7px 10px', border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13, color:TEXT, background:BG, outline:'none', boxSizing:'border-box' }} />
        </div>
        <div style={{ flex:1, overflowY:'auto' }}>
          {loading ? <div style={{ color:MUTED, textAlign:'center', padding:32, fontSize:13 }}>Loading…</div>
            : filtered.length===0 ? <div style={{ color:MUTED, textAlign:'center', padding:32, fontSize:13 }}>{search?'No clients match':'No clients yet'}</div>
            : filtered.map(c=>(
              <div key={c.id} onClick={()=>setSelected(c.id)} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', cursor:'pointer', borderBottom:`0.5px solid ${BORDER}`, background:selected===c.id?`${GREEN}12`:CARD, borderLeft:selected===c.id?`3px solid ${GREEN}`:'3px solid transparent' }}>
                <div style={{ width:30, height:30, borderRadius:7, background:c.color||GREEN, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:600, flexShrink:0 }}>{initials(c.name)}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:selected===c.id?500:400, color:TEXT, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{c.name}</div>
                  <div style={{ fontSize:11, color:MUTED }}>{c.list_count||0} lists · {c.subscriber_count||0} subs</div>
                </div>
              </div>
            ))
          }
        </div>
        <div style={{ padding:12, borderTop:`0.5px solid ${BORDER}` }}>
          <Btn variant="primary" style={{ width:'100%', justifyContent:'center' }} onClick={()=>setModal('new-client')}>+ New client</Btn>
        </div>
      </div>

      {/* Right panel */}
      {selectedClient ? (
        <ClientPanel key={selectedClient.id} emailClient={selectedClient} onRefresh={loadAll} onEditClient={c=>{ setModalData(c); setModal('edit-client'); }} />
      ) : (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:BG, flexDirection:'column', gap:12 }}>
          <div style={{ fontSize:14, color:MUTED }}>Select a client to get started</div>
          {clients.length===0 && !loading && <Btn variant="primary" onClick={()=>setModal('new-client')}>Add your first email client</Btn>}
        </div>
      )}

      {modal==='new-client'  && <ClientModal onClose={()=>setModal(null)} onSaved={loadAll} />}
      {modal==='edit-client' && <ClientModal initial={modalData} onClose={()=>setModal(null)} onSaved={loadAll} />}
    </div>
  );
}
