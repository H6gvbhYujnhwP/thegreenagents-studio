import React, { useEffect, useState, useRef } from 'react';

const STAGES = [
  { key: 'generating_posts',  label: 'Writing posts',   desc: 'GPT-4o generating LinkedIn posts' },
  { key: 'scoring_posts',     label: 'Quality gate',    desc: 'Scoring & auto-fixing posts' },
  { key: 'generating_images', label: 'Images',          desc: 'Nano Banana creating visuals' },
  { key: 'awaiting_approval', label: 'Review',          desc: 'Operator reviews before sending' },
  { key: 'deploying',         label: 'Sending drafts',  desc: 'Posting to Supergrow as drafts' },
  { key: 'done',              label: 'Complete',        desc: 'All drafts in Supergrow' },
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

  // ── Parse posts_json whenever campaign updates ─────────────────────────────
  function parsePosts(campaignObj) {
    if (campaignObj?.posts_json) {
      try { setPosts(JSON.parse(campaignObj.posts_json)); } catch (_) {}
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
        setLogs(l => [...l.slice(-149), data.message]);
      }
      if (data.type === 'awaiting_approval') {
        setCampaign(prev => prev ? { ...prev, stage: 'awaiting_approval', status: 'awaiting_approval', progress: 95 } : prev);
        setLogs(l => [...l, `✓ ${data.message}`]);
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

  // ── Deploy all posts to Supergrow as drafts ────────────────────────────────
  async function handleDeploy() {
    setDeploying(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/deploy`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        setLogs(l => [...l, `Deploy error: ${err.error}`]);
      }
      // Progress will come via SSE
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

  const currentStageIdx = STAGES.findIndex(s => s.key === campaign?.stage);
  const isAwaiting = campaign?.stage === 'awaiting_approval';
  const isDone     = campaign?.status === 'completed';
  const isFailed   = campaign?.status === 'failed';

  return (
    <div style={{ padding: '28px', maxWidth: 900 }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: '#1a1a1a', marginBottom: 4 }}>
          {isAwaiting ? 'Review posts before sending to Supergrow' :
           isDone      ? 'Campaign complete' :
           isFailed    ? 'Campaign failed' :
                         'Campaign in progress'}
        </div>
        {!isAwaiting && !isDone && !isFailed && (
          <div style={{ fontSize: 13, color: '#888' }}>Do not close this page. This takes 20–35 minutes.</div>
        )}
      </div>

      {/* ── Progress bar ── */}
      <div style={{ background: '#fff', border: '0.5px solid #e0e0dc', borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#1a1a1a' }}>Overall progress</span>
          <span style={{ fontSize: 13, color: GREEN, fontWeight: 500 }}>{campaign?.progress || 0}%</span>
        </div>
        <div style={{ height: 6, background: '#f0f0ec', borderRadius: 3 }}>
          <div style={{ height: '100%', width: `${campaign?.progress || 0}%`, background: GREEN, borderRadius: 3, transition: 'width 0.5s ease' }} />
        </div>
      </div>

      {/* ── Stage pills ── */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STAGES.length}, 1fr)`, gap: 6, marginBottom: 20 }}>
        {STAGES.map((stage, i) => {
          const done   = currentStageIdx > i || campaign?.stage === 'done';
          const active = campaign?.stage === stage.key;
          return (
            <div key={stage.key} style={{
              background: done ? LIGHT : active ? '#FAEEDA' : '#fff',
              border: `0.5px solid ${done ? BORDER : active ? '#FAC775' : '#e0e0dc'}`,
              borderRadius: 8, padding: '8px 10px'
            }}>
              <div style={{ fontSize: 16, marginBottom: 3 }}>{done ? '✓' : active ? '⟳' : '○'}</div>
              <div style={{ fontSize: 10, fontWeight: 500, color: done ? DARK : active ? '#633806' : '#999', lineHeight: 1.3 }}>{stage.label}</div>
              {active && campaign && (
                <div style={{ fontSize: 9, color: '#888', marginTop: 2 }}>
                  {stage.key === 'generating_images' && `${campaign.images_generated || 0}/${campaign.total_posts || 12}`}
                  {stage.key === 'deploying'         && `${campaign.posts_deployed || 0}/${campaign.total_posts || 12}`}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── POST PREVIEW GRID (shown during awaiting_approval) ── */}
      {(isAwaiting || isDone) && posts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          {/* Deploy button */}
          {isAwaiting && (
            <div style={{
              background: '#FFF9ED', border: '0.5px solid #FAC775', borderRadius: 12,
              padding: '16px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between'
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: '#1a1a1a' }}>
                  {posts.length} posts ready — review below then send to Supergrow
                </div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
                  All posts will be saved as <strong>drafts</strong>. Your clients approve them inside Supergrow before anything goes live on LinkedIn.
                </div>
              </div>
              <button
                onClick={handleDeploy}
                disabled={deploying}
                style={{
                  background: deploying ? '#ccc' : GREEN, color: '#fff', border: 'none',
                  padding: '10px 22px', borderRadius: 8, fontWeight: 600, fontSize: 13,
                  cursor: deploying ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', marginLeft: 20
                }}
              >
                {deploying ? 'Sending…' : `Send ${posts.length} Drafts to Supergrow →`}
              </button>
            </div>
          )}

          {/* Post cards grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
            {posts.map((post, i) => {
              const isExpanded = expandedPost === post.id;
              const score = post.quality_score;
              const scoreColor = score == null ? '#aaa' : score >= 70 ? '#1D9E75' : score >= 50 ? '#e67e22' : '#c0392b';
              return (
                <div key={post.id} style={{
                  background: '#fff', border: '0.5px solid #e0e0dc', borderRadius: 12,
                  overflow: 'hidden', display: 'flex', flexDirection: 'column'
                }}>
                  {/* Image */}
                  {post.image_url ? (
                    <img
                      src={post.image_url}
                      alt={`Post ${i + 1}`}
                      style={{ width: '100%', height: 160, objectFit: 'cover', display: 'block' }}
                      onError={e => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    <div style={{ width: '100%', height: 80, background: '#f5f5f3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: 11, color: '#bbb' }}>No image</span>
                    </div>
                  )}

                  {/* Card body */}
                  <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                    {/* Meta row */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#1a1a1a' }}>Post {i + 1}</div>
                        <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>
                          {post.content_pillar && <span>{post.content_pillar}</span>}
                          {post.format && <span> · {post.format}</span>}
                        </div>
                        {(post.suggested_day || post.suggested_time) && (
                          <div style={{ fontSize: 10, color: GREEN, marginTop: 2 }}>
                            📅 {post.suggested_day} {post.suggested_time}
                          </div>
                        )}
                      </div>
                      {score != null && (
                        <div style={{
                          fontSize: 11, fontWeight: 600, color: scoreColor,
                          background: `${scoreColor}15`, border: `1px solid ${scoreColor}40`,
                          borderRadius: 20, padding: '2px 8px', whiteSpace: 'nowrap'
                        }}>
                          {score}/100{post.quality_score_fixed ? ' ✦' : ''}
                        </div>
                      )}
                    </div>

                    {/* Topic */}
                    <div style={{ fontSize: 11, fontWeight: 500, color: '#333', marginBottom: 6 }}>
                      {post.topic}
                    </div>

                    {/* Post text */}
                    <div style={{
                      fontSize: 11, color: '#555', lineHeight: 1.5, flex: 1,
                      maxHeight: isExpanded ? 'none' : 80, overflow: 'hidden',
                      maskImage: isExpanded ? 'none' : 'linear-gradient(to bottom, black 60%, transparent 100%)',
                      WebkitMaskImage: isExpanded ? 'none' : 'linear-gradient(to bottom, black 60%, transparent 100%)'
                    }}>
                      {post.linkedin_post_text}
                    </div>

                    {/* Expand/collapse toggle */}
                    <button
                      onClick={() => setExpanded(isExpanded ? null : post.id)}
                      style={{
                        marginTop: 8, fontSize: 10, color: GREEN, background: 'none',
                        border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left'
                      }}
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

      {/* ── Completion banner ── */}
      {isDone && files && (
        <div style={{ background: LIGHT, border: `0.5px solid ${BORDER}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: DARK, marginBottom: 12 }}>
            ✓ {campaign.posts_deployed} posts sent to Supergrow as drafts — waiting for client approval
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.keys(files).map(name => (
              <button key={name} onClick={() => downloadFile(name, files[name])} style={{
                fontSize: 11, padding: '4px 10px', border: `0.5px solid ${DARK}`, borderRadius: 6,
                background: '#fff', color: DARK, cursor: 'pointer'
              }}>{name}</button>
            ))}
          </div>
        </div>
      )}

      {/* ── Error banner ── */}
      {isFailed && (
        <div style={{ background: '#FCEBEB', border: '0.5px solid #F7C1C1', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#501313' }}>Campaign failed</div>
          <div style={{ fontSize: 12, color: '#791F1F', marginTop: 4 }}>{campaign.error_log}</div>
        </div>
      )}

      {/* ── Live log ── */}
      <div style={{ background: '#1a1a1a', borderRadius: 10, padding: 16, fontFamily: 'monospace', fontSize: 11, color: '#9FE1CB', maxHeight: 220, overflow: 'auto' }}>
        {logs.length === 0
          ? <div style={{ color: '#555' }}>Waiting for first update...</div>
          : logs.map((l, i) => (
            <div key={i} style={{ marginBottom: 2, color: l.startsWith('ERROR') ? '#F09595' : l.startsWith('✓') ? '#9FE1CB' : '#aaa' }}>
              {l}
            </div>
          ))
        }
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
