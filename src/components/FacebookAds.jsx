// ─────────────────────────────────────────────────────────────────────────────
// FacebookAds.jsx — Admin Facebook Ads screen (decision #104/#106).
//
// Two tabs:
//   • Live ads   — READ stage: account totals + a card per live ad, pulled from
//                  the Meta Marketing API. Read-only.
//   • Creatives  — Stage 2: per-customer RAG upload + Studio-generated ad copy
//                  and images (Claude + Gemini), reviewed/edited/approved here.
//                  NOTHING is sent to Facebook on this tab — that's stage 3.
//
// Endpoints under /api/facebook-ads/* (admin Bearer added by the app's fetch
// interceptor, so plain fetch() / FormData work).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';

const GREEN='#1D9E75', GREEN_HI='#0F6E56', GREEN_BG='#E1F5EE';
const TEXT='#1a1a1a', MUTED='#666', TERTIARY='#999', BORDER='#e0e0dc', BG='#f5f5f3', CARD='#ffffff';
const BLUE='#185FA5', BLUE_BG='#E6F1FB';
const AMBER='#854F0B', AMBER_BG='#FAEEDA';
const GREY='#5F5E5A', GREY_BG='#F1EFE8';
const RED='#A32D2D', RED_BG='#FCEBEB';

const CTA_LABELS = {
  LEARN_MORE:'Learn more', SIGN_UP:'Sign up', GET_QUOTE:'Get quote', CONTACT_US:'Contact us',
  SUBSCRIBE:'Subscribe', DOWNLOAD:'Download', BOOK_NOW:'Book now', GET_OFFER:'Get offer', SEND_MESSAGE:'Send message',
};

const cardStyle = { background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:'14px 16px' };
const btn = (bg, fg, extra={}) => ({ background:bg, color:fg, border:'none', borderRadius:6, padding:'6px 12px', fontSize:12, fontWeight:500, cursor:'pointer', ...extra });

export default function FacebookAds() {
  const [tab, setTab] = useState('live');
  return (
    <div style={{ flex:1, overflow:'auto', padding:28, background:BG }}>
      <div style={{ marginBottom:16 }}>
        <h1 style={{ fontSize:20, fontWeight:500, color:TEXT, margin:0 }}>Facebook Ads</h1>
        <div style={{ display:'flex', gap:18, marginTop:12, borderBottom:`1px solid ${BORDER}` }}>
          {['live','creatives'].map(t => (
            <div key={t} onClick={()=>setTab(t)} style={{
              fontSize:14, cursor:'pointer', padding:'0 0 8px',
              color: tab===t ? TEXT : MUTED,
              borderBottom: tab===t ? `2px solid ${BLUE}` : '2px solid transparent',
              fontWeight: tab===t ? 500 : 400,
            }}>{t==='live' ? 'Live ads' : 'Creatives'}</div>
          ))}
        </div>
      </div>
      {tab==='live' ? <LiveAdsTab /> : <CreativesTab />}
    </div>
  );
}

// ── LIVE ADS (read stage) ────────────────────────────────────────────────────
const WINDOWS = [ {key:'7d',label:'Last 7 days'}, {key:'30d',label:'Last 30 days'}, {key:'lifetime',label:'Lifetime'} ];

function statusPill(eff, status) {
  const s = (eff || status || '').toUpperCase();
  if (s === 'ACTIVE') return { label:'Active', fg:GREEN_HI, bg:GREEN_BG };
  if (s === 'PAUSED' || s === 'ADSET_PAUSED' || s === 'CAMPAIGN_PAUSED') return { label:'Paused', fg:AMBER, bg:AMBER_BG };
  if (s === 'IN_PROCESS' || s === 'PENDING_REVIEW') return { label:'In review', fg:BLUE, bg:BLUE_BG };
  if (s === 'DISAPPROVED' || s === 'WITH_ISSUES' || s === 'ADSET_DISAPPROVED') return { label:'Has issues', fg:RED, bg:RED_BG };
  if (s === 'ARCHIVED' || s === 'DELETED') return { label:'Archived', fg:GREY, bg:GREY_BG };
  const label = (eff || status || 'Unknown').toLowerCase().replace(/_/g,' ').replace(/^\w/, c=>c.toUpperCase());
  return { label, fg:GREY, bg:GREY_BG };
}

function LiveAdsTab() {
  const [window, setWindow] = useState('30d');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function load(win) {
    setLoading(true); setError(null);
    try { const r = await fetch(`/api/facebook-ads/ads?window=${encodeURIComponent(win)}`); setData(await r.json()); }
    catch { setError('Could not reach Studio. Try again in a moment.'); setData(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(window); /* eslint-disable-next-line */ }, [window]);

  const currency = (data && data.account && data.account.currency) || 'GBP';
  const fmtMoney = (n) => (n===null||n===undefined) ? '—' : (()=>{ try { return new Intl.NumberFormat('en-GB',{style:'currency',currency}).format(n); } catch { return `£${Number(n).toFixed(2)}`; } })();
  const fmtNum = (n) => (n===null||n===undefined) ? '—' : Number(n).toLocaleString('en-GB');

  const connected = !!(data && data.ok && data.account);
  const totals = (data && data.totals) || { spend:0, reach:0, leads:0, cost_per_lead:null };
  const ads = (data && Array.isArray(data.ads)) ? data.ads : [];
  const nothingSpent = connected && (!totals.spend || totals.spend === 0);
  const statCell = (label, value) => (<div><div style={{ fontSize:11, color:TERTIARY }}>{label}</div><div style={{ fontSize:14, fontWeight:500, color:TEXT }}>{value}</div></div>);

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap', marginBottom:14 }}>
        <div style={{ fontSize:12, color:MUTED }}>{data && data.account ? `${data.account.name} · ${data.account.id} · ${currency}` : ' '}</div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {connected
            ? <span style={{ fontSize:12, padding:'5px 10px', borderRadius:6, background:GREEN_BG, color:GREEN_HI }}>● Connected</span>
            : <span style={{ fontSize:12, padding:'5px 10px', borderRadius:6, background:RED_BG, color:RED }}>● Not connected</span>}
          <div style={{ display:'inline-flex', border:`1px solid ${BORDER}`, borderRadius:6, overflow:'hidden' }}>
            {WINDOWS.map((w,i)=>(
              <button key={w.key} onClick={()=>setWindow(w.key)} style={{ padding:'6px 12px', fontSize:12, cursor:'pointer', border:'none', borderLeft:i===0?'none':`1px solid ${BORDER}`, background:window===w.key?GREEN_HI:'#fff', color:window===w.key?'#fff':MUTED, fontWeight:window===w.key?500:400 }}>{w.label}</button>
            ))}
          </div>
        </div>
      </div>

      {error && <div style={{ ...cardStyle, background:RED_BG, border:`1px solid ${RED}`, color:RED, marginBottom:16 }}>{error}</div>}
      {data && data.ok === false && !error && (
        <div style={{ ...cardStyle, background:AMBER_BG, border:`1px solid ${AMBER}`, color:AMBER, marginBottom:16 }}>
          <div style={{ fontWeight:500, marginBottom:4 }}>Couldn't load ads from Facebook</div>
          <div style={{ fontSize:13 }}>{data.error || 'Unknown error from the Meta API.'}</div>
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:12, marginBottom:12 }}>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Total spent</div><div style={{ fontSize:24, fontWeight:500 }}>{loading?'…':fmtMoney(totals.spend)}</div></div>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Reach</div><div style={{ fontSize:24, fontWeight:500 }}>{loading?'…':fmtNum(totals.reach)}</div></div>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Leads</div><div style={{ fontSize:24, fontWeight:500 }}>{loading?'…':fmtNum(totals.leads)}</div></div>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Cost per lead</div><div style={{ fontSize:24, fontWeight:500 }}>{loading?'…':fmtMoney(totals.cost_per_lead)}</div></div>
      </div>

      {!loading && nothingSpent && (
        <div style={{ display:'flex', gap:8, fontSize:12, color:BLUE, background:BLUE_BG, borderRadius:6, padding:'8px 12px', marginBottom:18 }}>
          <span>ℹ️</span><span>No spend in this window yet, so the numbers are zero. Leads start counting once an ad is running and the pixel's lead event is live.</span>
        </div>
      )}

      {!loading && connected && <div style={{ fontSize:13, color:MUTED, margin:'6px 0 8px' }}>{ads.length} {ads.length===1?'ad':'ads'}</div>}
      {loading && <div style={{ fontSize:13, color:TERTIARY, padding:'12px 0' }}>Loading ads from Facebook…</div>}
      {!loading && connected && ads.length===0 && <div style={{ ...cardStyle, color:MUTED, fontSize:13 }}>No ads in this account yet.</div>}

      <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
        {!loading && ads.map(ad => {
          const pill = statusPill(ad.effective_status, ad.status); const s = ad.stats || {};
          return (
            <div key={ad.id} style={{ ...cardStyle, display:'flex', gap:14 }}>
              <div style={{ width:84, height:84, flex:'none', borderRadius:8, background:GREY_BG, overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center' }}>
                {ad.image_url ? <img src={ad.image_url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} onError={(e)=>{e.target.style.display='none';}} /> : <span style={{ color:TERTIARY, fontSize:11 }}>No image</span>}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  <div style={{ fontWeight:500, fontSize:15, color:TEXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ad.title || ad.name}</div>
                  <span style={{ fontSize:11, padding:'3px 8px', borderRadius:6, background:pill.bg, color:pill.fg, flex:'none' }}>{pill.label}</span>
                </div>
                {(ad.body || ad.title) && <div style={{ fontSize:13, color:MUTED, margin:'4px 0 10px', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>{ad.body || ad.name}</div>}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8 }}>
                  {statCell('Spend', fmtMoney(s.spend))}{statCell('Reach', fmtNum(s.reach))}{statCell('Leads', fmtNum(s.leads))}{statCell('Cost / lead', fmtMoney(s.cost_per_lead))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── CREATIVES (stage 2) ──────────────────────────────────────────────────────
function CreativesTab() {
  const [customers, setCustomers] = useState([]);
  const [selId, setSelId] = useState('');
  const [creatives, setCreatives] = useState([]);
  const [loadingCreatives, setLoadingCreatives] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState({});            // creativeId -> 'text'|'image'|'approve'
  const [editing, setEditing] = useState({});      // creativeId -> draft {primary_text, headline, cta}
  const [error, setError] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [available, setAvailable] = useState([]);
  const [addSel, setAddSel] = useState('');
  const [addFile, setAddFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  const selected = customers.find(c => c.id === selId) || null;

  async function loadCustomers() {
    try { const r = await fetch('/api/facebook-ads/customers'); if (r.ok) setCustomers(await r.json()); } catch {}
  }
  async function loadAvailable() {
    try { const r = await fetch('/api/facebook-ads/available-customers'); if (r.ok) setAvailable(await r.json()); } catch {}
  }
  async function loadCreatives(id) {
    if (!id) { setCreatives([]); return; }
    setLoadingCreatives(true);
    try { const r = await fetch(`/api/facebook-ads/${id}/creatives`); if (r.ok) setCreatives(await r.json()); }
    finally { setLoadingCreatives(false); }
  }
  useEffect(() => { loadCustomers(); loadAvailable(); }, []);
  useEffect(() => { loadCreatives(selId); setError(null); }, [selId]);

  async function uploadRag(id, file) {
    const fd = new FormData(); fd.append('rag', file);
    const r = await fetch(`/api/facebook-ads/${id}/rag`, { method:'POST', body: fd });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    return j;
  }

  async function onAddCustomer() {
    if (!addSel || !addFile) { setError('Pick a customer and choose a RAG file.'); return; }
    setUploading(true); setError(null);
    try {
      await uploadRag(addSel, addFile);
      await loadCustomers(); await loadAvailable();
      setSelId(addSel); setAddOpen(false); setAddSel(''); setAddFile(null);
    } catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function onReplaceRag(file) {
    if (!file || !selId) return;
    setUploading(true); setError(null);
    try { await uploadRag(selId, file); await loadCustomers(); }
    catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function onGenerate() {
    if (!selId) return;
    setGenerating(true); setError(null);
    try {
      const r = await fetch(`/api/facebook-ads/${selId}/generate`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ count })
      });
      const j = await r.json().catch(()=>({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || 'Generation failed');
      await loadCreatives(selId);
    } catch (e) { setError(e.message); }
    finally { setGenerating(false); }
  }

  function replaceCreative(updated) {
    setCreatives(list => list.map(c => c.id === updated.id ? updated : c));
  }
  async function creativeAction(id, path, method='POST') {
    const kind = path.includes('regenerate-text') ? 'text' : path.includes('regenerate-image') ? 'image' : 'approve';
    setBusy(b => ({ ...b, [id]: kind })); setError(null);
    try {
      const r = await fetch(`/api/facebook-ads/creatives/${id}${path}`, { method });
      const j = await r.json().catch(()=>({}));
      if (!r.ok) throw new Error(j.error || 'Action failed');
      replaceCreative(j);
    } catch (e) { setError(e.message); }
    finally { setBusy(b => ({ ...b, [id]: null })); }
  }

  function startEdit(c) { setEditing(e => ({ ...e, [c.id]: { primary_text:c.primary_text||'', headline:c.headline||'', cta:c.cta||'LEARN_MORE' } })); }
  function cancelEdit(id) { setEditing(e => { const n={...e}; delete n[id]; return n; }); }
  async function saveEdit(id) {
    const draft = editing[id]; if (!draft) return;
    setBusy(b => ({ ...b, [id]: 'approve' })); setError(null);
    try {
      const r = await fetch(`/api/facebook-ads/creatives/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(draft) });
      const j = await r.json().catch(()=>({}));
      if (!r.ok) throw new Error(j.error || 'Save failed');
      replaceCreative(j); cancelEdit(id);
    } catch (e) { setError(e.message); }
    finally { setBusy(b => ({ ...b, [id]: null })); }
  }

  const approvedCount = creatives.filter(c => c.status==='approved').length;

  return (
    <div>
      {/* Customer selector */}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginBottom:10 }}>
        <select value={selId} onChange={e=>setSelId(e.target.value)} style={{ minWidth:240, padding:'8px 9px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:13, background:'#fff', color:TEXT }}>
          <option value="">{customers.length ? 'Select a customer…' : 'No Facebook Ads customers yet'}</option>
          {customers.map(c => <option key={c.id} value={c.id}>{c.name}{c.has_rag ? '' : ' (no RAG)'}</option>)}
        </select>
        <button onClick={()=>{ setAddOpen(o=>!o); setError(null); }} style={btn(GREEN_BG, GREEN_HI, { border:`1px solid ${GREEN}` })}>+ Add customer</button>
      </div>

      {/* Add-customer panel */}
      {addOpen && (
        <div style={{ ...cardStyle, marginBottom:14 }}>
          <div style={{ fontSize:13, fontWeight:500, marginBottom:8 }}>Add a Facebook Ads customer</div>
          <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <select value={addSel} onChange={e=>setAddSel(e.target.value)} style={{ minWidth:220, padding:'8px 9px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:13, background:'#fff' }}>
              <option value="">Choose customer…</option>
              {available.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input type="file" accept=".pdf,.md,.txt,.csv" onChange={e=>setAddFile(e.target.files[0]||null)} style={{ fontSize:12 }} />
            <button disabled={uploading} onClick={onAddCustomer} style={btn(GREEN_HI, '#fff', uploading?{opacity:0.6}:{})}>{uploading?'Uploading…':'Add + upload RAG'}</button>
            <button onClick={()=>setAddOpen(false)} style={btn('#fff', MUTED, { border:`1px solid ${BORDER}` })}>Cancel</button>
          </div>
          <div style={{ fontSize:11, color:TERTIARY, marginTop:8 }}>RAG file: .pdf, .md, .txt or .csv — the customer's voice, offers, and banned words. Drives the copy and image.</div>
        </div>
      )}

      {error && <div style={{ ...cardStyle, background:RED_BG, border:`1px solid ${RED}`, color:RED, marginBottom:14, fontSize:13 }}>{error}</div>}

      {/* Selected customer toolbar */}
      {selected && (
        <div style={{ ...cardStyle, marginBottom:14 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap', justifyContent:'space-between' }}>
            <div style={{ fontSize:13, color:MUTED }}>
              RAG: {selected.has_rag ? <span style={{ color:TEXT }}>{selected.rag_filename || 'uploaded'}</span> : <span style={{ color:RED }}>none uploaded yet</span>}
              <label style={{ marginLeft:12, color:BLUE, cursor:'pointer' }}>
                {selected.has_rag ? 'Replace' : 'Upload'} RAG
                <input type="file" accept=".pdf,.md,.txt,.csv" style={{ display:'none' }} onChange={e=>{ const f=e.target.files[0]; if(f) onReplaceRag(f); e.target.value=''; }} />
              </label>
              {uploading && <span style={{ marginLeft:10, color:TERTIARY }}>uploading…</span>}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <select value={count} onChange={e=>setCount(parseInt(e.target.value,10))} style={{ padding:'7px 8px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:12, background:'#fff' }}>
                {[1,2,3,4,5].map(n=> <option key={n} value={n}>{n} variation{n>1?'s':''}</option>)}
              </select>
              <button disabled={!selected.has_rag || generating} onClick={onGenerate} style={btn(BLUE, '#fff', (!selected.has_rag||generating)?{opacity:0.55, cursor:'default'}:{})}>
                {generating ? 'Generating… (up to a minute)' : '✨ Generate ads'}
              </button>
            </div>
          </div>
          <div style={{ fontSize:11, color:TERTIARY, marginTop:8 }}>Nothing is sent to Facebook here. Generated ads are drafts you review below.</div>
        </div>
      )}

      {selected && creatives.length>0 && (
        <div style={{ display:'flex', gap:8, fontSize:12, color:MUTED, background:GREY_BG, borderRadius:6, padding:'8px 12px', marginBottom:14 }}>
          📁 {approvedCount} of {creatives.length} approved · approved ads wait here until you push them (paused) in the next step.
        </div>
      )}

      {generating && <div style={{ fontSize:13, color:TERTIARY, padding:'8px 0' }}>Writing copy and generating images…</div>}
      {loadingCreatives && !generating && <div style={{ fontSize:13, color:TERTIARY, padding:'8px 0' }}>Loading…</div>}
      {selected && !loadingCreatives && creatives.length===0 && !generating && (
        <div style={{ ...cardStyle, color:MUTED, fontSize:13 }}>{selected.has_rag ? 'No creatives yet. Click “Generate ads”.' : 'Upload a RAG document, then generate.'}</div>
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
        {creatives.map(c => {
          const isApproved = c.status==='approved';
          const b = busy[c.id];
          const ed = editing[c.id];
          return (
            <div key={c.id} style={{ ...cardStyle, display:'flex', gap:14, border:`1px solid ${isApproved?GREEN:BORDER}` }}>
              <div style={{ width:120, height:120, flex:'none', borderRadius:8, background:GREY_BG, overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center', position:'relative' }}>
                {c.image_url ? <img src={c.image_url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} onError={(e)=>{e.target.style.display='none';}} /> : <span style={{ color:TERTIARY, fontSize:11 }}>No image</span>}
                {b==='image' && <div style={{ position:'absolute', inset:0, background:'rgba(255,255,255,0.8)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, color:MUTED, textAlign:'center', padding:6 }}>Generating image…</div>}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8, marginBottom:6 }}>
                  <span style={{ fontSize:12, color:TERTIARY }}>{c.hook_label}</span>
                  <span style={{ fontSize:11, padding:'3px 8px', borderRadius:6, background:isApproved?GREEN_BG:GREY_BG, color:isApproved?GREEN_HI:GREY }}>{isApproved?'✓ Approved':'Draft'}</span>
                </div>

                {ed ? (
                  <div style={{ marginBottom:8 }}>
                    <textarea value={ed.primary_text} onChange={e=>setEditing(s=>({...s,[c.id]:{...ed,primary_text:e.target.value}}))} rows={4} style={{ width:'100%', boxSizing:'border-box', padding:8, border:`1px solid ${BORDER}`, borderRadius:6, fontSize:13, marginBottom:6 }} />
                    <input value={ed.headline} onChange={e=>setEditing(s=>({...s,[c.id]:{...ed,headline:e.target.value}}))} placeholder="Headline" style={{ width:'100%', boxSizing:'border-box', padding:'7px 8px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:13, marginBottom:6 }} />
                    <select value={ed.cta} onChange={e=>setEditing(s=>({...s,[c.id]:{...ed,cta:e.target.value}}))} style={{ padding:'6px 8px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:12 }}>
                      {Object.entries(CTA_LABELS).map(([k,v])=> <option key={k} value={k}>{v}</option>)}
                    </select>
                    <div style={{ marginTop:8, display:'flex', gap:8 }}>
                      <button onClick={()=>saveEdit(c.id)} style={btn(GREEN_HI,'#fff')}>Save</button>
                      <button onClick={()=>cancelEdit(c.id)} style={btn('#fff',MUTED,{border:`1px solid ${BORDER}`})}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ position:'relative' }}>
                    <div style={{ fontSize:13, color:TEXT, lineHeight:1.5, marginBottom:6, whiteSpace:'pre-wrap' }}>{c.primary_text}</div>
                    {c.headline && <div style={{ fontSize:13, fontWeight:500, color:TEXT }}>{c.headline}</div>}
                    <div style={{ fontSize:11, color:TERTIARY, margin:'6px 0 10px' }}>Button: {CTA_LABELS[c.cta] || c.cta}</div>
                    {b==='text' && <div style={{ position:'absolute', inset:0, background:'rgba(255,255,255,0.8)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, color:MUTED }}>Rewriting copy…</div>}
                    <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                      <button disabled={!!b} onClick={()=>startEdit(c)} style={btn(GREY_BG, GREY, b?{opacity:0.5}:{})}>Edit text</button>
                      <button disabled={!!b} onClick={()=>creativeAction(c.id,'/regenerate-text')} style={btn(GREY_BG, GREY, b?{opacity:0.5}:{})}>Rewrite</button>
                      <button disabled={!!b} onClick={()=>creativeAction(c.id,'/regenerate-image')} style={btn(GREY_BG, GREY, b?{opacity:0.5}:{})}>New image</button>
                      {isApproved
                        ? <button disabled={!!b} onClick={()=>creativeAction(c.id,'/unapprove')} style={btn('#fff', GREEN_HI, { border:`1px solid ${GREEN}` })}>Unapprove</button>
                        : <button disabled={!!b} onClick={()=>creativeAction(c.id,'/approve')} style={btn(GREEN_BG, GREEN_HI, { border:`1px solid ${GREEN}` })}>Approve</button>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
