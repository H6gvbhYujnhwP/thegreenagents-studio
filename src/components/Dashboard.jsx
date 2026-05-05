import React, { useState, useEffect } from 'react';
import Sidebar from './Sidebar.jsx';
import ClientCard from './ClientCard.jsx';
import NewClientModal from './NewClientModal.jsx';
import ClientDetail from './ClientDetail.jsx';
import EmailSection from './EmailSection.jsx';

export default function Dashboard({ onLogout }) {
  const [clients, setClients]           = useState([]);
  const [view, setView]                 = useState('clients');
  const [selectedClient, setSelectedClient] = useState(null);
  const [showNewClient, setShowNewClient]   = useState(false);
  const [loading, setLoading]           = useState(true);
  const [brief, setBrief]               = useState(null);
  const [briefRunning, setBriefRunning] = useState(false);
  const [briefUpdatedAt, setBriefUpdatedAt] = useState(null);
  const [showBrief, setShowBrief]       = useState(false);

  async function loadClients() {
    setLoading(true);
    try {
      const res = await fetch('/api/clients');
      if (res.ok) setClients(await res.json());
    } catch (e) { console.error('loadClients error:', e); }
    setLoading(false);
  }

  async function loadBrief() {
    try {
      const res = await fetch('/api/algorithm/brief');
      if (res.ok) {
        const data = await res.json();
        setBrief(data.brief);
        setBriefRunning(data.running);
        setBriefUpdatedAt(data.updatedAt);
      }
    } catch (e) { console.warn('loadBrief error:', e.message); }
  }

  async function runAnalysis() {
    setBriefRunning(true);
    try {
      await fetch('/api/algorithm/run', { method: 'POST' });
      // Poll every 5 seconds until complete
      const poll = setInterval(async () => {
        const res = await fetch('/api/algorithm/brief');
        if (res.ok) {
          const data = await res.json();
          if (!data.running) {
            setBrief(data.brief);
            setBriefRunning(false);
            setBriefUpdatedAt(data.updatedAt);
            clearInterval(poll);
          }
        }
      }, 5000);
    } catch (e) {
      setBriefRunning(false);
      console.error('runAnalysis error:', e.message);
    }
  }

  async function syncAndLoad() {
    try {
      const res = await fetch('/api/clients/sync', { method:'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.added > 0) console.log(`[sync] Added ${data.added} new workspace(s)`);
      }
    } catch (e) { console.warn('[sync] sync request failed:', e.message); }
    await loadClients();
  }

  useEffect(()=>{ syncAndLoad(); loadBrief(); }, []);

  function handleNavigate(v) {
    setView(v);
    setSelectedClient(null);
  }

  // ── Email Campaigns views ──────────────────────────────────────────────────
  if (view === 'email-customers' || view === 'email-domain-health' || view === 'email-mailboxes') {
    const initialTab = view === 'email-domain-health' ? 'domains'
                     : view === 'email-mailboxes'     ? 'mailboxes'
                     : 'customers';
    return (
      <div style={{ display:'flex', height:'100vh', background:'#f5f5f3' }}>
        <Sidebar onLogout={onLogout} activeView={view} onNavigate={handleNavigate} />
        <EmailSection initialTab={initialTab} />
      </div>
    );
  }

  // ── Client detail view ────────────────────────────────────────────────────
  if (selectedClient) {
    return (
      <div style={{ display:'flex', height:'100vh', background:'#f5f5f3' }}>
        <Sidebar onLogout={onLogout} activeView="clients" onNavigate={handleNavigate} />
        <ClientDetail clientId={selectedClient} onBack={()=>setSelectedClient(null)} onRefresh={loadClients} />
      </div>
    );
  }

  // ── Social Media Posts (Supergrow) ────────────────────────────────────────
  const totalPosts = clients.reduce((acc,c)=>acc+(c.campaign_count||0)*96, 0);
  const activeRuns = clients.filter(c=>c.last_status==='running').length;

  return (
    <div style={{ display:'flex', height:'100vh', background:'#f5f5f3' }}>
      <Sidebar onLogout={onLogout} activeView={view} onNavigate={handleNavigate} />

      <div style={{ flex:1, overflow:'auto', padding:28 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
          <h1 style={{ fontSize:20, fontWeight:500, color:'#1a1a1a' }}>Supergrow</h1>
          <div style={{ display:'flex', gap:8 }}>
            <button
              onClick={briefRunning ? null : runAnalysis}
              disabled={briefRunning}
              title={briefUpdatedAt ? `Last updated: ${new Date(briefUpdatedAt).toLocaleString('en-GB')}` : 'No brief yet — click to run'}
              style={{
                background: briefRunning ? '#f0f0ec' : brief ? '#E1F5EE' : '#fff',
                color: briefRunning ? '#999' : brief ? '#085041' : '#555',
                border: `0.5px solid ${brief ? '#9FE1CB' : '#d0d0cc'}`,
                padding:'8px 14px', borderRadius:8, fontWeight:500, cursor: briefRunning ? 'not-allowed' : 'pointer',
                fontSize:13, display:'flex', alignItems:'center', gap:6
              }}
            >
              {briefRunning ? (
                <><span style={{ width:12, height:12, border:'1.5px solid #1D9E75', borderTopColor:'transparent', borderRadius:'50%', display:'inline-block', animation:'spin 0.8s linear infinite' }} /> Running analysis...</>
              ) : brief ? (
                <span onClick={e => { e.stopPropagation(); setShowBrief(true); }}>
                  ✓ Algorithm brief {briefUpdatedAt ? `(${new Date(briefUpdatedAt).toLocaleDateString('en-GB', {day:'numeric',month:'short'})})` : ''} — click to view
                </span>
              ) : (
                'Run weekly LinkedIn analysis'
              )}
            </button>
            <button onClick={()=>setShowNewClient(true)} style={{ background:'#1D9E75', color:'#fff', border:'none', padding:'8px 18px', borderRadius:8, fontWeight:500, cursor:'pointer' }}>
              + New client
            </button>
          </div>
        </div>

        {/* Algorithm Brief Modal */}
        {showBrief && brief && (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}
               onClick={() => setShowBrief(false)}>
            <div style={{ background:'#fff', borderRadius:12, padding:28, width:'min(720px, 90vw)', maxHeight:'80vh', overflow:'auto', boxShadow:'0 4px 24px rgba(0,0,0,0.15)' }}
                 onClick={e => e.stopPropagation()}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
                <div style={{ fontSize:15, fontWeight:600, color:'#1a1a1a' }}>LinkedIn Algorithm Brief</div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  {briefUpdatedAt && <span style={{ fontSize:11, color:'#888' }}>Updated {new Date(briefUpdatedAt).toLocaleString('en-GB')}</span>}
                  <button onClick={() => runAnalysis()} disabled={briefRunning} style={{ fontSize:12, padding:'5px 12px', background:'#1D9E75', color:'#fff', border:'none', borderRadius:6, cursor:'pointer' }}>
                    Refresh
                  </button>
                  <button onClick={() => setShowBrief(false)} style={{ fontSize:12, padding:'5px 10px', background:'#f5f5f3', border:'0.5px solid #d0d0cc', borderRadius:6, cursor:'pointer', color:'#555' }}>
                    Close
                  </button>
                </div>
              </div>
              <pre style={{ fontSize:12, lineHeight:1.7, whiteSpace:'pre-wrap', color:'#333', fontFamily:'inherit' }}>{brief}</pre>
            </div>
          </div>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:28 }}>
          {[
            { label:'Total clients',      value:clients.length, sub:`${activeRuns} active run${activeRuns!==1?'s':''}` },
            { label:'Posts queued',       value:totalPosts.toLocaleString(), sub:'all time' },
            { label:'Images generated',   value:totalPosts.toLocaleString(), sub:'via Nano Banana' },
            { label:'Campaigns run',      value:clients.reduce((a,c)=>a+(c.campaign_count||0),0), sub:'all time' }
          ].map(s=>(
            <div key={s.label} style={{ background:'#fff', border:'0.5px solid #e0e0dc', borderRadius:8, padding:'14px 16px' }}>
              <div style={{ fontSize:12, color:'#888', marginBottom:4 }}>{s.label}</div>
              <div style={{ fontSize:26, fontWeight:500, color:'#1a1a1a' }}>{s.value}</div>
              <div style={{ fontSize:11, color:'#1D9E75', marginTop:3 }}>{s.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize:11, fontWeight:500, color:'#999', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:12 }}>Clients</div>

        {loading ? (
          <div style={{ color:'#888', padding:'40px 0', textAlign:'center' }}>Loading...</div>
        ) : clients.length === 0 ? (
          <div style={{ background:'#fff', border:'0.5px dashed #d0d0cc', borderRadius:12, padding:48, textAlign:'center' }}>
            <div style={{ fontSize:15, color:'#888', marginBottom:12 }}>No clients yet</div>
            <button onClick={()=>setShowNewClient(true)} style={{ background:'#1D9E75', color:'#fff', border:'none', padding:'8px 18px', borderRadius:8, fontWeight:500, cursor:'pointer' }}>
              Add your first client
            </button>
          </div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:12 }}>
            {clients.map(client=>(
              <ClientCard key={client.id} client={client} onClick={()=>setSelectedClient(client.id)} />
            ))}
          </div>
        )}
      </div>

      {showNewClient && (
        <NewClientModal onClose={()=>setShowNewClient(false)} onCreated={()=>{ setShowNewClient(false); loadClients(); }} />
      )}
    </div>
  );
}
