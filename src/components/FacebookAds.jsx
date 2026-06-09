// ─────────────────────────────────────────────────────────────────────────────
// FacebookAds.jsx — Admin screen for the Facebook Ads READ stage (decision #104).
//
// Mounted by Dashboard.jsx when activeView === 'facebook-ads'.
//
// What it shows (read-only this stage):
//   - A header with a live Connected/Not-connected pill and a date-window
//     toggle (Last 7 days / 30 days / Lifetime).
//   - Account totals for the window (spend / reach / leads / cost-per-lead).
//   - An honest note when nothing has spent yet (so zeros aren't mistaken for
//     a broken screen).
//   - One card per ad: creative image + text, a status pill, and the same four
//     numbers per ad.
//
// Data comes from GET /api/facebook-ads/ads?window=7d|30d|lifetime — which
// pulls live from the Meta Marketing API via server/services/meta-api.js.
// Pausing, budgets, and creative edits are LATER stages; this screen only reads.
//
// Endpoints are behind the standard admin Bearer middleware (the app's fetch
// interceptor adds the token, so plain fetch() works here).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';

const GREEN='#1D9E75', GREEN_HI='#0F6E56', GREEN_BG='#E1F5EE';
const TEXT='#1a1a1a', MUTED='#666', TERTIARY='#999', BORDER='#e0e0dc', BG='#f5f5f3', CARD='#ffffff';
const BLUE='#185FA5', BLUE_BG='#E6F1FB';
const AMBER='#854F0B', AMBER_BG='#FAEEDA';
const GREY='#5F5E5A', GREY_BG='#F1EFE8';
const RED='#A32D2D', RED_BG='#FCEBEB';

const WINDOWS = [
  { key:'7d',       label:'Last 7 days' },
  { key:'30d',      label:'Last 30 days' },
  { key:'lifetime', label:'Lifetime' },
];

// Map Meta's effective_status to a friendly label + colour. effective_status
// is the real delivery state (accounts for parent campaign/ad-set being off),
// so it's what we show. Anything we don't recognise falls back to a neutral pill.
function statusPill(eff, status) {
  const s = (eff || status || '').toUpperCase();
  if (s === 'ACTIVE')                       return { label:'Active',    fg:GREEN_HI, bg:GREEN_BG };
  if (s === 'PAUSED' || s === 'ADSET_PAUSED' || s === 'CAMPAIGN_PAUSED')
                                            return { label:'Paused',    fg:AMBER,    bg:AMBER_BG };
  if (s === 'IN_PROCESS' || s === 'PENDING_REVIEW')
                                            return { label:'In review', fg:BLUE,     bg:BLUE_BG };
  if (s === 'DISAPPROVED' || s === 'WITH_ISSUES' || s === 'ADSET_DISAPPROVED')
                                            return { label:'Has issues',fg:RED,      bg:RED_BG };
  if (s === 'ARCHIVED' || s === 'DELETED')  return { label:'Archived',  fg:GREY,     bg:GREY_BG };
  // Friendly title-case fallback for any other status.
  const label = (eff || status || 'Unknown').toLowerCase().replace(/_/g,' ').replace(/^\w/, c=>c.toUpperCase());
  return { label, fg:GREY, bg:GREY_BG };
}

export default function FacebookAds() {
  const [window, setWindow] = useState('30d');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);   // full /ads response
  const [error, setError] = useState(null);  // transport-level error only

  async function load(win) {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/facebook-ads/ads?window=${encodeURIComponent(win)}`);
      const j = await r.json();
      setData(j);
    } catch (e) {
      setError('Could not reach Studio. Try again in a moment.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(window); /* eslint-disable-next-line */ }, [window]);

  const currency = (data && data.account && data.account.currency) || 'GBP';
  const fmtMoney = (n) => {
    if (n === null || n === undefined) return '—';
    try { return new Intl.NumberFormat('en-GB', { style:'currency', currency }).format(n); }
    catch { return `£${Number(n).toFixed(2)}`; }
  };
  const fmtNum = (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('en-GB');

  const connected = !!(data && data.ok && data.account);
  const totals = (data && data.totals) || { spend:0, reach:0, leads:0, cost_per_lead:null };
  const ads = (data && Array.isArray(data.ads)) ? data.ads : [];
  const nothingSpent = connected && (!totals.spend || totals.spend === 0);

  const cardStyle = { background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:'14px 16px' };
  const statCell = (label, value, accent) => (
    <div><div style={{ fontSize:11, color:TERTIARY }}>{label}</div><div style={{ fontSize:14, fontWeight:500, color:accent||TEXT }}>{value}</div></div>
  );

  return (
    <div style={{ flex:1, overflow:'auto', padding:28, background:BG }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap', marginBottom:18 }}>
        <div>
          <h1 style={{ fontSize:20, fontWeight:500, color:TEXT, margin:0 }}>Facebook Ads</h1>
          {data && data.account && (
            <div style={{ fontSize:12, color:MUTED, marginTop:3 }}>
              {data.account.name} · {data.account.id} · {currency}
            </div>
          )}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {connected
            ? <span style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:12, padding:'5px 10px', borderRadius:6, background:GREEN_BG, color:GREEN_HI }}>● Connected</span>
            : <span style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:12, padding:'5px 10px', borderRadius:6, background:RED_BG, color:RED }}>● Not connected</span>}
          <div style={{ display:'inline-flex', border:`1px solid ${BORDER}`, borderRadius:6, overflow:'hidden' }}>
            {WINDOWS.map((w, i) => (
              <button key={w.key} onClick={()=>setWindow(w.key)} style={{
                padding:'6px 12px', fontSize:12, cursor:'pointer', border:'none',
                borderLeft: i===0 ? 'none' : `1px solid ${BORDER}`,
                background: window===w.key ? GREEN_HI : '#fff',
                color: window===w.key ? '#fff' : MUTED,
                fontWeight: window===w.key ? 500 : 400,
              }}>{w.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Transport error */}
      {error && (
        <div style={{ ...cardStyle, background:RED_BG, border:`1px solid ${RED}`, color:RED, marginBottom:16 }}>{error}</div>
      )}

      {/* Meta-side failure (connected check failed / token issue) */}
      {data && data.ok === false && !error && (
        <div style={{ ...cardStyle, background:AMBER_BG, border:`1px solid ${AMBER}`, color:AMBER, marginBottom:16 }}>
          <div style={{ fontWeight:500, marginBottom:4 }}>Couldn't load ads from Facebook</div>
          <div style={{ fontSize:13 }}>{data.error || 'Unknown error from the Meta API.'}</div>
        </div>
      )}

      {/* Account totals */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:12, marginBottom:12 }}>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Total spent</div><div style={{ fontSize:24, fontWeight:500, color:TEXT }}>{loading ? '…' : fmtMoney(totals.spend)}</div></div>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Reach</div><div style={{ fontSize:24, fontWeight:500, color:TEXT }}>{loading ? '…' : fmtNum(totals.reach)}</div></div>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Leads</div><div style={{ fontSize:24, fontWeight:500, color:TEXT }}>{loading ? '…' : fmtNum(totals.leads)}</div></div>
        <div style={cardStyle}><div style={{ fontSize:13, color:MUTED }}>Cost per lead</div><div style={{ fontSize:24, fontWeight:500, color:TEXT }}>{loading ? '…' : fmtMoney(totals.cost_per_lead)}</div></div>
      </div>

      {/* Honest empty-spend note */}
      {!loading && nothingSpent && (
        <div style={{ display:'flex', gap:8, fontSize:12, color:BLUE, background:BLUE_BG, borderRadius:6, padding:'8px 12px', marginBottom:18 }}>
          <span>ℹ️</span>
          <span>No spend in this window yet, so the numbers are zero. Leads start counting once an ad is running and the pixel's lead event is live.</span>
        </div>
      )}

      {/* Ads list */}
      {!loading && connected && (
        <div style={{ fontSize:13, color:MUTED, margin:'6px 0 8px' }}>{ads.length} {ads.length === 1 ? 'ad' : 'ads'}</div>
      )}

      {loading && <div style={{ fontSize:13, color:TERTIARY, padding:'12px 0' }}>Loading ads from Facebook…</div>}

      {!loading && connected && ads.length === 0 && (
        <div style={{ ...cardStyle, color:MUTED, fontSize:13 }}>No ads in this account yet.</div>
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
        {!loading && ads.map(ad => {
          const pill = statusPill(ad.effective_status, ad.status);
          const s = ad.stats || {};
          return (
            <div key={ad.id} style={{ ...cardStyle, display:'flex', gap:14 }}>
              <div style={{ width:84, height:84, flex:'none', borderRadius:8, background:GREY_BG, overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center' }}>
                {ad.image_url
                  ? <img src={ad.image_url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} onError={(e)=>{ e.target.style.display='none'; }} />
                  : <span style={{ color:TERTIARY, fontSize:11 }}>No image</span>}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                  <div style={{ fontWeight:500, fontSize:15, color:TEXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ad.title || ad.name}</div>
                  <span style={{ fontSize:11, padding:'3px 8px', borderRadius:6, background:pill.bg, color:pill.fg, flex:'none' }}>{pill.label}</span>
                </div>
                {(ad.body || ad.title) && (
                  <div style={{ fontSize:13, color:MUTED, margin:'4px 0 10px', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>{ad.body || ad.name}</div>
                )}
                {(ad.campaign_name || ad.adset_name) && (
                  <div style={{ fontSize:11, color:TERTIARY, marginBottom:8 }}>
                    {ad.campaign_name}{ad.campaign_name && ad.adset_name ? ' · ' : ''}{ad.adset_name}
                  </div>
                )}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8 }}>
                  {statCell('Spend', fmtMoney(s.spend))}
                  {statCell('Reach', fmtNum(s.reach))}
                  {statCell('Leads', fmtNum(s.leads))}
                  {statCell('Cost / lead', fmtMoney(s.cost_per_lead))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}
