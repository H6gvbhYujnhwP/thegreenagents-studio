import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { generatePosts, fixPost } from '../services/claude.js';
import { generateImage, sleep } from '../services/gemini.js';
import { uploadImageToR2 } from '../services/r2.js';
import {
  queuePost,
  createDraft,
  getContentDna,
  scorePost
} from '../services/supergrow.js';

const router = Router();
const sseClients = new Map();

function sendSSE(campaignId, data) {
  const clients = sseClients.get(campaignId) || [];
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(payload); } catch (_) {} });
}

function updateCampaign(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(fields), id];
  db.prepare(`UPDATE campaigns SET ${sets} WHERE id = ?`).run(...vals);
}

router.get('/progress/:id', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { id } = req.params;
  if (!sseClients.has(id)) sseClients.set(id, []);
  sseClients.get(id).push(res);

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (campaign) res.write(`data: ${JSON.stringify({ type: 'status', campaign })}\n\n`);

  req.on('close', () => {
    const list = sseClients.get(id) || [];
    sseClients.set(id, list.filter(r => r !== res));
  });
});

router.get('/client/:clientId', requireAuth, (req, res) => {
  const campaigns = db.prepare('SELECT * FROM campaigns WHERE client_id = ? ORDER BY created_at DESC').all(req.params.clientId);
  res.json(campaigns);
});

router.get('/:id', requireAuth, (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  res.json(campaign);
});

router.post('/start/:clientId', requireAuth, async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.rag_content) return res.status(400).json({ error: 'No RAG document uploaded for this client' });

  const campaignId = uuid();
  db.prepare(`
    INSERT INTO campaigns (id, client_id, status, stage, progress, total_posts)
    VALUES (?, ?, 'running', 'generating_posts', 0, 96)
  `).run(campaignId, client.id);

  res.json({ campaignId });

  runCampaign(campaignId, client).catch(err => {
    console.error('Campaign error:', err);
    updateCampaign(campaignId, { status: 'failed', stage: 'error', error_log: err.message });
    sendSSE(campaignId, { type: 'error', message: err.message });
  });
});

async function runCampaign(campaignId, client) {
  try {
    // ── Improvement 2: fetch Content DNA before generating posts ──────────────
    let contentDna = null;
    try {
      sendSSE(campaignId, { type: 'log', message: 'Fetching Content DNA from Supergrow...' });
      contentDna = await getContentDna(client.supergrow_workspace_id, client.supergrow_api_key);
      if (contentDna) {
        sendSSE(campaignId, { type: 'log', message: 'Content DNA loaded — posts will match your writing style.' });
      } else {
        sendSSE(campaignId, { type: 'log', message: 'No Content DNA found — proceeding without style data.' });
      }
    } catch (dnaErr) {
      console.error('Content DNA fetch failed (non-fatal):', dnaErr.message);
      sendSSE(campaignId, { type: 'log', message: `Content DNA unavailable (${dnaErr.message}) — proceeding.` });
    }

    // ── Stage 1: Generate posts via Claude ───────────────────────────────────
    sendSSE(campaignId, { type: 'log', message: 'Starting post generation with Claude...' });
    updateCampaign(campaignId, { stage: 'generating_posts', progress: 5 });

    const generated = await generatePosts(client, msg => {
      sendSSE(campaignId, { type: 'log', message: msg });
    }, contentDna);

    // All 96 posts (smoke-test slice removed)
    const posts = generated.posts;

    updateCampaign(campaignId, {
      stage: 'scoring_posts',
      progress: 25,
      posts_generated: posts.length,
      total_posts: posts.length,
      posts_json: JSON.stringify(posts)
    });
    sendSSE(campaignId, { type: 'progress', stage: 'scoring_posts', posts_generated: posts.length });

    // ── Improvement 4: score_post quality gate ───────────────────────────────
    sendSSE(campaignId, { type: 'log', message: `Scoring ${posts.length} posts (quality gate: 7/10)...` });
    const scoredPosts = [];
    let fixedCount = 0;

    for (let i = 0; i < posts.length; i++) {
      const post = { ...posts[i] };
      try {
        const { score, feedback } = await scorePost(
          client.supergrow_workspace_id,
          post.linkedin_post_text,
          client.supergrow_api_key
        );

        post.quality_score = score;

        if (score !== null && score < 7) {
          sendSSE(campaignId, {
            type: 'log',
            message: `Post ${i + 1} scored ${score}/10 — auto-fixing...`
          });
          const improved = await fixPost(post, feedback, contentDna);
          post.linkedin_post_text = improved;
          post.quality_score_fixed = true;

          // Re-score once after fix
          try {
            const reScore = await scorePost(
              client.supergrow_workspace_id,
              improved,
              client.supergrow_api_key
            );
            post.quality_score = reScore.score;
            sendSSE(campaignId, {
              type: 'log',
              message: `Post ${i + 1} re-scored: ${reScore.score ?? 'n/a'}/10`
            });
          } catch (_) {}

          fixedCount++;
        } else if (score !== null) {
          // Good score — log every 10th to avoid flooding
          if ((i + 1) % 10 === 0) {
            sendSSE(campaignId, { type: 'log', message: `Posts 1–${i + 1} scored (avg quality ✓)` });
          }
        }
      } catch (scoreErr) {
        console.error(`Score failed for post ${i + 1} (non-fatal):`, scoreErr.message);
        post.quality_score = null;
      }

      scoredPosts.push(post);

      const progress = 25 + Math.round((i + 1) / posts.length * 10);
      updateCampaign(campaignId, { progress, posts_json: JSON.stringify(scoredPosts) });

      // Small pause between MCP score calls to avoid rate limits
      await sleep(300);
    }

    sendSSE(campaignId, {
      type: 'log',
      message: `Quality gate complete. ${fixedCount} post(s) auto-fixed. All posts ready.`
    });

    // ── Stage 2: Image generation ─────────────────────────────────────────────
    updateCampaign(campaignId, { stage: 'generating_images', progress: 35 });
    sendSSE(campaignId, { type: 'progress', stage: 'generating_images', posts_generated: scoredPosts.length });

    const enrichedPosts = [];
    const RATE_LIMIT_DELAY = 7000;

    for (let i = 0; i < scoredPosts.length; i++) {
      const post = scoredPosts[i];
      try {
        sendSSE(campaignId, { type: 'log', message: `Generating image ${i + 1}/${scoredPosts.length}...` });
        const imageData = await generateImage(post.image_prompt || `Professional LinkedIn image for: ${post.topic}`);
        const imageUrl = await uploadImageToR2(imageData.data, imageData.mimeType, client.id, post.id);
        enrichedPosts.push({ ...post, image_url: imageUrl });
      } catch (imgErr) {
        console.error(`Image gen failed for post ${i + 1}:`, imgErr.message);
        enrichedPosts.push({ ...post, image_url: null, image_error: imgErr.message });
      }

      const progress = 35 + Math.round((i + 1) / scoredPosts.length * 30);
      updateCampaign(campaignId, { progress, images_generated: i + 1, posts_json: JSON.stringify(enrichedPosts) });
      sendSSE(campaignId, { type: 'progress', stage: 'generating_images', images_generated: i + 1, total: scoredPosts.length });

      if (i < scoredPosts.length - 1) await sleep(RATE_LIMIT_DELAY);
    }

    // ── Stage 3: Deployment ───────────────────────────────────────────────────
    updateCampaign(campaignId, { stage: 'deploying', progress: 65 });
    sendSSE(campaignId, { type: 'progress', stage: 'deploying' });

    const deployFn = client.approval_mode === 'draft' ? createDraft : queuePost;
    const results = [];
    let deployed = 0;

    for (let i = 0; i < enrichedPosts.length; i++) {
      const post = enrichedPosts[i];
      try {
        sendSSE(campaignId, { type: 'log', message: `Deploying post ${i + 1}/${enrichedPosts.length} to Supergrow...` });
        const result = await deployFn({
          workspaceId: client.supergrow_workspace_id,
          apiKey: client.supergrow_api_key,
          postText: post.linkedin_post_text,
          imageUrls: post.image_url ? [post.image_url] : []
        });
        results.push({ postId: post.id, status: 'success', result });
        deployed++;
      } catch (depErr) {
        console.error(`Deploy failed for post ${i + 1}:`, depErr.message);
        // Retry once
        try {
          await sleep(2000);
          const retry = await deployFn({
            workspaceId: client.supergrow_workspace_id,
            apiKey: client.supergrow_api_key,
            postText: post.linkedin_post_text,
            imageUrls: post.image_url ? [post.image_url] : []
          });
          results.push({ postId: post.id, status: 'success_retry', result: retry });
          deployed++;
        } catch (retryErr) {
          results.push({ postId: post.id, status: 'failed', error: retryErr.message });
        }
      }

      const progress = 65 + Math.round((i + 1) / enrichedPosts.length * 30);
      updateCampaign(campaignId, { progress, posts_deployed: deployed });
      sendSSE(campaignId, { type: 'progress', stage: 'deploying', posts_deployed: i + 1, total: enrichedPosts.length });

      await sleep(500);
    }

    const files = buildOutputFiles(client, generated, enrichedPosts, results);

    updateCampaign(campaignId, {
      status: 'completed',
      stage: 'done',
      progress: 100,
      posts_deployed: deployed,
      posts_json: JSON.stringify(enrichedPosts),
      files_json: JSON.stringify(files),
      completed_at: new Date().toISOString()
    });

    sendSSE(campaignId, { type: 'complete', deployed, total: enrichedPosts.length, files });

  } catch (err) {
    updateCampaign(campaignId, { status: 'failed', stage: 'error', error_log: err.message });
    sendSSE(campaignId, { type: 'error', message: err.message });
    throw err;
  }
}

function buildOutputFiles(client, generated, posts, results) {
  const clientProfile = `# Client Profile: ${client.name}

**Brand:** ${client.brand}
**Website:** ${client.website}
**Timezone:** ${client.timezone}
**Posting Cadence:** ${client.cadence}

## Operating Profile
${JSON.stringify(generated.client_profile, null, 2)}
`;

  const researchNotes = `# Research Notes: ${client.name}

${generated.research_notes || 'No research notes generated.'}
`;

  const topicScheduleRows = (generated.topic_schedule || []).map(w =>
    `${w.week},${w.theme},"${(w.topics || []).join('; ')}"`
  ).join('\n');
  const topicSchedule = `week,theme,topics\n${topicScheduleRows}`;

  const postsMarkdown = posts.map((p, i) => {
    const scoreNote = p.quality_score != null
      ? ` | Score: ${p.quality_score}/10${p.quality_score_fixed ? ' (auto-fixed)' : ''}`
      : '';
    return `## Post ${i + 1}: ${p.topic || ''}${scoreNote}\n\n**Angle:** ${p.angle || ''}\n**Segment:** ${p.buyer_segment || ''}\n**CTA:** ${p.cta_type || ''}\n\n${p.linkedin_post_text}\n\n---\n`;
  }).join('\n');

  const postsJson = JSON.stringify(posts.map(p => ({
    id: p.id,
    topic: p.topic,
    linkedin_post_text: p.linkedin_post_text,
    image_urls: p.image_url ? [p.image_url] : [],
    workspace_id: client.supergrow_workspace_id,
    quality_score: p.quality_score ?? null,
    quality_score_fixed: p.quality_score_fixed ?? false
  })), null, 2);

  const csvRows = posts.map(p =>
    `"${p.id}","${(p.linkedin_post_text || '').replace(/"/g, '""')}","${p.image_url || ''}","${client.supergrow_workspace_id}"`
  ).join('\n');
  const postsForScheduling = `id,linkedin_post_text,image_url,workspace_id\n${csvRows}`;

  const successCount = results.filter(r => r.status === 'success' || r.status === 'success_retry').length;
  const failedResults = results.filter(r => r.status === 'failed');

  const scheduleTracker = `# Schedule Tracker: ${client.name}

Campaign Run: ${new Date().toISOString()}
Total Posts: ${posts.length}
Successfully Deployed: ${successCount}
Failed: ${failedResults.length}

## Quality Gate Summary
Posts scored below 7 and auto-fixed: ${posts.filter(p => p.quality_score_fixed).length}
Posts with score ≥ 7: ${posts.filter(p => p.quality_score != null && p.quality_score >= 7).length}
Posts without score data: ${posts.filter(p => p.quality_score == null).length}

## Failed Posts
${failedResults.map(r => `- Post ${r.postId}: ${r.error}`).join('\n') || 'None'}
`;

  const workflowLog = `# Workflow Log: ${client.name}

Run completed: ${new Date().toISOString()}
Client: ${client.name} (${client.brand})
Workspace: ${client.supergrow_workspace_name} (${client.supergrow_workspace_id})
Mode: ${client.approval_mode === 'draft' ? 'Draft only' : 'Queue post'}
Posts generated: ${posts.length}
Images generated: ${posts.filter(p => p.image_url).length}
Posts deployed: ${successCount}
Auto-fixed (quality gate): ${posts.filter(p => p.quality_score_fixed).length}
`;

  const executionResults = JSON.stringify({
    campaign_run: new Date().toISOString(),
    client: client.name,
    workspace_id: client.supergrow_workspace_id,
    mode: client.approval_mode,
    quality_gate: {
      total: posts.length,
      scored: posts.filter(p => p.quality_score != null).length,
      passed: posts.filter(p => p.quality_score != null && p.quality_score >= 7).length,
      auto_fixed: posts.filter(p => p.quality_score_fixed).length
    },
    results
  }, null, 2);

  return {
    'client_profile.md': clientProfile,
    'research_notes.md': researchNotes,
    'topic_schedule.csv': topicSchedule,
    'generated_posts.md': postsMarkdown,
    'generated_posts.json': postsJson,
    'generated_posts_for_scheduling.csv': postsForScheduling,
    'schedule_tracker.md': scheduleTracker,
    'workflow_log.md': workflowLog,
    'execution_results.json': executionResults
  };
}

export default router;
