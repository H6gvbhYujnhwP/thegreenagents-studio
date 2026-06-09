// ─────────────────────────────────────────────────────────────────────────────
// FacebookPixels.jsx — Admin screen for managing per-customer Meta Pixel setup.
//
// Mounted by Dashboard.jsx when activeView === 'facebook-pixels'.
//
// Layout, top to bottom:
//   - Page heading "Facebook pixels" + "Add pixel customer" button.
//   - Summary cards (total / active / in setup / not started).
//   - Roster: one row per pixel customer (name, goal, status). Click a row to
//     open its setup panel inline below.
//   - Setup panel: editable Meta details, a setup checklist, a status control,
//     a "Remove from list" action, and a Phase-2 placeholder for the live
//     campaign numbers (pulled from Meta once the account is out of review).
//
// Endpoints under /api/facebook-pixels/* — behind the standard admin
// Bearer-token middleware (handled by the app's fetch interceptor, so plain
// fetch() works here). Live performance numbers are NOT shown yet — Phase B.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';

const GREEN='#1D9E75', GREEN_HI='#0F6E56', GREEN_BG='#E1F5EE';
const TEXT='#1a1a1a', MUTED='#666', TERTIARY='#999', BORDER='#e0e0dc', BG='#f5f5f3', CARD='#ffffff';
const BLUE='#185FA5', BLUE_BG='#E6F1FB';
const AMBER='#854F0B', AMBER_BG='#FAEEDA';
const GREY='#5F5E5A', GREY_BG='#F1EFE8';
const RED='#A32D2D';

const GOAL_LABELS = { leads: 'Leads', sales: 'Sales' };
const STATUS_META = {
  not_started: { label: 'Not started', fg: GREY,     bg: GREY_BG  },
  in_setup:    { label: 'In setup',    fg: AMBER,    bg: AMBER_BG },
  active:      { label: 'Active',      fg: GREEN_HI, bg: GREEN_BG },
};
const STATUS_ORDER = ['not_started', 'in_setup', 'active'];
const CHECKLIST = [
  ['pixel_created',     'Pixel created'],
  ['pixel_installed',   'Pixel installed'],
  ['conversions_api',   'Conversions API'],
  ['domain_verified',   'Domain verified'],
  ['lead_event',        'Lead event live'],
  ['audiences',         'Audiences'],
  ['testing_campaign',  'Testing campaign'],
  ['scaling_campaign',  'Scaling campaign'],
];

function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]).join('').toUpperCase();
}

function StatusPill({ status }) {
  const m = STATUS_META[status] || STATUS_META.not_started;
  return (
    <span style={{ background:m.bg, color:m.fg, fontSize:12, fontWeight:500, padding:'3px 10px', borderRadius:8, whiteSpace:'nowrap' }}>
      {m.label}
    </span>
  );
}

export default function FacebookPixels() {
  const [list, setList]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [available, setAvailable] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showAdd, setShowAdd]     = useState(false);
  const [saving, setSaving]       = useState(false);

  async function loadList() {
    setLoading(true);
    try { const r = await fetch('/api/facebook-pixels'); if (r.ok) setList(await r.json()); }
    catch (e) { console.error('[fb-pixels] loadList', e); }
    setLoading(false);
  }
  async function loadAvailable() {
    try { const r = await fetch('/api/facebook-pixels/available-customers'); if (r.ok) setAvailable(await r.json()); }
    catch (e) { console.error('[fb-pixels] loadAvailable', e); }
  }
  useEffect(() => { loadList(); loadAvailable(); }, []);

  const selected = list.find(p => p.id === selectedId) || null;

  async function patch(id, body) {
    setSaving(true);
    try {
      const r = await fetch(`/api/facebook-pixels/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.ok) { const updated = await r.json(); setList(prev => prev.map(p => p.id === id ? updated : p)); }
    } catch (e) { console.error('[fb-pixels] patch', e); }
    setSaving(false);
  }

  async function addCustomer(form) {
    try {
      const r = await fetch('/api/facebook-pixels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      if (r.ok) { const row = await r.json(); setShowAdd(false); await loadList(); await loadAvailable(); setSelectedId(row.id); }
      else { const e = await r.json().catch(() => ({})); alert(e.error || 'Could not add pixel customer'); }
    } catch (e) { console.error('[fb-pixels] add', e); }
  }

  async function removeCustomer(id) {
    if (!window.confirm('Remove this pixel customer? Their setup record and the portal service are removed. The customer record itself is kept.')) return;
    try { const r = await fetch(`/api/facebook-pixels/${id}`, { method: 'DELETE' }); if (r.ok) { setSelectedId(null); await loadList(); await loadAvailable(); } }
    catch (e) { console.error('[fb-pixels] remove', e); }
  }

  const counts = {
    total: list.length,
    active: list.filter(p => p.status === 'active').length,
    in_setup: list.filter(p => p.status === 'in_setup').length,
    not_started: list.filter(p => p.status === 'not_started').length,
  };

  const cardStyle = { background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:'14px 16px' };
  const fieldLab = { fontSize:12, color:TERTIARY, marginBottom:3, display:'block' };
  const fieldInput = { width:'100%', boxSizing:'border-box', padding:'7px 9px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:13, color:TEXT, background:'#fff' };

  return (
    <div style={{ flex:1, overflow:'auto', padding:28, background:BG }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
        <h1 style={{ fontSize:20, fontWeight:500, color:TEXT, margin:0 }}>Meta Pixels</h1>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          {saving && <span style={{ fontSize:12, color:TERTIARY }}>Saving…</span>}
          <button onClick={()=>setShowAdd(true)} style={{ background:GREEN_HI, color:'#fff', border:'none', borderRadius:6, padding:'8px 14px', fontSize:13, fontWeight:500, cursor:'pointer' }}>
            + Add pixel customer
          </button>
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:12, marginBottom:20 }}>
        <div style={{ ...cardStyle, background:'#fff' }}><div style={{ fontSize:13, color:MUTED }}>Pixel customers</div><div style={{ fontSize:24, fontWeight:500, color:TEXT }}>{counts.total}</div></div>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Active</div><div style={{ fontSize:24, fontWeight:500, color:GREEN_HI }}>{counts.active}</div></div>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>In setup</div><div style={{ fontSize:24, fontWeight:500, color:AMBER }}>{counts.in_setup}</div></div>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Not started</div><div style={{ fontSize:24, fontWeight:500, color:GREY }}>{counts.not_started}</div></div>
      </div>

      {loading ? (
        <div style={{ color:MUTED, fontSize:14 }}>Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ ...cardStyle, color:MUTED, fontSize:14 }}>No pixel customers yet. Click “Add pixel customer” to set one up.</div>
      ) : (
        <div>
          {list.map(p => {
            const isSel = p.id === selectedId;
            return (
              <div key={p.id}
                onClick={() => setSelectedId(isSel ? null : p.id)}
                style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, padding:'12px 14px',
                         border:`${isSel?2:1}px solid ${isSel?BLUE:BORDER}`, borderRadius:8, background:CARD, marginBottom:8, cursor:'pointer' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:30, height:30, borderRadius:6, background:BLUE_BG, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:500, color:BLUE }}>{initials(p.customer_name)}</div>
                  <div>
                    <div style={{ fontSize:14, fontWeight:500, color:TEXT }}>{p.customer_name}</div>
                    <div style={{ fontSize:12, color:TERTIARY }}>{GOAL_LABELS[p.goal] || p.goal}{p.domain ? ` · ${p.domain}` : ''}</div>
                  </div>
                </div>
                <StatusPill status={p.status} />
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <div style={{ ...cardStyle, marginTop:16, borderRadius:12 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
            <span style={{ fontSize:16, fontWeight:500, color:TEXT }}>{selected.customer_name} — setup</span>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <select value={selected.status} onChange={e=>patch(selected.id,{status:e.target.value})}
                style={{ ...fieldInput, width:'auto', padding:'6px 9px' }}>
                {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              </select>
              <button onClick={()=>removeCustomer(selected.id)} style={{ background:'#fff', color:RED, border:`1px solid ${RED}`, borderRadius:6, padding:'6px 12px', fontSize:13, fontWeight:500, cursor:'pointer' }}>
                Remove from list
              </button>
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:12, marginBottom:18 }}>
            <div><label style={fieldLab}>Business ID</label><input style={fieldInput} defaultValue={selected.business_id||''} onBlur={e=>patch(selected.id,{business_id:e.target.value})} /></div>
            <div><label style={fieldLab}>Ad account ID</label><input style={fieldInput} defaultValue={selected.ad_account_id||''} onBlur={e=>patch(selected.id,{ad_account_id:e.target.value})} /></div>
            <div><label style={fieldLab}>Pixel ID</label><input style={fieldInput} defaultValue={selected.pixel_id||''} onBlur={e=>patch(selected.id,{pixel_id:e.target.value})} /></div>
            <div><label style={fieldLab}>Pixel name</label><input style={fieldInput} defaultValue={selected.pixel_name||''} onBlur={e=>patch(selected.id,{pixel_name:e.target.value})} /></div>
            <div><label style={fieldLab}>Website domain</label><input style={fieldInput} defaultValue={selected.domain||''} onBlur={e=>patch(selected.id,{domain:e.target.value})} /></div>
            <div><label style={fieldLab}>Facebook page</label><input style={fieldInput} defaultValue={selected.facebook_page||''} onBlur={e=>patch(selected.id,{facebook_page:e.target.value})} /></div>
            <div><label style={fieldLab}>Goal</label>
              <select style={fieldInput} value={selected.goal} onChange={e=>patch(selected.id,{goal:e.target.value})}>
                <option value="leads">Leads</option><option value="sales">Sales</option>
              </select>
            </div>
            <div><label style={fieldLab}>Conversion event</label><input style={fieldInput} defaultValue={selected.conversion_event||''} onBlur={e=>patch(selected.id,{conversion_event:e.target.value})} placeholder="Lead" /></div>
          </div>

          <div style={{ borderTop:`1px solid ${BORDER}`, paddingTop:14, marginBottom:16 }}>
            <div style={{ fontSize:13, fontWeight:500, color:TEXT, marginBottom:8 }}>Setup checklist</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(190px, 1fr))', gap:'2px 16px' }}>
              {CHECKLIST.map(([key,label]) => {
                const done = !!(selected.checklist && selected.checklist[key]);
                return (
                  <label key={key} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, color:done?TEXT:MUTED, padding:'5px 0', cursor:'pointer' }}>
                    <input type="checkbox" checked={done}
                      onChange={e=>{ const next={ ...(selected.checklist||{}) }; next[key]=e.target.checked?1:0; patch(selected.id,{checklist_json:next}); }} />
                    {label}
                  </label>
                );
              })}
            </div>
          </div>

          <div style={{ border:`1px dashed ${BORDER}`, borderRadius:8, padding:14, background:BG }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
              <span style={{ fontSize:13, fontWeight:500, color:MUTED }}>Live campaign results</span>
              <span style={{ background:BLUE_BG, color:BLUE, fontSize:12, fontWeight:500, padding:'3px 10px', borderRadius:8 }}>Phase 2</span>
            </div>
            <div style={{ fontSize:12, color:TERTIARY }}>Leads, spend and cost-per-lead pull in automatically from Meta — switches on once the Facebook account is out of review.</div>
          </div>
        </div>
      )}

      {showAdd && <AddPixelModal available={available} onAdd={addCustomer} onClose={()=>setShowAdd(false)} />}
    </div>
  );
}

function AddPixelModal({ available, onAdd, onClose }) {
  const [f, setF] = useState({ email_client_id:'', goal:'leads', business_id:'', ad_account_id:'', pixel_id:'', pixel_name:'', domain:'', facebook_page:'', conversion_event:'' });
  const set = (k,v) => setF(prev => ({ ...prev, [k]:v }));
  const lab = { fontSize:12, color:'#999', marginBottom:3, display:'block' };
  const inp = { width:'100%', boxSizing:'border-box', padding:'7px 9px', border:'1px solid #e0e0dc', borderRadius:6, fontSize:13, color:'#1a1a1a', background:'#fff' };

  function submit() {
    if (!f.email_client_id) { alert('Pick a customer first'); return; }
    onAdd(f);
  }

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:'#fff', borderRadius:12, padding:24, width:560, maxWidth:'92vw', maxHeight:'88vh', overflow:'auto' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
          <span style={{ fontSize:17, fontWeight:500, color:'#1a1a1a' }}>Add pixel customer</span>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:20, color:'#999', cursor:'pointer', lineHeight:1 }}>×</button>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div style={{ gridColumn:'1 / -1' }}><label style={lab}>Customer</label>
            <select style={inp} value={f.email_client_id} onChange={e=>set('email_client_id', e.target.value)}>
              <option value="">Select existing customer…</option>
              {available.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div><label style={lab}>Goal</label>
            <select style={inp} value={f.goal} onChange={e=>set('goal', e.target.value)}>
              <option value="leads">Leads</option><option value="sales">Sales</option>
            </select>
          </div>
          <div><label style={lab}>Website domain</label><input style={inp} value={f.domain} onChange={e=>set('domain', e.target.value)} placeholder="wedoyourquotes.com" /></div>
          <div><label style={lab}>Business ID</label><input style={inp} value={f.business_id} onChange={e=>set('business_id', e.target.value)} /></div>
          <div><label style={lab}>Ad account ID</label><input style={inp} value={f.ad_account_id} onChange={e=>set('ad_account_id', e.target.value)} /></div>
          <div><label style={lab}>Pixel ID</label><input style={inp} value={f.pixel_id} onChange={e=>set('pixel_id', e.target.value)} /></div>
          <div><label style={lab}>Pixel name</label><input style={inp} value={f.pixel_name} onChange={e=>set('pixel_name', e.target.value)} placeholder="Client — Main Pixel" /></div>
          <div><label style={lab}>Facebook page</label><input style={inp} value={f.facebook_page} onChange={e=>set('facebook_page', e.target.value)} /></div>
          <div><label style={lab}>Conversion event</label><input style={inp} value={f.conversion_event} onChange={e=>set('conversion_event', e.target.value)} placeholder="Lead" /></div>
        </div>
        <div style={{ display:'flex', justifyContent:'flex-end', gap:10, marginTop:20 }}>
          <button onClick={onClose} style={{ background:'#fff', color:'#666', border:'1px solid #e0e0dc', borderRadius:6, padding:'8px 16px', fontSize:13, cursor:'pointer' }}>Cancel</button>
          <button onClick={submit} style={{ background:'#0F6E56', color:'#fff', border:'none', borderRadius:6, padding:'8px 16px', fontSize:13, fontWeight:500, cursor:'pointer' }}>Add customer</button>
        </div>
      </div>
    </div>
  );
}
