import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { generatePosts, getLinkedInAlgorithmContext, regenerateSinglePost } from '../services/openai.js';
import { getCurrentBrief } from './algorithm.js';
import { generateImage, sleep } from '../services/gemini.js';
import { uploadImageToR2 } from '../services/r2.js';
import { createDraft, getContentDna } from '../services/supergrow.js';

const router = Router();
const sseClients = new Map();
const cancelledCampaigns = new Set(); // track in-flight cancellations

// ─── SSE helpers ──────────────────────────────────────────────────────────────

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

// ─── SSE progress stream ──────────────────────────────────────────────────────

router.get('/progress/:id', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { id } = req.params;
  if (!sseClients.has(id)) sseClients.set(id, []);
  sseClients.get(id).push(res);

  // Send current DB state immediately on connect
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (campaign) res.write(`data: ${JSON.stringify({ type: 'status', campaign })}\n\n`);

  req.on('close', () => {
    const list = sseClients.get(id) || [];
    sseClients.set(id, list.filter(r => r !== res));
  });
});

// ─── Campaign queries ─────────────────────────────────────────────────────────

router.get('/client/:clientId', requireAuth, (req, res) => {
  const campaigns = db.prepare('SELECT * FROM campaigns WHERE client_id = ? ORDER BY created_at DESC').all(req.params.clientId);
  res.json(campaigns);
});

router.get('/:id', requireAuth, (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  res.json(campaign);
});

// ─── Start campaign ───────────────────────────────────────────────────────────

router.post('/start/:clientId', requireAuth, async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.rag_content) return res.status(400).json({ error: 'No RAG document uploaded for this client' });

  const campaignId = uuid();
  db.prepare(`
    INSERT INTO campaigns (id, client_id, status, stage, progress, total_posts)
    VALUES (?, ?, 'running', 'generating_posts', 0, 12)
  `).run(campaignId, client.id);

  const includeImages = req.body?.includeImages !== false; // default true

  res.json({ campaignId });

  runCampaign(campaignId, client, includeImages).catch(err => {
    console.error('Campaign error:', err);
    updateCampaign(campaignId, { status: 'failed', stage: 'error', error_log: err.message });
    sendSSE(campaignId, { type: 'error', message: err.message });
  });
});

// ─── Deploy to Supergrow (called after operator reviews the preview) ───────────
// Always sends as DRAFTS via create_post — client approves in Supergrow before publishing.

router.post('/:id/deploy', requireAuth, async (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.stage !== 'awaiting_approval') {
    return res.status(400).json({ error: `Cannot deploy from stage: ${campaign.stage}` });
  }

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(campaign.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const posts = JSON.parse(campaign.posts_json || '[]');
  if (!posts.length) return res.status(400).json({ error: 'No posts to deploy' });

  res.json({ ok: true, total: posts.length });

  // Run deployment in background, send progress via SSE
  deployToDrafts(campaign.id, client, posts).catch(err => {
    console.error('Deploy error:', err);
    updateCampaign(campaign.id, { status: 'failed', stage: 'error', error_log: err.message });
    sendSSE(campaign.id, { type: 'error', message: err.message });
  });
});

// ─── Regenerate image for a single post ──────────────────────────────────────

router.post('/:id/regenerate-image/:postIndex', requireAuth, async (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  // Don't let a stale admin tab regenerate posts on a campaign that's already
  // been deployed (either by admin or by customer-portal approve-all). The
  // posts are already live in Supergrow's queue at this point — overwriting
  // them in the DB would create a desync between what the customer signed off
  // on and what's about to publish.
  if (campaign.stage === 'done') {
    return res.status(400).json({ error: 'Campaign is already deployed — regeneration is locked.' });
  }

  const postIndex = parseInt(req.params.postIndex, 10);
  const posts = JSON.parse(campaign.posts_json || '[]');
  if (postIndex < 0 || postIndex >= posts.length) {
    return res.status(400).json({ error: `Post index ${postIndex} out of range` });
  }

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(campaign.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Respond immediately — image gen runs async
  res.json({ ok: true, postIndex });

  try {
    const post = posts[postIndex];
    const imageData = await generateImage(
      post.image_prompt || `Professional LinkedIn image for: ${post.topic}`,
      client,
      post
    );
    const imageUrl = await uploadImageToR2(imageData.data, imageData.mimeType, client.id, post.id || `post-${postIndex}`);

    posts[postIndex] = { ...post, image_url: imageUrl, image_error: undefined };
    updateCampaign(campaign.id, { posts_json: JSON.stringify(posts) });
    sendSSE(campaign.id, {
      type: 'post_updated',
      postIndex,
      post: posts[postIndex],
      message: `✓ Image regenerated for post ${postIndex + 1}.`
    });
  } catch (err) {
    console.error(`Regen image failed post ${postIndex}:`, err.message);
    sendSSE(campaign.id, {
      type: 'post_update_error',
      postIndex,
      message: `Image regen failed: ${err.message}`
    });
  }
});

// ─── Regenerate post text for a single post ───────────────────────────────────

router.post('/:id/regenerate-post/:postIndex', requireAuth, async (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  // See the equivalent guard on regenerate-image — blocks regeneration once
  // posts have been pushed to Supergrow.
  if (campaign.stage === 'done') {
    return res.status(400).json({ error: 'Campaign is already deployed — regeneration is locked.' });
  }

  const postIndex = parseInt(req.params.postIndex, 10);
  const posts = JSON.parse(campaign.posts_json || '[]');
  if (postIndex < 0 || postIndex >= posts.length) {
    return res.status(400).json({ error: `Post index ${postIndex} out of range` });
  }

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(campaign.client_id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({ ok: true, postIndex });

  try {
    const post = posts[postIndex];
    const rewritten = await regenerateSinglePost(post, client);

    posts[postIndex] = {
      ...post,
      linkedin_post_text: rewritten.linkedin_post_text,
      image_prompt: rewritten.image_prompt || post.image_prompt
    };
    updateCampaign(campaign.id, { posts_json: JSON.stringify(posts) });
    sendSSE(campaign.id, {
      type: 'post_updated',
      postIndex,
      post: posts[postIndex],
      message: `✓ Post ${postIndex + 1} text regenerated by GPT-4o.`
    });
  } catch (err) {
    console.error(`Regen post failed post ${postIndex}:`, err.message);
    sendSSE(campaign.id, {
      type: 'post_update_error',
      postIndex,
      message: `Post regen failed: ${err.message}`
    });
  }
});

// ─── Edit post text inline ────────────────────────────────────────────────────

router.patch('/:id/edit-post/:postIndex', requireAuth, (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  // See the regenerate guards above — once a campaign has been deployed to
  // Supergrow, the admin can't edit text on the stored posts because that'd
  // create a desync between what's in our DB and what's in Supergrow's queue.
  if (campaign.stage === 'done') {
    return res.status(400).json({ error: 'Campaign is already deployed — editing is locked.' });
  }

  const postIndex = parseInt(req.params.postIndex, 10);
  const posts = JSON.parse(campaign.posts_json || '[]');
  if (postIndex < 0 || postIndex >= posts.length) {
    return res.status(400).json({ error: `Post index ${postIndex} out of range` });
  }

  const { linkedin_post_text } = req.body;
  if (typeof linkedin_post_text !== 'string' || !linkedin_post_text.trim()) {
    return res.status(400).json({ error: 'linkedin_post_text is required' });
  }

  posts[postIndex] = { ...posts[postIndex], linkedin_post_text: linkedin_post_text.trim() };
  updateCampaign(campaign.id, { posts_json: JSON.stringify(posts) });

  res.json({ ok: true, post: posts[postIndex] });
});

router.delete('/:id', requireAuth, (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Cancel a running campaign ───────────────────────────────────────────────

router.post('/:id/cancel', requireAuth, (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['running', 'awaiting_approval'].includes(campaign.status)) {
    return res.status(400).json({ error: `Campaign is ${campaign.status} — cannot cancel` });
  }
  cancelledCampaigns.add(req.params.id);
  updateCampaign(req.params.id, { status: 'failed', stage: 'error', error_log: 'Cancelled by operator' });
  sendSSE(req.params.id, { type: 'error', message: 'Campaign cancelled by operator.' });
  res.json({ ok: true });
});

// ─── Campaign pipeline ────────────────────────────────────────────────────────

async function runCampaign(campaignId, client, includeImages = true) {
  try {
    // ── Fetch Content DNA ──────────────────────────────────────────────────────
    let contentDna = null;
    try {
      sendSSE(campaignId, { type: 'log', message: 'Fetching Content DNA from Supergrow...' });
      contentDna = await getContentDna(client.supergrow_workspace_id, client.supergrow_api_key);
      sendSSE(campaignId, { type: 'log', message: contentDna
        ? 'Content DNA loaded — posts will match writing style.'
        : 'No Content DNA found — proceeding without style data.' });
    } catch (err) {
      sendSSE(campaignId, { type: 'log', message: `Content DNA unavailable (${err.message}) — proceeding.` });
    }

    // ── Stage 1: Generate posts via Claude Sonnet ───────────────────────────────
    // Stage 1: Generate posts via Claude Sonnet
    sendSSE(campaignId, { type: 'log', message: 'Starting post generation with Claude Sonnet...' });
    updateCampaign(campaignId, { stage: 'generating_posts', progress: 5 });

    // Pull the latest algorithm brief from the DB (null if never run)
    const algorithmBrief = getCurrentBrief();
    if (algorithmBrief) {
      sendSSE(campaignId, { type: 'log', message: '\u2713 Algorithm brief loaded \u2014 posts will follow latest LinkedIn best practices.' });
    } else {
      sendSSE(campaignId, { type: 'log', message: 'No algorithm brief found \u2014 Claude will research LinkedIn trends inline.' });
    }

    const generated = await generatePosts(
      client,
      msg => sendSSE(campaignId, { type: 'log', message: msg }),
      contentDna,
      algorithmBrief
    );

    const posts = generated.posts;

    updateCampaign(campaignId, {
      stage: 'scoring_posts',
      progress: 25,
      posts_generated: posts.length,
      total_posts: posts.length,
      posts_json: JSON.stringify(posts)
    });
    sendSSE(campaignId, { type: 'progress', stage: 'scoring_posts', progress: 25, posts_generated: posts.length });

    // ── Stage 2: Scoring skipped — score_post MCP consistently times out.
    // Posts proceed directly to image generation at full quality from GPT-4o.
    const scoredPosts = posts;
    sendSSE(campaignId, { type: 'log', message: `✓ ${posts.length} posts ready — Proceeding to image generation.` });

    // ── Stage 3: Generate images (skipped if includeImages=false) ───────────────
    if (!includeImages) {
      sendSSE(campaignId, { type: 'log', message: 'Skipping image generation (text-only campaign).' });
      const postsNoImages = scoredPosts.map(p => ({ ...p, image_url: null }));
      updateCampaign(campaignId, {
        stage: 'awaiting_approval', status: 'awaiting_approval', progress: 95,
        posts_json: JSON.stringify(postsNoImages)
      });
      sendSSE(campaignId, {
        type: 'awaiting_approval',
        total: postsNoImages.length,
        images: 0,
        message: `${postsNoImages.length} posts ready (text only). Review below, then send to Supergrow as drafts.`
      });
      return;
    }

    updateCampaign(campaignId, { stage: 'generating_images', progress: 35 });
    sendSSE(campaignId, { type: 'progress', stage: 'generating_images', progress: 35, posts_generated: scoredPosts.length });

    const enrichedPosts = [];
    const RATE_LIMIT_DELAY = 7000;

    for (let i = 0; i < scoredPosts.length; i++) {
      const post = scoredPosts[i];

      // Check if operator cancelled while we were generating
      if (cancelledCampaigns.has(campaignId)) {
        cancelledCampaigns.delete(campaignId);
        return;
      }

      try {
        sendSSE(campaignId, { type: 'log', message: `Generating image ${i + 1}/${scoredPosts.length}...` });
        const imageData = await generateImage(
          post.image_prompt || `Professional LinkedIn image for: ${post.topic}`,
          client,
          post
        );
        const imageUrl = await uploadImageToR2(imageData.data, imageData.mimeType, client.id, post.id);
        enrichedPosts.push({ ...post, image_url: imageUrl });
        sendSSE(campaignId, { type: 'log', message: `✓ Image ${i + 1} generated and uploaded.` });
      } catch (err) {
        console.error(`Image gen failed for post ${i + 1}:`, err.message);
        enrichedPosts.push({ ...post, image_url: null, image_error: err.message });

        // Give a clear, actionable message for quota exhaustion
        let logMsg;
        if (err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED') || err.message?.includes('quota')) {
          logMsg = `⚠️ Image ${i + 1}: Gemini free tier quota exhausted — resets midnight Pacific. Posts will continue without images.`;
        } else {
          logMsg = `Image ${i + 1} failed (${err.message}) — post kept without image.`;
        }
        sendSSE(campaignId, { type: 'log', message: logMsg });
      }

      const progress = 35 + Math.round((i + 1) / scoredPosts.length * 55);
      updateCampaign(campaignId, {
        progress,
        images_generated: i + 1,
        posts_json: JSON.stringify(enrichedPosts)
      });
      sendSSE(campaignId, { type: 'progress', stage: 'generating_images', images_generated: i + 1, total: scoredPosts.length });

      // Only apply rate-limit delay after a successful image generation
      const lastPost = enrichedPosts[enrichedPosts.length - 1];
      if (i < scoredPosts.length - 1 && lastPost?.image_url) await sleep(RATE_LIMIT_DELAY);
    }

    // ── Stage 4: Await operator approval ─────────────────────────────────────
    // Pipeline stops here. Operator reviews all posts + images in the app,
    // then clicks "Send to Supergrow as Drafts" to trigger deployment.
    updateCampaign(campaignId, {
      stage: 'awaiting_approval',
      status: 'awaiting_approval',
      progress: 95,
      posts_json: JSON.stringify(enrichedPosts)
    });

    sendSSE(campaignId, {
      type: 'awaiting_approval',
      total: enrichedPosts.length,
      images: enrichedPosts.filter(p => p.image_url).length,
      message: `${enrichedPosts.length} posts and ${enrichedPosts.filter(p => p.image_url).length} images are ready. Review below, then send to Supergrow as drafts.`
    });

  } catch (err) {
    updateCampaign(campaignId, { status: 'failed', stage: 'error', error_log: err.message });
    sendSSE(campaignId, { type: 'error', message: err.message });
    throw err;
  }
}

// ─── Deployment pipeline (runs after operator approves) ───────────────────────
// All posts are ALWAYS sent as drafts via create_post.
// Clients approve inside Supergrow before anything goes to LinkedIn.

async function deployToDrafts(campaignId, client, posts) {
  updateCampaign(campaignId, { stage: 'deploying', status: 'running', progress: 95 });
  sendSSE(campaignId, { type: 'progress', stage: 'deploying' });

  const results = [];
  let deployed = 0;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    try {
      sendSSE(campaignId, { type: 'log', message: `Sending post ${i + 1}/${posts.length} to Supergrow as draft...` });

      // ALWAYS create_post (draft) — never queue_post
      // Client approves in Supergrow before anything publishes to LinkedIn
      const result = await createDraft({
        workspaceId: client.supergrow_workspace_id,
        apiKey: client.supergrow_api_key,
        postText: post.linkedin_post_text,
        imageUrls: post.image_url ? [post.image_url] : []
      });

      // Extract app_url and post id from Supergrow response
      let supergrowPostId = null;
      let supergrowAppUrl = null;
      try {
        const raw = result?.content;
        const text = typeof raw === 'string' ? raw
          : Array.isArray(raw) ? (raw.find(b => b.type === 'text')?.text ?? '') : '';
        const clean = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
        const parsed = JSON.parse(clean);
        supergrowPostId = parsed?.post?.id ?? null;
        supergrowAppUrl = parsed?.post?.app_url ?? null;
      } catch (_) {}

      // Write app_url back into posts_json so the review grid can link to Supergrow
      posts[i] = { ...post, supergrow_post_id: supergrowPostId, supergrow_app_url: supergrowAppUrl };

      results.push({ postId: post.id, status: 'success', result });
      deployed++;
      sendSSE(campaignId, { type: 'log', message: `✓ Post ${i + 1} saved as draft in Supergrow.` });

    } catch (err) {
      console.error(`Deploy failed for post ${i + 1}:`, err.message);
      // Retry once
      try {
        await sleep(2000);
        const retry = await createDraft({
          workspaceId: client.supergrow_workspace_id,
          apiKey: client.supergrow_api_key,
          postText: post.linkedin_post_text,
          imageUrls: post.image_url ? [post.image_url] : []
        });

        // Extract app_url from retry response
        try {
          const raw = retry?.content;
          const text = typeof raw === 'string' ? raw
            : Array.isArray(raw) ? (raw.find(b => b.type === 'text')?.text ?? '') : '';
          const clean = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
          const parsed = JSON.parse(clean);
          posts[i] = { ...post, supergrow_post_id: parsed?.post?.id ?? null, supergrow_app_url: parsed?.post?.app_url ?? null };
        } catch (_) {}

        results.push({ postId: post.id, status: 'success_retry', result: retry });
        deployed++;
        sendSSE(campaignId, { type: 'log', message: `✓ Post ${i + 1} sent (retry succeeded).` });
      } catch (retryErr) {
        results.push({ postId: post.id, status: 'failed', error: retryErr.message });
        sendSSE(campaignId, { type: 'log', message: `✗ Post ${i + 1} failed: ${retryErr.message}` });
      }
    }

    const progress = 95 + Math.round((i + 1) / posts.length * 4);
    updateCampaign(campaignId, { progress, posts_deployed: deployed });
    sendSSE(campaignId, { type: 'progress', stage: 'deploying', posts_deployed: i + 1, total: posts.length });
    await sleep(500);
  }

  const files = buildOutputFiles(client, posts, results);

  updateCampaign(campaignId, {
    status: 'completed',
    stage: 'done',
    deployed_by: 'admin',
    progress: 100,
    posts_deployed: deployed,
    posts_json: JSON.stringify(posts),
    files_json: JSON.stringify(files),
    completed_at: new Date().toISOString()
  });

  sendSSE(campaignId, { type: 'complete', deployed, total: posts.length, files });
}

// ─── Output file builder ──────────────────────────────────────────────────────

function buildOutputFiles(client, posts, results) {
  const successCount = results.filter(r => r.status === 'success' || r.status === 'success_retry').length;
  const failedResults = results.filter(r => r.status === 'failed');

  const postsMarkdown = posts.map((p, i) => {
    const scoreNote = p.quality_score != null
      ? ` | Score: ${p.quality_score}/100${p.quality_score_fixed ? ' (auto-fixed)' : ''}`
      : '';
    const scheduleNote = p.suggested_day ? ` | ${p.suggested_day} ${p.suggested_time}` : '';
    return `## Post ${i + 1}: ${p.topic || ''}${scoreNote}${scheduleNote}

**Pillar:** ${p.content_pillar || ''} | **Format:** ${p.format || 'Text Post'}
**Angle:** ${p.angle || ''}
**Segment:** ${p.buyer_segment || ''}
**CTA:** ${p.cta_type || ''}

${p.linkedin_post_text}

---
`;
  }).join('\n');

  const postsJson = JSON.stringify(posts.map(p => ({
    id: p.id,
    topic: p.topic,
    linkedin_post_text: p.linkedin_post_text,
    image_urls: p.image_url ? [p.image_url] : [],
    workspace_id: client.supergrow_workspace_id,
    quality_score: p.quality_score ?? null,
    quality_score_fixed: p.quality_score_fixed ?? false,
    suggested_day: p.suggested_day ?? null,
    suggested_time: p.suggested_time ?? null,
    content_pillar: p.content_pillar ?? null,
    format: p.format ?? null
  })), null, 2);

  const csvRows = posts.map(p =>
    `"${p.id}","${(p.linkedin_post_text || '').replace(/"/g, '""')}","${p.image_url || ''}","${client.supergrow_workspace_id}","${p.suggested_day || ''}","${p.suggested_time || ''}"`
  ).join('\n');

  const scheduleTracker = `# Schedule Tracker: ${client.name}

Campaign Run: ${new Date().toISOString()}
Total Posts: ${posts.length}
Successfully Deployed as Drafts: ${successCount}
Failed: ${failedResults.length}

## Quality Gate Summary (70/100 threshold)
Posts auto-fixed: ${posts.filter(p => p.quality_score_fixed).length}
Posts with score ≥ 70: ${posts.filter(p => p.quality_score != null && p.quality_score >= 70).length}
Posts without score data: ${posts.filter(p => p.quality_score == null).length}

## Failed Posts
${failedResults.map(r => `- Post ${r.postId}: ${r.error}`).join('\n') || 'None'}
`;

  const workflowLog = `# Workflow Log: ${client.name}

Run completed: ${new Date().toISOString()}
Client: ${client.name} (${client.brand})
Workspace: ${client.supergrow_workspace_name} (${client.supergrow_workspace_id})
Mode: Draft only (operator approval in Supergrow before publishing)
Posts generated: ${posts.length}
Images generated: ${posts.filter(p => p.image_url).length}
Posts deployed as drafts: ${successCount}
Auto-fixed (quality gate): ${posts.filter(p => p.quality_score_fixed).length}
Generated by: GPT-4o with LinkedIn Master prompt + live algorithm context
`;

  return {
    'generated_posts.md': postsMarkdown,
    'generated_posts.json': postsJson,
    'generated_posts_for_scheduling.csv': `id,linkedin_post_text,image_url,workspace_id,suggested_day,suggested_time\n${csvRows}`,
    'schedule_tracker.md': scheduleTracker,
    'workflow_log.md': workflowLog,
    'execution_results.json': JSON.stringify({ campaign_run: new Date().toISOString(), client: client.name, results }, null, 2)
  };
}

export default router;
