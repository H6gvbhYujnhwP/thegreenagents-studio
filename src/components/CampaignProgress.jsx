import React, { useEffect, useState, useRef, useCallback } from 'react';

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
  const [cancelling, setCancelling] = useState(false);
  const [expandedPost, setExpanded] = useState(null);
  const [cardState, setCardState]   = useState({});
  const logsEndRef = useRef(null);

  function parsePosts(c) {
    if (c?.posts_json) {
      try { setPosts(JSON.parse(c.posts_json)); } catch (_) {}
    }
  }

  const setCard = useCallback((index, patch) => {
    setCardState(prev => ({ ...prev, [index]: { ...(prev[index] || {}), ...patch } }));
  }, []);

  useEffect(() => {
    // EventSource cannot send custom headers — pass token as query param
    const token = localStorage.getItem('studioToken') || '';
    const es = new EventSource(`/api/campaigns/progress/${campaignId}?token=${encodeURIComponent(token)}`);
    es.onerror = () => {
      setLogs(l => l.some(m => m.includes('Live updates')) ? l : [...l, 'ERROR: Live updates disconnected — page will keep polling for changes…']);
      fetch(`/api/campaigns/${campaignId}`).then(r => r.json()).then(d => { setCampaign(d); parsePosts(d); });
    };
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
        fetch(`/api/campaigns/${campaignId}`)
          .then(r => r.json())
          .then(d => { setCampaign(d); parsePosts(d); });
      }
      if (data.type === 'post_updated') {
        setLogs(l => [...l, data.message]);
        setPosts(prev => {
          const next = [...prev];
          next[data.postIndex] = data.post;
          return next;
        });
        setCard(data.postIndex, { regenImage: false, regenPost: false });
      }
      if (data.type === 'post_update_error') {
        setLogs(l => [...l, `ERROR: ${data.message}`]);
        setCard(data.postIndex, { regenImage: false, regenPost: false });
      }
      if (data.type === 'complete') {
        setFiles(data.files);
        setCampaign(prev => prev ? { ...prev, status: 'completed', stage: 'done', progress: 100, posts_deployed: data.deployed } : prev);
        fetch(`/api/campaigns/${campaignId}`)
          .then(r => r.json())
          .then(d => parsePosts(d));
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

    // Polling fallback — syncs campaign state every 8s even if SSE drops
    const pollInterval = setInterval(() => {
      fetch(`/api/campaigns/${campaignId}`)
        .then(r => r.json())
        .then(d => {
          setCampaign(prev => {
            if (!prev || prev.stage !== d.stage || prev.progress !== d.progress ||
                prev.posts_generated !== d.posts_generated || prev.images_generated !== d.images_generated) {
              parsePosts(d);
              if (d.files_json) { try { setFiles(JSON.parse(d.files_json)); } catch (_) {} }
              return d;
            }
            return prev;
          });
        })
        .catch(() => {});
    }, 8000);

    return () => { es.close(); clearInterval(pollInterval); };
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

  async function handleCancel() {
    if (!window.confirm('Cancel this campaign? Posts generated so far will be lost.')) return;
    setCancelling(true);
    try {
      await fetch(`/api/campaigns/${campaignId}/cancel`, { method: 'POST' });
    } catch (err) {
      setLogs(l => [...l, `Cancel failed: ${err.message}`]);
    }
    setCancelling(false);
  }

  async function handleRegenImage(postIndex) {
    setCard(postIndex, { regenImage: true });
    setLogs(l => [...l, `Regenerating image for post ${postIndex + 1}…`]);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/regenerate-image/${postIndex}`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        setLogs(l => [...l, `Image regen error: ${err.error}`]);
        setCard(postIndex, { regenImage: false });
      }
    } catch (err) {
      setLogs(l => [...l, `Image regen failed: ${err.message}`]);
      setCard(postIndex, { regenImage: false });
    }
  }

  async function handleRegenPost(postIndex) {
    setCard(postIndex, { regenPost: true });
    setLogs(l => [...l, `Regenerating post ${postIndex + 1} text with GPT-4o…`]);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/regenerate-post/${postIndex}`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        setLogs(l => [...l, `Post regen error: ${err.error}`]);
        setCard(postIndex, { regenPost: false });
      }
    } catch (err) {
      setLogs(l => [...l, `Post regen failed: ${err.message}`]);
      setCard(postIndex, { regenPost: false });
    }
  }

  function startEdit(postIndex, currentText) {
    setCard(postIndex, { editing: true, editText: currentText });
  }

  async function saveEdit(postIndex) {
    const text = cardState[postIndex]?.editText ?? '';
    if (!text.trim()) return;
    setCard(postIndex, { editing: false });
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/edit-post/${postIndex}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedin_post_text: text })
      });
      if (res.ok) {
        const { post } = await res.json();
        setPosts(prev => { const next = [...prev]; next[postIndex] = post; return next; });
        setLogs(l => [...l, `✓ Post ${postIndex + 1} text saved.`]);
      } else {
        const err = await res.json();
        setLogs(l => [...l, `Edit save error: ${err.error}`]);
      }
    } catch (err) {
      setLogs(l => [...l, `Edit save failed: ${err.message}`]);
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

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: '#1a1a1a', margin: 0 }}>
          {isAwaiting ? '👁️ Review posts before sending to Supergrow' :
           isDone      ? '✅ Campaign complete' :
           isFailed    ? '❌ Campaign failed' :
                         '⟳ Campaign in progress'}
        </h2>
        {isRunning && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 6 }}>
            <p style={{ fontSize: 13, color: '#888', margin: 0 }}>
              Do not close this page — this takes 20–35 minutes.
            </p>
            <button
              onClick={handleCancel}
              disabled={cancelling}
              style={{
                fontSize: 12, padding: '5px 12px', border: '0.5px solid #F7C1C1',
                borderRadius: 7, background: '#fff', color: '#E24B4A',
                cursor: cancelling ? 'not-allowed' : 'pointer', flexShrink: 0
              }}
            >
              {cancelling ? 'Cancelling…' : '✕ Cancel campaign'}
            </button>
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div style={{ background: '#fff', border: '0.5px solid #e0e0dc', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a' }}>Overall progress</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: GREEN }}>{progress}%</span>
        </div>
        <div style={{ height: 8, background: '#f0f0ec', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progress}%`, background: GREEN, borderRadius: 4, transition: 'width 0.6s ease' }} />
        </div>
      </div>

      {/* Stage pills */}
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
              <span style={{ fontSize: 18 }}>{done ? '✓' : active ? '⟳' : stage.icon}</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: done ? DARK : active ? '#7a4a00' : '#aaa' }}>
                  {stage.label}
                </div>
                {active && campaign && (
                  <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>
                    {stage.key === 'generating_images' && `${campaign.images_generated || 0}/${campaign.total_posts || 12} images`}
                    {stage.key === 'deploying' && `${campaign.posts_deployed || 0}/${campaign.total_posts || 12} sent`}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Post grid — awaiting approval or done */}
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
                <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1a1a' }}>{posts.length} posts ready for review</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
                  Edit, regenerate, or approve each post below. All posts will be saved as <strong>drafts</strong> in Supergrow.
                </div>
              </div>
              <button
                onClick={handleDeploy}
                disabled={deploying}
                style={{
                  background: deploying ? '#9FE1CB' : GREEN, color: '#fff', border: 'none',
                  padding: '11px 24px', borderRadius: 8, fontWeight: 600, fontSize: 13,
                  cursor: deploying ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', flexShrink: 0
                }}
              >
                {deploying ? 'Sending…' : `Send ${posts.length} drafts to Supergrow for client approval`}
              </button>
            </div>
          )}

          {/* Done banner */}
          {isDone && (
            <div style={{
              background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 10,
              padding: '12px 16px', marginBottom: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: DARK }}>
                ✓ {campaign.posts_deployed} drafts sent to Supergrow — waiting for client approval in Kanban
              </span>
              <button
                onClick={handleDeploy}
                disabled={deploying}
                style={{
                  fontSize: 12, fontWeight: 500, padding: '6px 14px',
                  background: deploying ? '#9FE1CB' : '#fff',
                  color: DARK, border: `1px solid ${BORDER}`,
                  borderRadius: 7, cursor: deploying ? 'not-allowed' : 'pointer', flexShrink: 0
                }}
              >
                {deploying ? 'Re-sending...' : 'Re-send all to Supergrow'}
              </button>
            </div>
          )}

          {/* Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
            {posts.map((post, i) => {
              const isExpanded  = expandedPost === (post.id || i);
              const cs          = cardState[i] || {};
              const isEditing   = !!cs.editing;
              const isRegenImg  = !!cs.regenImage;
              const isRegenPost = !!cs.regenPost;
              const isBusy      = isRegenImg || isRegenPost;

              return (
                <div key={post.id || i} style={{
                  background: '#fff', border: '0.5px solid #e0e0dc', borderRadius: 12,
                  overflow: 'hidden', display: 'flex', flexDirection: 'column',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
                  opacity: isBusy ? 0.7 : 1, transition: 'opacity 0.3s'
                }}>

                  {/* Image */}
                  <div style={{ position: 'relative' }}>
                    {post.image_url
                      ? <img src={post.image_url} alt={`Post ${i + 1}`} style={{ width: '100%', height: 'auto', maxHeight: 300, objectFit: 'contain', background: '#f5f5f3', display: 'block' }} onError={e => { e.target.style.display = 'none'; }} />
                      : <div style={{ height: 80, background: '#f5f5f3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ fontSize: 11, color: '#bbb' }}>No image generated</span></div>
                    }
                    {isRegenImg && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.80)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6 }}>
                        <div style={{ width: 24, height: 24, border: `2px solid ${GREEN}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                        <span style={{ fontSize: 11, color: DARK, fontWeight: 500 }}>Generating…</span>
                      </div>
                    )}
                    {isAwaiting && !isBusy && (
                      <button onClick={() => handleRegenImage(i)} title="Regenerate image"
                        style={{ position: 'absolute', bottom: 8, right: 8, background: 'rgba(255,255,255,0.92)', border: '1px solid #ddd', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: '#333' }}>
                        🔄 New image
                      </button>
                    )}
                  </div>

                  {/* Body */}
                  <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#1a1a1a' }}>Post {i + 1}</div>
                        <div style={{ fontSize: 10, color: '#999', marginTop: 1 }}>{[post.content_pillar, post.format].filter(Boolean).join(' · ')}</div>
                        {(post.suggested_day || post.suggested_time) && (
                          <div style={{ fontSize: 10, color: GREEN, marginTop: 2 }}>📅 {post.suggested_day} {post.suggested_time}</div>
                        )}
                      </div>
                      {isDone && post.supergrow_app_url && (
                        <a href={post.supergrow_app_url} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 11, color: GREEN, textDecoration: 'none', fontWeight: 600, background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '3px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          View in Supergrow →
                        </a>
                      )}
                    </div>

                    <div style={{ fontSize: 12, fontWeight: 600, color: '#333', marginBottom: 6 }}>{post.topic}</div>

                    {isEditing ? (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <textarea
                          value={cs.editText || ''}
                          onChange={e => setCard(i, { editText: e.target.value })}
                          style={{ flex: 1, minHeight: 200, fontSize: 11, lineHeight: 1.6, padding: 8, border: `1px solid ${GREEN}`, borderRadius: 6, resize: 'vertical', fontFamily: 'inherit', color: '#333', outline: 'none' }}
                          autoFocus
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => saveEdit(i)} style={{ flex: 1, fontSize: 11, fontWeight: 600, padding: '6px 0', background: GREEN, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>✓ Save</button>
                          <button onClick={() => setCard(i, { editing: false })} style={{ fontSize: 11, padding: '6px 10px', background: '#f5f5f3', color: '#555', border: '1px solid #ddd', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{
                          fontSize: 11, color: '#555', lineHeight: 1.6, flex: 1,
                          maxHeight: isExpanded ? 'none' : 96, overflow: 'hidden',
                          maskImage: isExpanded ? 'none' : 'linear-gradient(to bottom, black 50%, transparent 100%)',
                          WebkitMaskImage: isExpanded ? 'none' : 'linear-gradient(to bottom, black 50%, transparent 100%)',
                          whiteSpace: 'pre-wrap'
                        }}>
                          {post.linkedin_post_text}
                        </div>
                        <button onClick={() => setExpanded(isExpanded ? null : (post.id || i))}
                          style={{ marginTop: 8, fontSize: 11, color: GREEN, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', fontWeight: 500 }}>
                          {isExpanded ? '▲ Collapse' : '▼ Read full post'}
                        </button>
                      </>
                    )}

                    {/* Action buttons */}
                    {(isAwaiting || isDone) && !isEditing && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 10, borderTop: '1px solid #f0f0ec', paddingTop: 10 }}>
                        <button onClick={() => startEdit(i, post.linkedin_post_text)} disabled={isBusy}
                          style={{ flex: 1, fontSize: 11, padding: '5px 0', background: '#f5f5f3', border: '1px solid #ddd', borderRadius: 6, cursor: isBusy ? 'not-allowed' : 'pointer', color: '#333' }}>
                          ✏️ Edit text
                        </button>
                        <button onClick={() => handleRegenPost(i)} disabled={isBusy}
                          style={{ flex: 1, fontSize: 11, padding: '5px 0', background: '#f5f5f3', border: '1px solid #ddd', borderRadius: 6, cursor: isBusy ? 'not-allowed' : 'pointer', color: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                          {isRegenPost
                            ? <><span style={{ width: 12, height: 12, border: `1.5px solid ${GREEN}`, borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} /> Writing…</>
                            : '🔄 Rewrite post'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Download files */}
      {isDone && files && (
        <div style={{ background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 10 }}>Download output files</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.keys(files).map(name => (
              <button key={name} onClick={() => downloadFile(name, files[name])}
                style={{ fontSize: 11, padding: '5px 12px', border: `1px solid ${DARK}`, borderRadius: 6, background: '#fff', color: DARK, cursor: 'pointer' }}>
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {isFailed && (
        <div style={{ background: '#FCEBEB', border: '1px solid #F7C1C1', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#501313' }}>Campaign failed</div>
          <div style={{ fontSize: 12, color: '#791F1F', marginTop: 4 }}>{campaign.error_log}</div>
        </div>
      )}

      {/* Log terminal */}
      <div style={{ background: '#111', borderRadius: 10, padding: '14px 16px', fontFamily: '"Menlo","Monaco","Consolas",monospace', fontSize: 11.5, color: '#9FE1CB', maxHeight: 240, overflow: 'auto', border: '1px solid #2a2a2a' }}>
        <div style={{ color: '#444', marginBottom: 6, fontSize: 10, letterSpacing: '0.05em' }}>CAMPAIGN LOG</div>
        {logs.length === 0
          ? <div style={{ color: '#444' }}>Waiting for first update…</div>
          : logs.map((l, i) => (
            <div key={i} style={{ marginBottom: 3, lineHeight: 1.5, color: l.startsWith('ERROR') ? '#F09595' : l.startsWith('✓') ? '#9FE1CB' : '#7a7a7a' }}>
              <span style={{ color: '#333', userSelect: 'none' }}>{String(i + 1).padStart(2, '0')} </span>{l}
            </div>
          ))
        }
        <div ref={logsEndRef} />
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
