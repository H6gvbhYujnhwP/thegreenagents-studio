// ─────────────────────────────────────────────────────────────────────────────
// FacebookAds.jsx — Admin Facebook Ads screen (decision #107): READ-ONLY.
//
// Studio doesn't create or manage ads (Manus AI does). This screen is a window
// onto Facebook performance, one ad account per customer:
//   • pick a customer (or add one) and set their ad account id
//   • see that account's totals + a card per live ad (image/copy/status/stats)
// Nothing here writes to Facebook.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';

const GREEN_HI='#0F6E56', GREEN_BG='#E1F5EE';
const TEXT='#1a1a1a', MUTED='#666', TERTIARY='#999', BORDER='#e0e0dc', BG='#f5f5f3', CARD='#ffffff';
const BLUE='#185FA5', BLUE_BG='#E6F1FB';
const AMBER='#854F0B', AMBER_BG='#FAEEDA';
const GREY='#5F5E5A', GREY_BG='#F1EFE8';
const RED='#A32D2D', RED_BG='#FCEBEB';
const GREEN='#1D9E75';

const WINDOWS = [ {key:'7d',label:'Last 7 days'}, {key:'30d',label:'Last 30 days'}, {key:'lifetime',label:'Lifetime'} ];
const cardStyle = { background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:'14px 16px' };
const btn = (bg, fg, extra={}) => ({ background:bg, color:fg, border:'none', borderRadius:6, padding:'6px 12px', fontSize:12, fontWeight:500, cursor:'pointer', ...extra });

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

export default function FacebookAds() {
  const [customers, setCustomers] = useState([]);
  const [available, setAvailable] = useState([]);
  const [selId, setSelId] = useState('');
  const [window, setWindow] = useState('30d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addSel, setAddSel] = useState('');
  const [addAcct, setAddAcct] = useState('');
  const [editAcct, setEditAcct] = useState(false);
  const [acctInput, setAcctInput] = useState('');
  const [savingAcct, setSavingAcct] = useState(false);

  const selected = customers.find(c => c.id === selId) || null;

  async function loadCustomers() { try { const r = await fetch('/api/facebook-ads/customers'); if (r.ok) setCustomers(await r.json()); } catch {} }
  async function loadAvailable() { try { const r = await fetch('/api/facebook-ads/available-customers'); if (r.ok) setAvailable(await r.json()); } catch {} }

  async function loadAds(customerId, win) {
    if (!customerId) { setData(null); return; }
    setLoading(true); setError(null);
    try { const r = await fetch(`/api/facebook-ads/ads?customer=${encodeURIComponent(customerId)}&window=${encodeURIComponent(win)}`); setData(await r.json()); }
    catch { setError('Could not reach Studio. Try again in a moment.'); setData(null); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadCustomers(); loadAvailable(); }, []);
  useEffect(() => { loadAds(selId, window); }, [selId, window]);

  async function saveAccount(id, acct) {
    setSavingAcct(true); setError(null);
    try {
      const r = await fetch(`/api/facebook-ads/${id}/account`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ad_account_id: acct }) });
      const j = await r.json().catch(()=>({}));
      if (!r.ok) throw new Error(j.error || 'Could not save the ad account ID');
      await loadCustomers();
      return true;
    } catch (e) { setError(e.message); return false; }
    finally { setSavingAcct(false); }
  }

  async function onAddCustomer() {
    if (!addSel || !addAcct.trim()) { setError('Pick a customer and enter their ad account ID.'); return; }
    const okSaved = await saveAccount(addSel, addAcct.trim());
    if (okSaved) { await loadAvailable(); setSelId(addSel); setAddOpen(false); setAddSel(''); setAddAcct(''); }
  }

  async function onSaveEditAcct() {
    if (!selId) return;
    const okSaved = await saveAccount(selId, acctInput.trim());
    if (okSaved) { setEditAcct(false); loadAds(selId, window); }
  }

  const currency = (data && data.account && data.account.currency) || 'GBP';
  const fmtMoney = (n) => (n===null||n===undefined) ? '—' : (()=>{ try { return new Intl.NumberFormat('en-GB',{style:'currency',currency}).format(n); } catch { return `£${Number(n).toFixed(2)}`; } })();
  const fmtNum = (n) => (n===null||n===undefined) ? '—' : Number(n).toLocaleString('en-GB');

  const connected = !!(data && data.ok && data.account);
  const totals = (data && data.totals) || { spend:0, reach:0, leads:0, cost_per_lead:null };
  const ads = (data && Array.isArray(data.ads)) ? data.ads : [];
  const nothingSpent = connected && (!totals.spend || totals.spend === 0);
  const noAccount = data && data.no_account;
  const statCell = (label, value) => (<div><div style={{ fontSize:11, color:TERTIARY }}>{label}</div><div style={{ fontSize:14, fontWeight:500, color:TEXT }}>{value}</div></div>);

  return (
    <div style={{ flex:1, overflow:'auto', padding:28, background:BG }}>
      <div style={{ marginBottom:16 }}>
        <h1 style={{ fontSize:20, fontWeight:500, color:TEXT, margin:0 }}>Facebook Ads</h1>
        <div style={{ fontSize:13, color:MUTED, marginTop:3 }}>Live performance from Facebook. Read-only — campaigns are managed outside Studio.</div>
      </div>

      {/* Customer selector */}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginBottom:12 }}>
        <select value={selId} onChange={e=>{ setSelId(e.target.value); setEditAcct(false); }} style={{ minWidth:240, padding:'8px 9px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:13, background:'#fff', color:TEXT }}>
          <option value="">{customers.length ? 'Select a customer…' : 'No Facebook Ads customers yet'}</option>
          {customers.map(c => <option key={c.id} value={c.id}>{c.name}{c.has_account ? '' : ' (no account)'}</option>)}
        </select>
        <button onClick={()=>{ setAddOpen(o=>!o); setError(null); }} style={btn(GREEN_BG, GREEN_HI, { border:`1px solid ${GREEN}` })}>+ Add customer</button>
        <div style={{ flex:1 }} />
        {selected && (connected
          ? <span style={{ fontSize:12, padding:'5px 10px', borderRadius:6, background:GREEN_BG, color:GREEN_HI }}>● Connected</span>
          : (!noAccount && data && data.ok===false ? <span style={{ fontSize:12, padding:'5px 10px', borderRadius:6, background:RED_BG, color:RED }}>● Not connected</span> : null))}
        <div style={{ display:'inline-flex', border:`1px solid ${BORDER}`, borderRadius:6, overflow:'hidden' }}>
          {WINDOWS.map((w,i)=>(
            <button key={w.key} onClick={()=>setWindow(w.key)} style={{ padding:'6px 12px', fontSize:12, cursor:'pointer', border:'none', borderLeft:i===0?'none':`1px solid ${BORDER}`, background:window===w.key?GREEN_HI:'#fff', color:window===w.key?'#fff':MUTED, fontWeight:window===w.key?500:400 }}>{w.label}</button>
          ))}
        </div>
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
            <input value={addAcct} onChange={e=>setAddAcct(e.target.value)} placeholder="Ad account ID (e.g. 1754809155683350)" style={{ width:280, padding:'8px 9px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:13 }} />
            <button disabled={savingAcct} onClick={onAddCustomer} style={btn(GREEN_HI, '#fff', savingAcct?{opacity:0.6}:{})}>{savingAcct?'Saving…':'Add'}</button>
            <button onClick={()=>setAddOpen(false)} style={btn('#fff', MUTED, { border:`1px solid ${BORDER}` })}>Cancel</button>
          </div>
          <div style={{ fontSize:11, color:TERTIARY, marginTop:8 }}>The ad account ID is the number in Meta Ads Manager (with or without the “act_” prefix). One account per customer.</div>
        </div>
      )}

      {error && <div style={{ ...cardStyle, background:RED_BG, border:`1px solid ${RED}`, color:RED, marginBottom:14, fontSize:13 }}>{error}</div>}

      {!selected && !addOpen && <div style={{ ...cardStyle, color:MUTED, fontSize:13 }}>Select a customer to see their Facebook Ads performance, or add one.</div>}

      {/* Selected customer: account line */}
      {selected && (
        <div style={{ ...cardStyle, marginBottom:14, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <div style={{ fontSize:13, color:MUTED }}>Ad account:</div>
          {editAcct ? (
            <>
              <input value={acctInput} onChange={e=>setAcctInput(e.target.value)} placeholder="Ad account ID" style={{ width:260, padding:'7px 9px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:13 }} />
              <button disabled={savingAcct} onClick={onSaveEditAcct} style={btn(GREEN_HI,'#fff', savingAcct?{opacity:0.6}:{})}>{savingAcct?'Saving…':'Save'}</button>
              <button onClick={()=>setEditAcct(false)} style={btn('#fff',MUTED,{border:`1px solid ${BORDER}`})}>Cancel</button>
            </>
          ) : (
            <>
              <span style={{ fontSize:13, color:TEXT }}>{selected.ad_account_id ? `act_${selected.ad_account_id}` : <span style={{ color:RED }}>not set</span>}</span>
              <button onClick={()=>{ setAcctInput(selected.ad_account_id||''); setEditAcct(true); }} style={btn(GREY_BG, GREY, { border:`1px solid ${BORDER}` })}>{selected.ad_account_id?'Edit':'Set account'}</button>
              {data && data.account && <span style={{ fontSize:12, color:TERTIARY }}>· {data.account.name} · {currency}</span>}
            </>
          )}
        </div>
      )}

      {/* Meta failure (not the "no account" case) */}
      {selected && data && data.ok===false && !noAccount && (
        <div style={{ ...cardStyle, background:AMBER_BG, border:`1px solid ${AMBER}`, color:AMBER, marginBottom:14 }}>
          <div style={{ fontWeight:500, marginBottom:4 }}>Couldn't load ads from Facebook</div>
          <div style={{ fontSize:13 }}>{data.error || 'Unknown error from the Meta API.'}</div>
        </div>
      )}

      {selected && noAccount && !editAcct && (
        <div style={{ ...cardStyle, color:MUTED, fontSize:13 }}>Set this customer's ad account ID above to see their performance.</div>
      )}

      {/* Performance */}
      {selected && selected.ad_account_id && !noAccount && (
        <>
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
                  <div style={{ width:120, height:120, flex:'none', borderRadius:8, background:GREY_BG, overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center' }}>
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
        </>
      )}
    </div>
  );
}
