import React, { useEffect, useState, useRef } from 'react';

const STAGES = [
  { key: 'generating_posts',  label: 'Writing posts',  icon: '✍️' },
  { key: 'generating_images', label: 'Images',         icon: '🖼️' },
  { key: 'awaiting_approval', label: 'Review',         icon: '👁️' },
  { key: 'deploying',         label: 'To Supergrow',   icon: '🚀' },
  { key: 'done',              label: 'Complete',       icon: '✅' },
];

const GREEN  = '#1D9E75';
const LIGHT  = '#E1F5EE';
const BORDER = '#9FE1CB';
const DARK   = '#085041';

export default function CampaignProgress({ campaignId, onComplete }) {
  const [campaign, setCampaign]     = useState(null);
  const [logs, setLogs]             = useState([]);
  const [files, setFiles]           = useState(null);
  const [posts, setPosts]           = useState([]);
  const [deploying, setDeploying]   = useState(false);
  const [expandedPost, setExpanded] = useState(null);
  const logsEndRef = useRef(null);

  function parsePosts(c) {
    if (c?.posts_json) {
      try { setPosts(JSON.parse(c.posts_json)); } catch (_) {}
    }
  }

  useEffect(() => {
    const es = new EventSource(`/api/campaigns/progress/${campaignId}`);
    es.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.type === 'status') {
        setCampaign(data.campaign);
        parsePosts(data.campaign);
        if (data.campaign?.files_json) {
          try { setFiles(JSON.parse(data.campaign.files_json)); } catch (_) {}
        }
      }
      if (data.type === 'progress') {
        setCampaign(prev => prev ? { ...prev, ...data } : data);
      }
      if (data.type === 'log') {
        setLogs(l => [...l.slice(-199), data.message]);
      }
      if (data.type === 'awaiting_approval') {
        setLogs(l => [...l, `✓ ${data.message}`]);
        // Re-fetch full campaign from DB to get posts_json (not included in SSE payload)
        fetch(`/api/campaigns/${campaignId}`)
          .then(r => r.json())
          .then(d => {
            setCampaign(d);
            parsePosts(d);
          });
      }
      if (data.type === 'complete') {
        setFiles(data.files);
        setCampaign(prev => prev ? { ...prev, status: 'completed', stage: 'done', progress: 100, posts_deployed: data.deployed } : prev);
        es.close();
        if (onComplete) onComplete();
      }
      if (data.type === 'error') {
        setCampaign(prev => prev ? { ...prev, status: 'failed', stage: 'error' } : prev);
        setLogs(l => [...l, `ERROR: ${data.message}`]);
        es.close();
      }
    };

    fetch(`/api/campaigns/${campaignId}`)
      .then(r => r.json())
      .then(d => {
        setCampaign(d);
        parsePosts(d);
        if (d.files_json) { try { setFiles(JSON.parse(d.files_json)); } catch (_) {} }
      });

    return () => es.close();
  }, [campaignId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  async function handleDeploy() {
    setDeploying(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/deploy`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        setLogs(l => [...l, `Deploy error: ${err.error}`]);
        setDeploying(false);
      }
    } catch (err) {
      setLogs(l => [...l, `Deploy failed: ${err.message}`]);
      setDeploying(false);
    }
  }

  function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  const progress      = campaign?.progress || 0;
  const currentStage  = campaign?.stage;
  const stageIdx      = STAGES.findIndex(s => s.key === currentStage);
  const isAwaiting    = currentStage === 'awaiting_approval';
  const isDone        = campaign?.status === 'completed';
  const isFailed      = campaign?.status === 'failed';
  const isRunning     = !isDone && !isFailed && !isAwaiting;

  return (
    <div style={{ padding: '24px 32px', width: '100%', boxSizing: 'border-box' }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: '#1a1a1a', margin: 0 }}>
          {isAwaiting ? '👁️ Review posts before sending to Supergrow' :
           isDone      ? '✅ Campaign complete' :
           isFailed    ? '❌ Campaign failed' :
                         '⟳ Campaign in progress'}
        </h2>
        {isRunning && (
          <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>
            Do not close this page — this takes 20–35 minutes.
          </p>
        )}
      </div>

      {/* ── Progress bar ── */}
      <div style={{ background: '#fff', border: '0.5px solid #e0e0dc', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a' }}>Overall progress</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: GREEN }}>{progress}%</span>
        </div>
        <div style={{ height: 8, background: '#f0f0ec', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${progress}%`, background: GREEN,
            borderRadius: 4, transition: 'width 0.6s ease'
          }} />
        </div>
      </div>

      {/* ── Stage pills ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {STAGES.map((stage, i) => {
          const done   = stageIdx > i || currentStage === 'done';
          const active = currentStage === stage.key;
          return (
            <div key={stage.key} style={{
              flex: '1 1 0', minWidth: 100,
              background: done ? LIGHT : active ? '#FFFBF0' : '#fafafa',
              border: `1px solid ${done ? BORDER : active ? '#FAC775' : '#e8e8e4'}`,
              borderRadius: 8, padding: '10px 14px',
              display: 'flex', alignItems: 'center', gap: 8
            }}>
              <span style={{ fontSize: 18 }}>
                {done ? '✓' : active ? '⟳' : stage.icon}
              </span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: done ? DARK : active ? '#7a4a00' : '#aaa' }}>
                  {stage.label}
                </div>
                {active && campaign && (
                  <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>
                    {stage.key === 'generating_images' && `${campaign.images_generated || 0}/${campaign.total_posts || 12} images`}
                    {stage.key === 'deploying'         && `${campaign.posts_deployed || 0}/${campaign.total_posts || 12} sent`}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Post preview grid (awaiting approval or done) ── */}
      {(isAwaiting || isDone) && posts.length > 0 && (
        <div style={{ marginBottom: 24 }}>

          {/* Deploy banner */}
          {isAwaiting && (
            <div style={{
              background: '#FFFBF0', border: '1px solid #FAC775', borderRadius: 10,
              padding: '16px 20px', marginBottom: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap'
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1a1a' }}>
                  {posts.length} posts ready for review
                </div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
                  All posts will be saved as <strong>drafts</strong> in Supergrow.
                  Your client approves them in the Kanban board before anything goes live on LinkedIn.
                </div>
              </div>
              <button
                onClick={handleDeploy}
                disabled={deploying}
                style={{
                  background: deploying ? '#9FE1CB' : GREEN, color: '#fff', border: 'none',
                  padding: '11px 24px', borderRadius: 8, fontWeight: 600, fontSize: 13,
                  cursor: deploying ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                  flexShrink: 0
                }}
              >
                {deploying ? 'Sending…' : `Send ${posts.length} Drafts to Supergrow →`}
              </button>
            </div>
          )}

          {/* Post cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
            {posts.map((post, i) => {
              const isExpanded  = expandedPost === (post.id || i);
              const score       = post.quality_score;
              const scoreColor  = score == null ? '#ccc' : score >= 70 ? GREEN : score >= 50 ? '#e67e22' : '#e74c3c';
              return (
                <div key={post.id || i} style={{
                  background: '#fff', border: '0.5px solid #e0e0dc', borderRadius: 12,
                  overflow: 'hidden', display: 'flex', flexDirection: 'column',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.05)'
                }}>
                  {/* Image */}
                  {post.image_url ? (
                    <img src={post.image_url} alt={`Post ${i + 1}`}
                      style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block' }}
                      onError={e => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    <div style={{ height: 80, background: '#f5f5f3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: 11, color: '#bbb' }}>Generating image…</span>
                    </div>
                  )}

                  {/* Body */}
                  <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                    {/* Top row */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#1a1a1a' }}>Post {i + 1}</div>
                        <div style={{ fontSize: 10, color: '#999', marginTop: 1 }}>
                          {[post.content_pillar, post.format].filter(Boolean).join(' · ')}
                        </div>
                        {(post.suggested_day || post.suggested_time) && (
                          <div style={{ fontSize: 10, color: GREEN, marginTop: 2 }}>
                            📅 {post.suggested_day} {post.suggested_time}
                          </div>
                        )}
                      </div>
                      {score != null && (
                        <span style={{
                          fontSize: 11, fontWeight: 700, color: scoreColor,
                          background: `${scoreColor}18`, border: `1px solid ${scoreColor}40`,
                          borderRadius: 20, padding: '2px 9px', whiteSpace: 'nowrap'
                        }}>
                          {score}/100{post.quality_score_fixed ? ' ✦' : ''}
                        </span>
                      )}
                    </div>

                    {/* Topic */}
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#333', marginBottom: 6 }}>
                      {post.topic}
                    </div>

                    {/* Post text */}
                    <div style={{
                      fontSize: 11, color: '#555', lineHeight: 1.6, flex: 1,
                      maxHeight: isExpanded ? 'none' : 96, overflow: 'hidden',
                      maskImage: isExpanded ? 'none' : 'linear-gradient(to bottom, black 50%, transparent 100%)',
                      WebkitMaskImage: isExpanded ? 'none' : 'linear-gradient(to bottom, black 50%, transparent 100%)',
                      whiteSpace: 'pre-wrap'
                    }}>
                      {post.linkedin_post_text}
                    </div>

                    <button
                      onClick={() => setExpanded(isExpanded ? null : (post.id || i))}
                      style={{ marginTop: 8, fontSize: 11, color: GREEN, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', fontWeight: 500 }}
                    >
                      {isExpanded ? '▲ Collapse' : '▼ Read full post'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Complete banner ── */}
      {isDone && files && (
        <div style={{ background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: DARK, marginBottom: 12 }}>
            ✓ {campaign.posts_deployed} drafts sent to Supergrow — waiting for client approval
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.keys(files).map(name => (
              <button key={name} onClick={() => downloadFile(name, files[name])} style={{
                fontSize: 11, padding: '5px 12px', border: `1px solid ${DARK}`,
                borderRadius: 6, background: '#fff', color: DARK, cursor: 'pointer'
              }}>{name}</button>
            ))}
          </div>
        </div>
      )}

      {/* ── Error banner ── */}
      {isFailed && (
        <div style={{ background: '#FCEBEB', border: '1px solid #F7C1C1', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#501313' }}>Campaign failed</div>
          <div style={{ fontSize: 12, color: '#791F1F', marginTop: 4 }}>{campaign.error_log}</div>
        </div>
      )}

      {/* ── Live log terminal ── */}
      <div style={{
        background: '#111', borderRadius: 10, padding: '14px 16px',
        fontFamily: '"Menlo", "Monaco", "Consolas", monospace', fontSize: 11.5,
        color: '#9FE1CB', maxHeight: 240, overflow: 'auto',
        border: '1px solid #2a2a2a'
      }}>
        <div style={{ color: '#444', marginBottom: 6, fontSize: 10, letterSpacing: '0.05em' }}>CAMPAIGN LOG</div>
        {logs.length === 0
          ? <div style={{ color: '#444' }}>Waiting for first update…</div>
          : logs.map((l, i) => (
            <div key={i} style={{
              marginBottom: 3, lineHeight: 1.5,
              color: l.startsWith('ERROR') ? '#F09595' : l.startsWith('✓') ? '#9FE1CB' : '#7a7a7a'
            }}>
              <span style={{ color: '#333', userSelect: 'none' }}>{String(i + 1).padStart(2, '0')} </span>
              {l}
            </div>
          ))
        }
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
