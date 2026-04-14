import React, { useState, useEffect } from 'react';
import CampaignProgress from './CampaignProgress.jsx';
import NewClientModal from './NewClientModal.jsx';

export default function ClientDetail({ clientId, onBack, onRefresh }) {
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeCampaignId, setActiveCampaignId] = useState(null);
  const [showEdit, setShowEdit] = useState(false);
  const [starting, setStarting] = useState(false);
  const [newRag, setNewRag] = useState(null);
  const [uploadingRag, setUploadingRag] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/clients/${clientId}`);
    if (res.ok) setClient(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, [clientId]);

  const [deleting, setDeleting] = useState(false);

  async function deleteClient() {
    if (!window.confirm(`Delete ${client.name}? This will also delete all campaign history. This cannot be undone.`)) return;
    setDeleting(true);
    await fetch(`/api/clients/${clientId}`, { method: 'DELETE' });
    onRefresh();
    onBack();
  }

  async function startCampaign() {
    setStarting(true);
    const res = await fetch(`/api/campaigns/start/${clientId}`, { method:'POST' });
    const data = await res.json();
    setStarting(false);
    if (res.ok) setActiveCampaignId(data.campaignId);
    else alert(data.error || 'Failed to start campaign');
  }

  async function uploadNewRag() {
    if (!newRag) return;
    setUploadingRag(true);
    const fd = new FormData();
    fd.append('rag', newRag);
    Object.entries(client).forEach(([k,v]) => { if (typeof v === 'string') fd.append(k,v); });
    await fetch(`/api/clients/${clientId}`, { method:'PUT', body: fd });
    setNewRag(null);
    setUploadingRag(false);
    load();
  }

  if (loading) return <div style={{ padding:40, color:'#888' }}>Loading...</div>;
  if (!client) return <div style={{ padding:40, color:'#888' }}>Client not found</div>;

  if (activeCampaignId) {
    return (
      <div style={{ flex:1, overflow:'auto' }}>
        <div style={{ padding:'20px 28px', borderBottom:'0.5px solid #e0e0dc', display:'flex', alignItems:'center', gap:16, background:'#fff' }}>
          <button onClick={() => { setActiveCampaignId(null); load(); }} style={{ background:'none', border:'none', color:'#888', cursor:'pointer', fontSize:13 }}>← Back</button>
          <span style={{ fontSize:15, fontWeight:500 }}>{client.name}</span>
        </div>
        <CampaignProgress campaignId={activeCampaignId} onComplete={() => { load(); onRefresh(); }} />
      </div>
    );
  }

  return (
    <div style={{ flex:1, overflow:'auto' }}>
      <div style={{ padding:'20px 28px', borderBottom:'0.5px solid #e0e0dc', display:'flex', alignItems:'center', justifyContent:'space-between', background:'#fff', position:'sticky', top:0, zIndex:10 }}>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <button onClick={onBack} style={{ background:'none', border:'none', color:'#888', cursor:'pointer', fontSize:13 }}>← All clients</button>
          <span style={{ fontSize:15, fontWeight:500, color:'#1a1a1a' }}>{client.name}</span>
          <span style={{ fontSize:12, color:'#888' }}>{client.brand}</span>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={() => setShowEdit(true)} style={{ padding:'7px 14px', border:'0.5px solid #d0d0cc', borderRadius:8, background:'#fff', color:'#555', fontSize:13 }}>Edit client</button>
          <button onClick={deleteClient} disabled={deleting} style={{ padding:'7px 14px', border:'0.5px solid #F7C1C1', borderRadius:8, background:'#fff', color:'#E24B4A', fontSize:13 }}>
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
          <button
            onClick={startCampaign}
            disabled={starting || !client.rag_content}
            style={{ padding:'7px 18px', background: client.rag_content ? '#1D9E75' : '#ccc', color:'#fff', border:'none', borderRadius:8, fontWeight:500, fontSize:13 }}
          >
            {starting ? 'Starting...' : '▶ Run campaign'}
          </button>
        </div>
      </div>

      <div style={{ padding:28 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, marginBottom:24 }}>
          <div style={{ background:'#fff', border:'0.5px solid #e0e0dc', borderRadius:10, padding:18 }}>
            <div style={{ fontSize:11, fontWeight:500, color:'#999', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:14 }}>Client info</div>
            {[
              ['Website', client.website],
              ['Timezone', client.timezone],
              ['Cadence', client.cadence],
              ['Posting identity', client.posting_identity === 'personal' ? 'Personal profile' : 'Company page'],
              ['Approval mode', client.approval_mode === 'auto' ? 'Auto queue' : 'Drafts only'],
            ].map(([k,v]) => (
              <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:'0.5px solid #f0f0ec', fontSize:13 }}>
                <span style={{ color:'#888' }}>{k}</span>
                <span style={{ color:'#1a1a1a', fontWeight:500 }}>{v || '—'}</span>
              </div>
            ))}
          </div>

          <div style={{ background:'#fff', border:'0.5px solid #e0e0dc', borderRadius:10, padding:18 }}>
            <div style={{ fontSize:11, fontWeight:500, color:'#999', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:14 }}>Supergrow</div>
            {[
              ['Workspace', client.supergrow_workspace_name],
              ['Workspace ID', client.supergrow_workspace_id?.slice(0,8) + '...'],
            ].map(([k,v]) => (
              <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:'0.5px solid #f0f0ec', fontSize:13 }}>
                <span style={{ color:'#888' }}>{k}</span>
                <span style={{ color:'#1a1a1a', fontWeight:500 }}>{v || '—'}</span>
              </div>
            ))}

            <div style={{ marginTop:16 }}>
              <div style={{ fontSize:12, color:'#555', marginBottom:8, fontWeight:500 }}>RAG document</div>
              {client.rag_filename ? (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', background:'#f5f5f3', borderRadius:7, padding:'8px 12px' }}>
                  <span style={{ fontSize:12, color:'#1D9E75', fontWeight:500 }}>{client.rag_filename}</span>
                  <label style={{ fontSize:11, color:'#888', cursor:'pointer' }}>
                    Replace
                    <input type="file" accept=".md,.txt,.pdf" onChange={e => setNewRag(e.target.files[0])} style={{ display:'none' }} />
                  </label>
                </div>
              ) : (
                <label style={{ display:'block', border:'0.5px dashed #d0d0cc', borderRadius:7, padding:'10px 12px', textAlign:'center', cursor:'pointer', fontSize:12, color:'#888' }}>
                  Upload RAG document
                  <input type="file" accept=".md,.txt,.pdf" onChange={e => setNewRag(e.target.files[0])} style={{ display:'none' }} />
                </label>
              )}
              {newRag && (
                <div style={{ marginTop:8, display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:12, color:'#1D9E75' }}>{newRag.name}</span>
                  <button onClick={uploadNewRag} disabled={uploadingRag} style={{ fontSize:11, padding:'3px 10px', background:'#1D9E75', color:'#fff', border:'none', borderRadius:6, cursor:'pointer' }}>
                    {uploadingRag ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={() => setNewRag(null)} style={{ fontSize:11, padding:'3px 8px', background:'none', border:'0.5px solid #d0d0cc', borderRadius:6, cursor:'pointer', color:'#888' }}>×</button>
                </div>
              )}
              {!client.rag_content && (
                <div style={{ fontSize:11, color:'#E24B4A', marginTop:6 }}>RAG document required before running a campaign</div>
              )}
            </div>
          </div>
        </div>

        <div style={{ fontSize:11, fontWeight:500, color:'#999', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:12 }}>Campaign history</div>

        {!client.campaigns?.length ? (
          <div style={{ background:'#fff', border:'0.5px dashed #d0d0cc', borderRadius:10, padding:'32px', textAlign:'center', color:'#888', fontSize:13 }}>
            No campaigns run yet
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {client.campaigns.map(c => (
              <CampaignRow key={c.id} campaign={c} onView={() => setActiveCampaignId(c.id)} />
            ))}
          </div>
        )}
      </div>

      {showEdit && (
        <NewClientModal
          existing={client}
          onClose={() => setShowEdit(false)}
          onCreated={() => { setShowEdit(false); load(); onRefresh(); }}
        />
      )}
    </div>
  );
}

function CampaignRow({ campaign, onView }) {
  const STATUS = {
    completed: { label:'Deployed', bg:'#E1F5EE', color:'#085041' },
    running:   { label:'Running', bg:'#FAEEDA', color:'#633806' },
    failed:    { label:'Failed', bg:'#FCEBEB', color:'#501313' },
    pending:   { label:'Queued', bg:'#E6F1FB', color:'#0C447C' }
  };
  const cfg = STATUS[campaign.status] || STATUS.pending;
  const date = new Date(campaign.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });

  return (
    <div style={{ background:'#fff', border:'0.5px solid #e0e0dc', borderRadius:8, padding:'12px 16px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
      <div style={{ display:'flex', alignItems:'center', gap:16 }}>
        <span style={{ fontSize:11, padding:'3px 9px', borderRadius:20, background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
        <span style={{ fontSize:13, color:'#888' }}>{date}</span>
        {campaign.posts_deployed > 0 && <span style={{ fontSize:12, color:'#1a1a1a' }}>{campaign.posts_deployed} posts deployed</span>}
        {campaign.images_generated > 0 && <span style={{ fontSize:12, color:'#888' }}>{campaign.images_generated} images</span>}
      </div>
      {(campaign.status === 'running' || campaign.status === 'completed' || campaign.status === 'failed') && (
        <button onClick={onView} style={{ fontSize:12, color:'#1D9E75', background:'none', border:'none', cursor:'pointer', padding:0 }}>
          {campaign.status === 'running' ? 'View progress →' : 'View results →'}
        </button>
      )}
    </div>
  );
}
