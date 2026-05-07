/**
 * portal.js — Customer-portal DATA routes.
 *
 * Mounted at /api/portal in server/index.js. All routes here require a
 * customer-portal session (requirePortalSession from portal-auth.js) and
 * filter every query by the resolved customer's id — never trust ids from
 * the URL or body.
 *
 * Shipped so far:
 *   chunk 3a — GET /posts
 *   chunk 3b-i — PUT /posts/:id, POST /posts/:id/approve,
 *                POST /posts/:id/regenerate, POST /campaigns/:id/posts/approve-all
 *
 * Coming next:
 *   chunk 3b-ii  — inbox (GET /inbox, GET /replies/:id, POST /replies/:id/send)
 *   chunk 3b-iii — campaigns (GET /campaigns)
 */
import { Router } from 'express';
import db from '../db.js';
import { requirePortalSession } from './portal-auth.js';
import { regenerateSinglePost } from '../services/openai.js';
import { generateImage } from '../services/gemini.js';
import { uploadImageToR2 } from '../services/r2.js';
import { queuePost } from '../services/supergrow.js';

const router = Router();
router.use(requirePortalSession);

// ─── Helper: resolve the linked LinkedIn client id for this portal customer ──
//
// Reads from customer_services first (the new generic-services source of truth)
// and falls back to the legacy email_clients.linkedin_client_id column if the
// service hasn't been migrated yet. Returns null if the customer doesn't have
// LinkedIn enabled — caller then returns an empty list with not_subscribed=true.
function resolveLinkedinClientId(emailClientId) {
  const cs = db.prepare(`
    SELECT linked_external_id FROM customer_services
    WHERE email_client_id = ? AND service_key = 'linkedin'
  `).get(emailClientId);
  if (cs?.linked_external_id) return cs.linked_external_id;
  const legacy = db.prepare(`
    SELECT linkedin_client_id FROM email_clients WHERE id = ?
  `).get(emailClientId);
  return legacy?.linkedin_client_id || null;
}

/**
 * Map a post object from posts_json into the shape the customer portal renders.
 * The admin-side post object has fields like linkedin_post_text, image_url,
 * topic, suggested_day, suggested_time. The portal renders post.body and
 * post.image_url and a friendly schedule string. We project here so the
 * portal frontend doesn't have to know about admin-side field naming.
 *
 * `client_approved_at` is the customer-portal approval timestamp (per Wez's
 * "lives in the same JSON bundle" pre-decision); `approved` is the boolean
 * the portal uses for display state.
 */
function projectPost(post, index) {
  const day  = post.suggested_day  || '';
  const time = post.suggested_time || '';
  const schedule = (day || time) ? `${day} ${time}`.trim() : `Post ${index + 1}`;
  return {
    id:                post.id || `post_${index + 1}`,
    order:             index + 1,
    title:             post.topic || `Post ${index + 1}`,
    body:              post.linkedin_post_text || '',
    image_url:         post.image_url || null,
    image_error:       post.image_error || null,
    scheduled_for:     schedule,
    approved:          !!post.client_approved_at,
    approved_at:       post.client_approved_at || null,
    approved_by:       post.client_approved_by_user_id || null,
  };
}

// ─── GET /api/portal/posts ────────────────────────────────────────────────────
//
// Returns the customer's most-recent campaign whose stage = 'awaiting_approval'
// — projected as a list of posts. Empty list (with reason flag) when:
//   - The customer isn't subscribed to LinkedIn ('not_subscribed' = true)
//   - No awaiting_approval campaign exists for the linked LinkedIn client
//
// The frontend renders three different UI states from these signals:
//   - real posts → review grid
//   - empty + not_subscribed → "Not required" panel (already handled upstream
//     by the ServiceGate — but we still respond cleanly here in case it isn't)
//   - empty + no current batch → "Nothing to review right now" panel
router.get('/posts', (req, res) => {
  const linkedinClientId = resolveLinkedinClientId(req.portalClient.id);
  if (!linkedinClientId) {
    return res.json({
      posts: [],
      campaign: null,
      not_subscribed: true,
    });
  }

  // Most-recent awaiting_approval campaign for this LinkedIn client.
  const campaign = db.prepare(`
    SELECT id, title, stage, posts_json, created_at
    FROM campaigns
    WHERE client_id = ? AND stage = 'awaiting_approval'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(linkedinClientId);

  if (!campaign) {
    return res.json({
      posts: [],
      campaign: null,
      not_subscribed: false,
    });
  }

  let posts = [];
  try {
    posts = JSON.parse(campaign.posts_json || '[]');
  } catch (e) {
    console.error(`[portal] posts_json parse failed for campaign ${campaign.id}:`, e.message);
    posts = [];
  }

  res.json({
    posts: posts.map(projectPost),
    campaign: {
      id:    campaign.id,
      title: campaign.title || 'Posts ready for review',
    },
    not_subscribed: false,
  });
});

// ─── Helpers shared by the 3b-i mutation routes ───────────────────────────────
//
// Per-post state lives INSIDE campaigns.posts_json (no sidecar table — locked
// pre-decision). These helpers find a post by its id while ALSO confirming the
// owning campaign belongs to this customer's linked LinkedIn client. If either
// the campaign or the post can't be located for this customer, return null and
// the route layer responds 404. We never accept a post id without validating
// the customer-tenant relationship — 404 (not 403) so we don't leak existence.

function findPostForPortalUser(req, postId) {
  const linkedinClientId = resolveLinkedinClientId(req.portalClient.id);
  if (!linkedinClientId) return null;

  // Scan awaiting_approval campaigns for this customer's linked client until we
  // find the post. In practice there's almost always exactly one such campaign
  // (the most recent), so this is a cheap loop. We don't restrict to the most
  // recent only — if for some reason an older awaiting_approval batch is still
  // open (admin error, partial-failure retry) we still let the customer act
  // on it.
  const campaigns = db.prepare(`
    SELECT id, title, stage, posts_json, created_at
    FROM campaigns
    WHERE client_id = ? AND stage = 'awaiting_approval'
    ORDER BY created_at DESC
  `).all(linkedinClientId);

  for (const campaign of campaigns) {
    let posts = [];
    try { posts = JSON.parse(campaign.posts_json || '[]'); } catch (_) { posts = []; }
    const idx = posts.findIndex(p => (p.id || '') === postId);
    if (idx !== -1) {
      return { campaign, posts, postIndex: idx, post: posts[idx] };
    }
  }
  return null;
}

// Find a campaign by id ALSO confirming it belongs to this customer's linked
// LinkedIn client. Used by approve-all. Same 404 behaviour.
function findCampaignForPortalUser(req, campaignId) {
  const linkedinClientId = resolveLinkedinClientId(req.portalClient.id);
  if (!linkedinClientId) return null;
  const campaign = db.prepare(`
    SELECT id, title, stage, posts_json, created_at, client_id
    FROM campaigns
    WHERE id = ? AND client_id = ?
  `).get(campaignId, linkedinClientId);
  if (!campaign) return null;
  let posts = [];
  try { posts = JSON.parse(campaign.posts_json || '[]'); } catch (_) { posts = []; }
  return { campaign, posts };
}

// Persist a mutated posts array back to its campaign row.
function writeCampaignPosts(campaignId, posts) {
  db.prepare(`UPDATE campaigns SET posts_json = ? WHERE id = ?`)
    .run(JSON.stringify(posts), campaignId);
}

// Append-only audit row. We use the existing email_audit_log table (it's
// generic — actor + action + target + JSON metadata) rather than introducing
// a portal-specific table. action values used by chunk 3b-i:
//   'portal_post_approve'      — single-post approve
//   'portal_post_save_approve' — edit + approve (PUT /posts/:id)
//   'portal_post_regenerate'   — successful regen
//   'portal_approve_all'       — full success, stage flipped to deployed
//   'portal_approve_all_partial' — partial Supergrow failure, stage stays awaiting_approval
function audit(action, req, target_id, metadata = {}) {
  const id = `al_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO email_audit_log (id, actor, action, target_type, target_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `portal_user:${req.portalUser.id}`,
    action,
    'campaign_post',
    target_id,
    JSON.stringify({
      email_client_id: req.portalClient.id,
      portal_username:  req.portalUser.username,
      ...metadata,
    }),
  );
}

// Mark a single post object (mutates in place) as approved by this portal user.
function markApproved(post, req) {
  post.client_approved_at = new Date().toISOString();
  post.client_approved_by_user_id = req.portalUser.id;
}

// ─── PUT /api/portal/posts/:id ────────────────────────────────────────────────
// Save edits AND mark approved (single-click for the common case where the
// customer tweaks copy then accepts). Body: { title, body }.
// title maps to post.topic; body maps to post.linkedin_post_text.
router.put('/posts/:id', (req, res) => {
  const found = findPostForPortalUser(req, req.params.id);
  if (!found) return res.status(404).json({ error: 'Post not found' });

  const { title, body } = req.body || {};
  const newTitle = typeof title === 'string' ? title.trim() : '';
  const newBody  = typeof body  === 'string' ? body.trim()  : '';

  if (!newBody) {
    return res.status(400).json({ error: 'Post body cannot be empty.' });
  }

  // Mutate the post in place inside the posts array, then write back.
  const { campaign, posts, postIndex, post } = found;
  posts[postIndex] = {
    ...post,
    topic: newTitle || post.topic,
    linkedin_post_text: newBody,
  };
  markApproved(posts[postIndex], req);
  writeCampaignPosts(campaign.id, posts);

  audit('portal_post_save_approve', req, req.params.id, { campaign_id: campaign.id });

  res.json({
    ok: true,
    post: projectPost(posts[postIndex], postIndex),
  });
});

// ─── POST /api/portal/posts/:id/approve ───────────────────────────────────────
// Approve without editing. Same semantics as PUT but no copy changes.
router.post('/posts/:id/approve', (req, res) => {
  const found = findPostForPortalUser(req, req.params.id);
  if (!found) return res.status(404).json({ error: 'Post not found' });

  const { campaign, posts, postIndex } = found;
  markApproved(posts[postIndex], req);
  writeCampaignPosts(campaign.id, posts);

  audit('portal_post_approve', req, req.params.id, { campaign_id: campaign.id });

  res.json({
    ok: true,
    post: projectPost(posts[postIndex], postIndex),
  });
});

// ─── POST /api/portal/posts/:id/regenerate ────────────────────────────────────
// Customer-side regen. Mirrors the admin-side regenerate-post + regenerate-image
// pattern from routes/campaigns.js: rewrite the text via Anthropic, then
// generate a fresh image via Gemini, upload to R2, write the post back.
//
// Soft-cap of 30 regens per email_client per rolling 24h via client_post_regens.
// We count BEFORE running the (slow + costly) AI calls so an over-cap customer
// gets a fast 429 rather than a 30s timeout.
//
// On regen, any prior approval is dropped — the customer should review the new
// content before approving again.
router.post('/posts/:id/regenerate', async (req, res) => {
  const found = findPostForPortalUser(req, req.params.id);
  if (!found) return res.status(404).json({ error: 'Post not found' });

  // Soft cap check — count regens for this customer in the last 24h.
  const REGEN_CAP_PER_DAY = 30;
  const usedToday = db.prepare(`
    SELECT COUNT(*) AS n FROM client_post_regens
    WHERE email_client_id = ? AND created_at >= datetime('now', '-1 day')
  `).get(req.portalClient.id).n;

  if (usedToday >= REGEN_CAP_PER_DAY) {
    return res.status(429).json({
      error: `Daily regenerate limit reached (${REGEN_CAP_PER_DAY}/day). Please try again tomorrow.`,
      used:  usedToday,
      limit: REGEN_CAP_PER_DAY,
    });
  }

  const { campaign, posts, postIndex, post } = found;

  // Resolve the LinkedIn client row — needed by both the text regen (uses
  // client.rag_content) and the image gen (uses client name + brand context).
  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(campaign.client_id);
  if (!client) {
    return res.status(404).json({ error: 'Linked LinkedIn client not found' });
  }

  // 1. Regenerate the post text. This is the slow part (~5-10s).
  let rewritten;
  try {
    rewritten = await regenerateSinglePost(post, client);
  } catch (err) {
    console.error(`[portal] regen text failed post ${req.params.id}:`, err.message);
    return res.status(502).json({ error: `Text regeneration failed: ${err.message}` });
  }

  // 2. Regenerate the image. We do this AFTER text so the new image_prompt
  //    (if the model returned one) is used. Image failure is non-fatal — the
  //    post still saves with the new text and the old image stays.
  let newImageUrl = post.image_url || null;
  let imageError  = null;
  const updatedPost = {
    ...post,
    linkedin_post_text: rewritten.linkedin_post_text || post.linkedin_post_text,
    image_prompt:       rewritten.image_prompt       || post.image_prompt,
    // Drop any prior approval — customer must re-review the new content.
    client_approved_at: null,
    client_approved_by_user_id: null,
  };

  try {
    const imageData = await generateImage(
      updatedPost.image_prompt || `Professional LinkedIn image for: ${updatedPost.topic}`,
      client,
      updatedPost,
    );
    newImageUrl = await uploadImageToR2(
      imageData.data,
      imageData.mimeType,
      client.id,
      updatedPost.id || `post-${postIndex}`,
    );
    updatedPost.image_url   = newImageUrl;
    updatedPost.image_error = undefined;
  } catch (err) {
    console.error(`[portal] regen image failed post ${req.params.id}:`, err.message);
    imageError = err.message;
    updatedPost.image_error = err.message;
  }

  // 3. Persist + count this regen against the cap.
  posts[postIndex] = updatedPost;
  writeCampaignPosts(campaign.id, posts);

  db.prepare(`
    INSERT INTO client_post_regens (email_client_id, client_user_id, campaign_id, post_id)
    VALUES (?, ?, ?, ?)
  `).run(req.portalClient.id, req.portalUser.id, campaign.id, req.params.id);

  audit('portal_post_regenerate', req, req.params.id, {
    campaign_id: campaign.id,
    image_error: imageError,
    regens_used_today: usedToday + 1,
  });

  res.json({
    ok: true,
    post: projectPost(updatedPost, postIndex),
    regens_used_today: usedToday + 1,
    regens_remaining: REGEN_CAP_PER_DAY - (usedToday + 1),
    image_error: imageError, // surface non-fatal image failure to the UI
  });
});

// ─── POST /api/portal/campaigns/:id/posts/approve-all ─────────────────────────
// The big one. Marks every post in the campaign approved AND pushes them all
// to Supergrow as live queue_post calls in posts_json order.
//
// Behaviour:
//   - All posts succeed   → flip stage to 'deployed', return ok=true
//   - Some posts fail     → leave stage at 'awaiting_approval', mark only the
//                           successfully-pushed ones with client_approved_at,
//                           return ok=false + per-post error array. The portal
//                           still shows the batch so retry is possible.
//   - First post fails    → same partial-failure path (no posts queued)
//
// Why sequential, not parallel: Supergrow's queue order matters (post 1 first,
// post 2 second, etc.) — parallel calls could land out of order. Mirrors the
// admin-side deployToDrafts pattern.
router.post('/campaigns/:id/posts/approve-all', async (req, res) => {
  const found = findCampaignForPortalUser(req, req.params.id);
  if (!found) return res.status(404).json({ error: 'Campaign not found' });

  const { campaign, posts } = found;
  if (campaign.stage !== 'awaiting_approval') {
    return res.status(409).json({
      error: `Campaign is in stage "${campaign.stage}" — only awaiting_approval campaigns can be bulk-approved.`,
    });
  }
  if (posts.length === 0) {
    return res.status(400).json({ error: 'No posts to approve.' });
  }

  // Resolve the LinkedIn client row for Supergrow credentials.
  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(campaign.client_id);
  if (!client || !client.supergrow_workspace_id || !client.supergrow_api_key) {
    return res.status(500).json({
      error: 'LinkedIn client is not fully configured for Supergrow push.',
    });
  }

  // Push posts sequentially. Track outcomes per post so we can produce a
  // useful response and audit row regardless of which posts succeed.
  const results = [];
  let succeeded = 0;
  let firstFailureIndex = -1;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    try {
      const result = await queuePost({
        workspaceId: client.supergrow_workspace_id,
        apiKey:      client.supergrow_api_key,
        postText:    post.linkedin_post_text || '',
        imageUrls:   post.image_url ? [post.image_url] : [],
      });

      // Supergrow returns its post id + app_url inside the MCP response payload.
      // Mirror the admin-side createDraft parse to capture both for the record.
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

      // Mark approved + record Supergrow IDs on the post.
      posts[i] = {
        ...post,
        supergrow_post_id: supergrowPostId,
        supergrow_app_url: supergrowAppUrl,
      };
      markApproved(posts[i], req);
      succeeded++;
      results.push({ postId: post.id, status: 'success', supergrow_post_id: supergrowPostId });

    } catch (err) {
      console.error(`[portal] approve-all push failed post ${i + 1}/${posts.length}:`, err.message);
      if (firstFailureIndex === -1) firstFailureIndex = i;
      results.push({ postId: post.id, status: 'failed', error: err.message });
      // STOP on first failure — don't keep trying. The blueprint's partial-
      // failure semantics are "succeeded posts stay queued, failed and remaining
      // stay un-approved for retry". Continuing past a failure could land posts
      // out of order in Supergrow's queue, which silently breaks the customer's
      // intended sequence. Fail-fast is safer.
      break;
    }
  }

  // Persist whatever we managed to do (including the partial successes).
  writeCampaignPosts(campaign.id, posts);

  const allSucceeded = succeeded === posts.length;

  if (allSucceeded) {
    db.prepare(`UPDATE campaigns SET stage = 'deployed' WHERE id = ?`).run(campaign.id);
    audit('portal_approve_all', req, campaign.id, {
      campaign_id: campaign.id,
      posts_total: posts.length,
      posts_succeeded: succeeded,
    });
    return res.json({
      ok: true,
      stage: 'deployed',
      total: posts.length,
      succeeded,
      failed: 0,
      results,
    });
  }

  // Partial failure — leave stage alone, audit for debuggability.
  audit('portal_approve_all_partial', req, campaign.id, {
    campaign_id: campaign.id,
    posts_total: posts.length,
    posts_succeeded: succeeded,
    posts_failed: posts.length - succeeded,
    first_failure_index: firstFailureIndex,
    first_failure_error: results[firstFailureIndex]?.error || null,
  });
  return res.status(207).json({
    ok: false,
    stage: campaign.stage, // still 'awaiting_approval'
    total: posts.length,
    succeeded,
    failed: posts.length - succeeded,
    first_failure_index: firstFailureIndex,
    error: `Pushed ${succeeded} of ${posts.length} posts to Supergrow before hitting an error. The remaining posts can be retried.`,
    results,
  });
});

export default router;
