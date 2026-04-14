import React, { useEffect, useState, useRef } from 'react';

const STAGES = [
  { key: 'generating_posts', label: 'Generating posts', desc: 'Claude writing 96 LinkedIn posts' },
  { key: 'generating_images', label: 'Generating images', desc: 'Nano Banana creating visuals' },
  { key: 'deploying', label: 'Deploying to Supergrow', desc: 'Queuing posts via MCP' },
  { key: 'done', label: 'Complete', desc: 'Campaign deployed successfully' }
];

export default function CampaignProgress({ campaignId, onComplete }) {
  const [campaign, setCampaign] = useState(null);
  const [logs, setLogs] = useState([]);
  const [files, setFiles] = useState(null);
  const logsEndRef = useRef(null);

  useEffect(() => {
    const es = new EventSource(`/api/campaigns/progress/${campaignId}`);

    es.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.type === 'status') setCampaign(data.campaign);
      if (data.type === 'progress') setCampaign(prev => prev ? { ...prev, ...data } : data);
      if (data.type === 'log') setLogs(l => [...l.slice(-99), data.message]);
      if (data.type === 'complete') {
        setFiles(data.files);
        setCampaign(prev => prev ? { ...prev, status:'completed', stage:'done', progress:100, posts_deployed: data.deployed } : prev);
        es.close();
        if (onComplete) onComplete();
      }
      if (data.type === 'error') {
        setCampaign(prev => prev ? { ...prev, status:'failed', stage:'error' } : prev);
        setLogs(l => [...l, `ERROR: ${data.message}`]);
        es.close();
      }
    };

    fetch(`/api/campaigns/${campaignId}`)
      .then(r => r.json())
      .then(d => {
        setCampaign(d);
        if (d.files_json) setFiles(JSON.parse(d.files_json));
      });

    return () => es.close();
  }, [campaignId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior:'smooth' });
  }, [logs]);

  function downloadFile(filename, content) {
    const blob = new Blob([content], { type:'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  function downloadAll() {
    if (!files) return;
    Object.entries(files).forEach(([name, content]) => {
      setTimeout(() => downloadFile(name, content), 200);
    });
  }

  const currentStageIdx = STAGES.findIndex(s => s.key === campaign?.stage);

  return (
    <div style={{ padding:'28px', maxWidth:700 }}>
      <div style={{ marginBottom:24 }}>
        <div style={{ fontSize:16, fontWeight:500, color:'#1a1a1a', marginBottom:4 }}>Campaign in progress</div>
        <div style={{ fontSize:13, color:'#888' }}>Do not close this page. This will take 15–30 minutes.</div>
      </div>

      <div style={{ background:'#fff', border:'0.5px solid #e0e0dc', borderRadius:12, padding:20, marginBottom:16 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
          <span style={{ fontSize:13, fontWeight:500, color:'#1a1a1a' }}>Overall progress</span>
          <span style={{ fontSize:13, color:'#1D9E75', fontWeight:500 }}>{campaign?.progress || 0}%</span>
        </div>
        <div style={{ height:6, background:'#f0f0ec', borderRadius:3 }}>
          <div style={{ height:'100%', width:`${campaign?.progress || 0}%`, background:'#1D9E75', borderRadius:3, transition:'width 0.5s ease' }} />
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, marginBottom:16 }}>
        {STAGES.map((stage, i) => {
          const done = currentStageIdx > i || campaign?.stage === 'done';
          const active = campaign?.stage === stage.key;
          const waiting = currentStageIdx < i && campaign?.stage !== 'done';
          return (
            <div key={stage.key} style={{
              background: done ? '#E1F5EE' : active ? '#FAEEDA' : '#fff',
              border:`0.5px solid ${done ? '#9FE1CB' : active ? '#FAC775' : '#e0e0dc'}`,
              borderRadius:8, padding:'10px 12px'
            }}>
              <div style={{ fontSize:18, marginBottom:4 }}>{done ? '✓' : active ? '⟳' : '○'}</div>
              <div style={{ fontSize:11, fontWeight:500, color: done ? '#085041' : active ? '#633806' : '#999' }}>{stage.label}</div>
              {active && campaign && (
                <div style={{ fontSize:10, color:'#888', marginTop:2 }}>
                  {stage.key === 'generating_images' && `${campaign.images_generated || 0}/${campaign.total_posts || 96}`}
                  {stage.key === 'deploying' && `${campaign.posts_deployed || 0}/${campaign.total_posts || 96}`}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {campaign?.status === 'completed' && files && (
        <div style={{ background:'#E1F5EE', border:'0.5px solid #9FE1CB', borderRadius:10, padding:16, marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:500, color:'#085041', marginBottom:12 }}>
            Campaign complete — {campaign.posts_deployed} posts deployed to Supergrow
          </div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:12 }}>
            {Object.keys(files).map(name => (
              <button key={name} onClick={() => downloadFile(name, files[name])} style={{
                fontSize:11, padding:'4px 10px', border:'0.5px solid #0F6E56', borderRadius:6,
                background:'#fff', color:'#0F6E56', cursor:'pointer'
              }}>{name}</button>
            ))}
          </div>
          <button onClick={downloadAll} style={{
            background:'#1D9E75', color:'#fff', border:'none', padding:'8px 16px', borderRadius:8, fontSize:13, fontWeight:500, cursor:'pointer'
          }}>Download all files</button>
        </div>
      )}

      {campaign?.status === 'failed' && (
        <div style={{ background:'#FCEBEB', border:'0.5px solid #F7C1C1', borderRadius:10, padding:16, marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:500, color:'#501313' }}>Campaign failed</div>
          <div style={{ fontSize:12, color:'#791F1F', marginTop:4 }}>{campaign.error_log}</div>
        </div>
      )}

      <div style={{ background:'#1a1a1a', borderRadius:10, padding:16, fontFamily:'monospace', fontSize:11, color:'#9FE1CB', maxHeight:200, overflow:'auto' }}>
        {logs.length === 0
          ? <div style={{ color:'#555' }}>Waiting for first update...</div>
          : logs.map((l, i) => <div key={i} style={{ marginBottom:2, color: l.startsWith('ERROR') ? '#F09595' : '#9FE1CB' }}>{l}</div>)
        }
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
