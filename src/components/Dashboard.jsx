import React, { useState, useEffect } from 'react';
import Sidebar from './Sidebar.jsx';
import ClientCard from './ClientCard.jsx';
import NewClientModal from './NewClientModal.jsx';
import ClientDetail from './ClientDetail.jsx';

export default function Dashboard({ onLogout }) {
  const [clients, setClients] = useState([]);
  const [view, setView] = useState('dashboard');
  const [selectedClient, setSelectedClient] = useState(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [loading, setLoading] = useState(true);

  async function loadClients() {
    setLoading(true);
    const res = await fetch('/api/clients');
    if (res.ok) setClients(await res.json());
    setLoading(false);
  }

  useEffect(() => { loadClients(); }, []);

  const totalPosts = clients.reduce((acc, c) => acc + (c.campaign_count || 0) * 96, 0);
  const activeRuns = clients.filter(c => c.last_status === 'running').length;

  if (selectedClient) {
    return (
      <div style={{ display:'flex', height:'100vh', background:'#f5f5f3' }}>
        <Sidebar onLogout={onLogout} activeView="clients" onNavigate={v => { setView(v); setSelectedClient(null); }} />
        <ClientDetail
          clientId={selectedClient}
          onBack={() => setSelectedClient(null)}
          onRefresh={loadClients}
        />
      </div>
    );
  }

  return (
    <div style={{ display:'flex', height:'100vh', background:'#f5f5f3' }}>
      <Sidebar onLogout={onLogout} activeView={view} onNavigate={setView} />

      <div style={{ flex:1, overflow:'auto', padding:28 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
          <h1 style={{ fontSize:20, fontWeight:500, color:'#1a1a1a' }}>Dashboard</h1>
          <button
            onClick={() => setShowNewClient(true)}
            style={{ background:'#1D9E75', color:'#fff', border:'none', padding:'8px 18px', borderRadius:8, fontWeight:500 }}
          >
            + New client
          </button>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:28 }}>
          {[
            { label:'Total clients', value: clients.length, sub: `${activeRuns} active run${activeRuns !== 1 ? 's' : ''}` },
            { label:'Posts queued', value: totalPosts.toLocaleString(), sub: 'all time' },
            { label:'Images generated', value: totalPosts.toLocaleString(), sub: 'via Nano Banana' },
            { label:'Campaigns run', value: clients.reduce((a,c) => a + (c.campaign_count || 0), 0), sub: 'all time' }
          ].map(s => (
            <div key={s.label} style={{ background:'#fff', border:'0.5px solid #e0e0dc', borderRadius:8, padding:'14px 16px' }}>
              <div style={{ fontSize:12, color:'#888', marginBottom:4 }}>{s.label}</div>
              <div style={{ fontSize:26, fontWeight:500, color:'#1a1a1a' }}>{s.value}</div>
              <div style={{ fontSize:11, color:'#1D9E75', marginTop:3 }}>{s.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize:11, fontWeight:500, color:'#999', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:12 }}>
          Clients
        </div>

        {loading ? (
          <div style={{ color:'#888', padding:'40px 0', textAlign:'center' }}>Loading...</div>
        ) : clients.length === 0 ? (
          <div style={{ background:'#fff', border:'0.5px dashed #d0d0cc', borderRadius:12, padding:'48px', textAlign:'center' }}>
            <div style={{ fontSize:15, color:'#888', marginBottom:12 }}>No clients yet</div>
            <button onClick={() => setShowNewClient(true)} style={{ background:'#1D9E75', color:'#fff', border:'none', padding:'8px 18px', borderRadius:8, fontWeight:500 }}>
              Add your first client
            </button>
          </div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:12 }}>
            {clients.map(client => (
              <ClientCard
                key={client.id}
                client={client}
                onClick={() => setSelectedClient(client.id)}
              />
            ))}
          </div>
        )}
      </div>

      {showNewClient && (
        <NewClientModal
          onClose={() => setShowNewClient(false)}
          onCreated={() => { setShowNewClient(false); loadClients(); }}
        />
      )}
    </div>
  );
}
