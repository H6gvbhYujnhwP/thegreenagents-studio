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
import {
  parseRules,
  validatePostAgainstRules,
  RULE_MAX_LENGTH,
  RULES_MAX_COUNT,
} from '../services/content-rules.js';
import { generateImage, recompositeLogoFromUrl } from '../services/gemini.js';
import { uploadImageToR2 } from '../services/r2.js';
import { queuePost } from '../services/supergrow.js';
import { sendEmail } from '../services/ses.js';
import { resolveLinkedSet, resolveCrmCustomerId, buildSubscriptionsPanel, applySubscriptionsUpdate } from './hot-prospects.js';
import { metaConfigured, getAdsOverview, getPixelStats } from '../services/meta-api.js';
import { v4 as uuid } from 'uuid';

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

// ─── Helper: resolve the linked email_clients id for this portal customer ────
//
// The portal customer (e.g. Cube6) is itself a row in email_clients, but their
// inbox mailboxes and email campaigns might live under a different email_clients
// row (e.g. mail.engineersolutions.co.uk). The customer_services table joins them
// via service_key='email' — linked_external_id points at the email_clients row
// that owns the actual mailboxes. Falls back to the customer's own id when the
// service is self-linked (the natural default — see Decision #14 in the blueprint).
// Returns null when the customer doesn't have email service enabled.
function resolveEmailClientId(portalEmailClientId) {
  const cs = db.prepare(`
    SELECT linked_external_id FROM customer_services
    WHERE email_client_id = ? AND service_key = 'email'
  `).get(portalEmailClientId);
  // No subscription → no email service.
  if (!cs) return null;
  // Subscription exists but no link → email is enabled, defaulting to the
  // customer's own row (legacy bool toggle).
  if (!cs.linked_external_id) return portalEmailClientId;
  return cs.linked_external_id;
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
/**
 * projectPost — serialise a post for the portal frontend.
 *
 * The `client` arg is optional and only used to supply the customer-level
 * default_logo_position / default_logo_size, which the portal post card
 * uses as the initial value for the per-post logo dropdowns when the post
 * itself has no override yet. If `client` is not passed (legacy callers,
 * read-only history projections) the defaults fall back to 'bottom-right'
 * and 'small' — matching the original pre-feature behaviour.
 */
function projectPost(post, index, client = null) {
  const day  = post.suggested_day  || '';
  const time = post.suggested_time || '';
  const schedule = (day || time) ? `${day} ${time}`.trim() : `Post ${index + 1}`;
  // validation_warnings: array of { ruleId, ruleText, reason } objects attached
  // by the generation/regen pipeline when the AI couldn't fully obey the
  // customer's refine-my-posts rules. Null when the post passes cleanly or
  // when no rules exist for this customer. Surfaced to the portal so the
  // customer sees which rule was likely violated and can adjust their rules.
  return {
    id:                post.id || `post_${index + 1}`,
    order:             index + 1,
    title:             post.topic || `Post ${index + 1}`,
    topic:             post.topic || '',
    body:              post.linkedin_post_text || '',
    image_url:         post.image_url || null,
    image_error:       post.image_error || null,
    scheduled_for:     schedule,
    suggested_day:     day,
    suggested_time:    time,
    content_pillar:    post.content_pillar || '',
    format:            post.format || '',
    approved:          !!post.client_approved_at,
    approved_at:       post.client_approved_at || null,
    approved_by:       post.client_approved_by_user_id || null,
    validation_warnings: Array.isArray(post.validation_warnings) && post.validation_warnings.length > 0
      ? post.validation_warnings
      : null,
    // Per-post logo overrides (null = use customer-level default).
    logo_position:     post.logo_position || null,
    logo_size:         post.logo_size     || null,
    logo_panel:        post.logo_panel    || null,
    // Whether per-post logo dropdowns are usable on this post. False when
    // the post has no stored pre-logo image (i.e. it was generated before
    // this feature shipped) — frontend greys out the dropdowns and shows
    // a "Click New image to enable" hint.
    logo_controls_enabled: !!post.pre_logo_image_url,
    // Customer-level defaults — frontend uses these as the dropdown
    // initial value when the post has no override.
    default_logo_position: (client && client.logo_position) || 'bottom-right',
    default_logo_size:     (client && client.logo_size)     || 'small',
    default_logo_panel:    (client && client.logo_panel)    || 'white',
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
  // The campaigns table doesn't have a title column — generated post batches
  // are identified by id and creation date; the portal shows a generic header.
  const campaign = db.prepare(`
    SELECT id, stage, posts_json, created_at
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

  // Fetch the LinkedIn client so we can pass its logo defaults into the
  // projection. The frontend's per-post logo dropdowns initialise from
  // post.default_logo_position / default_logo_size / default_logo_panel —
  // sourced from the clients row's logo_position/logo_size/logo_panel set
  // by the admin.
  const client = db.prepare(`SELECT logo_position, logo_size, logo_panel FROM clients WHERE id = ?`).get(linkedinClientId);

  res.json({
    posts: posts.map((p, i) => projectPost(p, i, client)),
    campaign: {
      id:    campaign.id,
      title: 'Posts ready for review',
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

  // Normalise to a string up front. Express URL params are always strings,
  // but post.id values inside posts_json are NUMBERS (Claude's generation
  // schema literally says "id": 1, "id": 2, ...). A strict === between a
  // number and a string would always be false, which is the bug Tower Leasing
  // hit on every Edit/Approve/Rewrite/New image action.
  //
  // Also tolerate the synthesised-id form ("post_1") that projectPost emits
  // for the rare case of a post object that genuinely lacks an id field.
  // Defensive — don't lose either path.
  const wantedId = String(postId);

  // Scan awaiting_approval campaigns for this customer's linked client until we
  // find the post. In practice there's almost always exactly one such campaign
  // (the most recent), so this is a cheap loop. We don't restrict to the most
  // recent only — if for some reason an older awaiting_approval batch is still
  // open (admin error, partial-failure retry) we still let the customer act
  // on it.
  const campaigns = db.prepare(`
    SELECT id, client_id, stage, posts_json, created_at
    FROM campaigns
    WHERE client_id = ? AND stage = 'awaiting_approval'
    ORDER BY created_at DESC
  `).all(linkedinClientId);

  for (const campaign of campaigns) {
    let posts = [];
    try { posts = JSON.parse(campaign.posts_json || '[]'); } catch (_) { posts = []; }
    const idx = posts.findIndex((p, i) => {
      const synthId = `post_${i + 1}`;
      if (p.id !== undefined && p.id !== null && String(p.id) === wantedId) return true;
      if ((p.id === undefined || p.id === null) && wantedId === synthId) return true;
      return false;
    });
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
    SELECT id, stage, posts_json, created_at, client_id
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

  // Pass the client's logo defaults through so the frontend's per-post
  // dropdowns know what to fall back to when the post has no override.
  const editClient = db.prepare(`SELECT logo_position, logo_size, logo_panel FROM clients WHERE id = ?`).get(campaign.client_id);
  res.json({
    ok: true,
    post: projectPost(posts[postIndex], postIndex, editClient),
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

  const approveClient = db.prepare(`SELECT logo_position, logo_size, logo_panel FROM clients WHERE id = ?`).get(campaign.client_id);
  res.json({
    ok: true,
    post: projectPost(posts[postIndex], postIndex, approveClient),
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

  // 1b. Validate the rewrite against the customer's refine-my-posts rules.
  //     Rules are read FRESH from the client row so edits/deletes apply
  //     immediately. Failing open on validation errors (network etc.) — see
  //     content-rules.js for the rationale.
  const rules = parseRules(client);
  let validationWarnings;
  if (rules.length > 0) {
    const check = await validatePostAgainstRules(
      rewritten.linkedin_post_text || post.linkedin_post_text,
      rules
    );
    validationWarnings = check.ok ? undefined : check.violations;
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
    // Cleared (undefined) when rules pass — wipes any stale warning from a
    // previous generation. Set to the violation list when rules fail.
    validation_warnings: validationWarnings,
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
    // Reset per-post logo overrides — full regen produces a fresh image,
    // dropdowns should fall back to customer-level defaults.
    updatedPost.logo_position = null;
    updatedPost.logo_size     = null;
    updatedPost.logo_panel    = null;
    // Save pre-logo bytes for the per-post recomposite endpoint.
    if (imageData.preLogoData) {
      try {
        const preLogoUrl = await uploadImageToR2(
          imageData.preLogoData,
          imageData.preLogoMime,
          client.id,
          `${updatedPost.id || `post-${postIndex}`}-prelogo`,
        );
        updatedPost.pre_logo_image_url = preLogoUrl;
      } catch (e) {
        console.warn(`[portal] pre-logo upload failed (non-fatal): ${e.message}`);
      }
    }
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
    post: projectPost(updatedPost, postIndex, client),
    regens_used_today: usedToday + 1,
    regens_remaining: REGEN_CAP_PER_DAY - (usedToday + 1),
    image_error: imageError, // surface non-fatal image failure to the UI
  });
});

// ─── POST /api/portal/posts/:id/regenerate-text ───────────────────────────────
// Text-only regen — mirrors the admin-side "Rewrite post" button.
// Counts toward the SAME 30/day cap as image regens (combined cap, locked
// pre-decision). Approval is dropped on a successful rewrite — customer must
// re-review the new content.
router.post('/posts/:id/regenerate-text', async (req, res) => {
  const found = findPostForPortalUser(req, req.params.id);
  if (!found) return res.status(404).json({ error: 'Post not found' });

  // Combined cap check — same query as /regenerate.
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
  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(campaign.client_id);
  if (!client) return res.status(404).json({ error: 'Linked LinkedIn client not found' });

  let rewritten;
  try {
    rewritten = await regenerateSinglePost(post, client);
  } catch (err) {
    console.error(`[portal] regen-text failed post ${req.params.id}:`, err.message);
    return res.status(502).json({ error: `Text regeneration failed: ${err.message}` });
  }

  // Validate the rewrite against the customer's refine-my-posts rules.
  // Rules are read FRESH from the client row (which was just fetched above),
  // so any edit/delete the customer made to their rules takes effect on the
  // very next regen with no caching window.
  const rules = parseRules(client);
  let validationWarnings;
  if (rules.length > 0) {
    const check = await validatePostAgainstRules(
      rewritten.linkedin_post_text || post.linkedin_post_text,
      rules
    );
    validationWarnings = check.ok ? undefined : check.violations;
  }

  // Update text + image_prompt, drop approval. Image stays as-is.
  // validation_warnings: set when rules were violated, cleared otherwise so a
  // stale warning from a previous generation doesn't persist after a clean regen.
  const updatedPost = {
    ...post,
    linkedin_post_text: rewritten.linkedin_post_text || post.linkedin_post_text,
    image_prompt:       rewritten.image_prompt       || post.image_prompt,
    client_approved_at: null,
    client_approved_by_user_id: null,
    validation_warnings: validationWarnings, // undefined wipes the field on serialization
  };
  posts[postIndex] = updatedPost;
  writeCampaignPosts(campaign.id, posts);

  db.prepare(`
    INSERT INTO client_post_regens (email_client_id, client_user_id, campaign_id, post_id)
    VALUES (?, ?, ?, ?)
  `).run(req.portalClient.id, req.portalUser.id, campaign.id, req.params.id);

  audit('portal_post_regenerate_text', req, req.params.id, {
    campaign_id: campaign.id,
    regens_used_today: usedToday + 1,
  });

  res.json({
    ok: true,
    post: projectPost(updatedPost, postIndex, client),
    regens_used_today: usedToday + 1,
    regens_remaining: REGEN_CAP_PER_DAY - (usedToday + 1),
  });
});

// ─── POST /api/portal/posts/:id/regenerate-image ──────────────────────────────
// Image-only regen — mirrors the admin-side "New image" button.
// Same combined 30/day cap as text regen. Approval is dropped on success.
router.post('/posts/:id/regenerate-image', async (req, res) => {
  const found = findPostForPortalUser(req, req.params.id);
  if (!found) return res.status(404).json({ error: 'Post not found' });

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
  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(campaign.client_id);
  if (!client) return res.status(404).json({ error: 'Linked LinkedIn client not found' });

  let newImageUrl;
  let newPreLogoUrl = null;
  try {
    const imageData = await generateImage(
      post.image_prompt || `Professional LinkedIn image for: ${post.topic}`,
      client,
      post,
    );
    newImageUrl = await uploadImageToR2(
      imageData.data,
      imageData.mimeType,
      client.id,
      post.id || `post-${postIndex}`,
    );
    // Also store the pre-logo bytes for the per-post recomposite endpoint.
    // Non-fatal if it fails — main image upload already succeeded; customer
    // just won't be able to use the per-post logo dropdowns on this post
    // until they click New image again.
    if (imageData.preLogoData) {
      try {
        newPreLogoUrl = await uploadImageToR2(
          imageData.preLogoData,
          imageData.preLogoMime,
          client.id,
          `${post.id || `post-${postIndex}`}-prelogo`,
        );
      } catch (e) {
        console.warn(`[portal] pre-logo upload failed (non-fatal): ${e.message}`);
      }
    }
  } catch (err) {
    console.error(`[portal] regen-image failed post ${req.params.id}:`, err.message);
    return res.status(502).json({ error: `Image regeneration failed: ${err.message}` });
  }

  const updatedPost = {
    ...post,
    image_url: newImageUrl,
    pre_logo_image_url: newPreLogoUrl || post.pre_logo_image_url || null,
    // Reset per-post logo overrides on a full regen — new image, new
    // dropdown state. Customer can re-tweak per-post logo after this.
    logo_position: null,
    logo_size: null,
    logo_panel: null,
    image_error: undefined,
    // Drop approval — content has changed, customer must re-review.
    client_approved_at: null,
    client_approved_by_user_id: null,
  };
  posts[postIndex] = updatedPost;
  writeCampaignPosts(campaign.id, posts);

  db.prepare(`
    INSERT INTO client_post_regens (email_client_id, client_user_id, campaign_id, post_id)
    VALUES (?, ?, ?, ?)
  `).run(req.portalClient.id, req.portalUser.id, campaign.id, req.params.id);

  audit('portal_post_regenerate_image', req, req.params.id, {
    campaign_id: campaign.id,
    regens_used_today: usedToday + 1,
  });

  res.json({
    ok: true,
    post: projectPost(updatedPost, postIndex, client),
    regens_used_today: usedToday + 1,
    regens_remaining: REGEN_CAP_PER_DAY - (usedToday + 1),
  });
});

// ─── POST /api/portal/posts/:id/recomposite-logo ──────────────────────────────
// Per-post logo position/size override. Re-runs only the compositor on the
// previously-stored pre-logo image — no Gemini call, no AI cost, ~½ second
// response. Lets the customer try Position/Size combos on a per-post basis
// from the dropdowns on each post card.
//
// Background panel ('white' vs 'none') is NOT per-post overridable — that
// stays a customer-level decision on the admin side. The two knobs customers
// get are Position and Size, both stored on the post as logo_position and
// logo_size; null means "use customer-level default."
//
// Does NOT count against the 30/day regen cap — this isn't a regen, it's a
// pixel-pushing re-composite of an image that's already been generated.
// Cost is effectively zero.
//
// Returns 400 with { error: 'pre_logo_unavailable' } when the post has no
// stored pre-logo image (i.e. the post was generated before this feature
// shipped). The frontend uses this signal to show "Click New image first to
// enable these controls" rather than a generic error.
router.post('/posts/:id/recomposite-logo', async (req, res) => {
  const found = findPostForPortalUser(req, req.params.id);
  if (!found) return res.status(404).json({ error: 'Post not found' });

  const { campaign, posts, postIndex, post } = found;

  // Validate inputs. All three fields are optional — frontend may send
  // only one (e.g. the customer just changed Position). Null/missing =
  // leave the existing per-post override alone.
  const ALLOWED_POSITIONS = ['bottom-right', 'top-right', 'bottom-left', 'top-left'];
  const ALLOWED_SIZES     = ['small', 'medium', 'large'];
  const ALLOWED_PANELS    = ['white', 'none'];

  const reqPosition = req.body?.logo_position;
  const reqSize     = req.body?.logo_size;
  const reqPanel    = req.body?.logo_panel;

  if (reqPosition !== undefined && reqPosition !== null && !ALLOWED_POSITIONS.includes(reqPosition)) {
    return res.status(400).json({ error: `Invalid logo_position: ${reqPosition}` });
  }
  if (reqSize !== undefined && reqSize !== null && !ALLOWED_SIZES.includes(reqSize)) {
    return res.status(400).json({ error: `Invalid logo_size: ${reqSize}` });
  }
  if (reqPanel !== undefined && reqPanel !== null && !ALLOWED_PANELS.includes(reqPanel)) {
    return res.status(400).json({ error: `Invalid logo_panel: ${reqPanel}` });
  }

  // Pre-logo image must exist for re-composite to work. Posts generated
  // before this feature shipped (pre-deploy posts) won't have one — return
  // a specific error code so the frontend can show the right hint.
  if (!post.pre_logo_image_url) {
    return res.status(400).json({
      error: 'pre_logo_unavailable',
      message: 'This post was generated before per-post logo controls were available. Click "New image" to enable them on this post.',
    });
  }

  const client = db.prepare(`SELECT * FROM clients WHERE id = ?`).get(campaign.client_id);
  if (!client) return res.status(404).json({ error: 'Linked LinkedIn client not found' });
  if (!client.logo_url) {
    return res.status(400).json({ error: 'No customer logo configured — re-composite has nothing to place.' });
  }

  // Resolve the effective overrides: the value supplied in this request
  // (if any) wins; otherwise fall back to whatever's already stored on the
  // post; otherwise fall back to the customer-level default (handled
  // inside compositeLogo). That way a request that only changes Position
  // preserves the existing Size and Panel overrides rather than resetting
  // them.
  const effectivePosition = (reqPosition !== undefined && reqPosition !== null)
    ? reqPosition
    : (post.logo_position || null);
  const effectiveSize = (reqSize !== undefined && reqSize !== null)
    ? reqSize
    : (post.logo_size || null);
  const effectivePanel = (reqPanel !== undefined && reqPanel !== null)
    ? reqPanel
    : (post.logo_panel || null);

  let newImageUrl;
  try {
    const overrides = {};
    if (effectivePosition) overrides.logo_position = effectivePosition;
    if (effectiveSize)     overrides.logo_size     = effectiveSize;
    if (effectivePanel)    overrides.logo_panel    = effectivePanel;

    const imageData = await recompositeLogoFromUrl(
      post.pre_logo_image_url,
      client,
      overrides
    );
    newImageUrl = await uploadImageToR2(
      imageData.data,
      imageData.mimeType,
      client.id,
      `${post.id || `post-${postIndex}`}-recomp`
    );
  } catch (err) {
    console.error(`[portal] recomposite-logo failed post ${req.params.id}:`, err.message);
    return res.status(502).json({ error: `Logo re-composite failed: ${err.message}` });
  }

  const updatedPost = {
    ...post,
    image_url: newImageUrl,
    // Store the resolved overrides so subsequent GET /posts loads show the
    // correct dropdown values. Pre-logo URL and post text are unchanged.
    logo_position: effectivePosition,
    logo_size:     effectiveSize,
    logo_panel:    effectivePanel,
  };
  posts[postIndex] = updatedPost;
  writeCampaignPosts(campaign.id, posts);

  audit('portal_post_recomposite_logo', req, req.params.id, {
    campaign_id: campaign.id,
    logo_position: effectivePosition,
    logo_size:     effectiveSize,
    logo_panel:    effectivePanel,
  });

  res.json({
    ok: true,
    post: projectPost(updatedPost, postIndex, client),
  });
});

// ─── POST /api/portal/campaigns/:id/posts/approve-all ─────────────────────────
// The big one. Marks every post in the campaign approved AND pushes them all
// to Supergrow as live queue_post calls in posts_json order.
//
// Behaviour:
//   - All posts succeed   → flip stage='done', status='completed',
//                           deployed_by='portal'. Return ok=true.
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
        imageUrl:    post.image_url || null,
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
    // End-state on customer-portal approve-all matches admin-side deploy:
    //   stage='done', status='completed' — both terminal values that the
    //   admin's CampaignProgress UI already recognises. deployed_by='portal'
    //   is the only thing that distinguishes the two paths, used by the admin
    //   campaign card to render a 'Customer approved' pill instead of the
    //   normal 'Deployed' one.
    db.prepare(`
      UPDATE campaigns
         SET stage = 'done',
             status = 'completed',
             deployed_by = 'portal',
             completed_at = datetime('now')
       WHERE id = ?
    `).run(campaign.id);
    audit('portal_approve_all', req, campaign.id, {
      campaign_id: campaign.id,
      posts_total: posts.length,
      posts_succeeded: succeeded,
    });
    return res.json({
      ok: true,
      stage: 'done',
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

// ─── GET /api/portal/campaigns-history ────────────────────────────────────────
// Read-only history of past campaigns for this customer's LinkedIn client.
// A campaign is in history once the work is finished — either the customer
// approved it via approve-all OR admin pushed it direct to Supergrow drafts.
// Both paths now end on stage='done' (the legacy 'deployed' value was migrated
// into 'done' on boot — see db.js). The deployed_by column distinguishes the
// two paths if support ever needs to know who finished a given campaign.
//
// Each campaign comes back with its full projected posts array so the frontend
// can expand a card without a second round-trip. Posts that aren't approved
// individually still appear (image + text), so the customer sees the complete
// batch they signed off on.
router.get('/campaigns-history', (req, res) => {
  const linkedinClientId = resolveLinkedinClientId(req.portalClient.id);
  if (!linkedinClientId) {
    return res.json({ campaigns: [], not_subscribed: true });
  }

  const rows = db.prepare(`
    SELECT id, stage, posts_json, created_at, completed_at
    FROM campaigns
    WHERE client_id = ? AND stage = 'done'
    ORDER BY COALESCE(completed_at, created_at) DESC
  `).all(linkedinClientId);

  const campaigns = rows.map(row => {
    let posts = [];
    try { posts = JSON.parse(row.posts_json || '[]'); } catch (_) { posts = []; }
    return {
      id:           row.id,
      stage:        row.stage,
      created_at:   row.created_at,
      completed_at: row.completed_at,
      post_count:   posts.length,
      cover_url:    posts[0]?.image_url || null,
      first_topic:  posts[0]?.topic || null,
      posts:        posts.map(projectPost),
    };
  });

  res.json({ campaigns, not_subscribed: false });
});

// ─── 3b-ii: Inbox routes ──────────────────────────────────────────────────────
// All filter by the email-service-linked email_client (see resolveEmailClientId
// above). When the customer doesn't have email service, GET /inbox returns
// empty with not_subscribed=true; the per-id routes 404.
//
// Per-customer security: every query passes the resolved email_client_id as a
// filter. We never trust an id from the URL or body. 404 (not 403) for cross-
// tenant lookups so we don't leak existence of other customers' replies.

// ─────────────────────────────────────────────────────────────────────────────
// attachInboxBadges(rows, ecid)
//
// Mirror of the admin helper in server/routes/email.js, simplified because
// the portal request shape is single-tenant (every row shares one
// email_client_id, passed in as `ecid`).
//
// Decorates each row with:
//   hot_prospect_id              — UUID of matching hot_prospects row or null.
//                                  Drives the "On Hot Prospects list" badge
//                                  AND is the click target for the in-tree
//                                  navigateToCrmWithProspect() handoff.
//   hot_prospect_crm_customer_id — Included for parity with admin; the portal
//                                  is single-tenant so the frontend doesn't
//                                  use it, but returning it keeps the
//                                  endpoint shape symmetric.
//   contact_unsubscribed         — true if the sender is unsubscribed from
//                                  any of this customer's lists (status or
//                                  unsubscribed_at populated).
//
// Hot-prospects lookup uses the full linked set per decision #85; subscribers
// belong to a single email_client so that lookup uses ecid directly.
//
// Errors are caught and logged so a JOIN failure never blanks out the inbox.
// ─────────────────────────────────────────────────────────────────────────────
function attachInboxBadges(rows, ecid) {
  for (const r of rows) {
    r.hot_prospect_id = null;
    r.hot_prospect_crm_customer_id = null;
    r.contact_unsubscribed = false;
  }
  if (!rows || rows.length === 0 || !ecid) return rows;

  try {
    const addrSet = new Set();
    for (const r of rows) {
      const a = r.from_address ? String(r.from_address).toLowerCase() : null;
      if (a) addrSet.add(a);
    }
    if (addrSet.size === 0) return rows;
    const addrs = Array.from(addrSet);
    const addrPlaceholders = addrs.map(() => '?').join(',');

    // Hot Prospects: across the full linked set
    const linkedIds = resolveLinkedSet(ecid);
    const idPlaceholders = linkedIds.map(() => '?').join(',');
    const hpRows = db.prepare(`
      SELECT id, email_client_id, LOWER(prospect_email) AS addr
      FROM hot_prospects
      WHERE email_client_id IN (${idPlaceholders})
        AND LOWER(prospect_email) IN (${addrPlaceholders})
    `).all(...linkedIds, ...addrs);
    const hpByAddr = new Map();
    for (const hp of hpRows) {
      hpByAddr.set(hp.addr, {
        id: hp.id,
        crm_customer_id: resolveCrmCustomerId(hp.email_client_id),
      });
    }

    // Subscribers: linked-set scoping too (not just the single ecid).
    // For a linked customer (Cube6 anchor + mail.eng inbox row, decision #85)
    // the mailing lists live under the anchor, not the inbox row. Scoping the
    // subscribers JOIN to the inbox row alone would miss every real
    // unsubscribe. Use the same linked-set as Hot Prospects above so the
    // answer is correct regardless of which row owns the lists.
    const subRows = db.prepare(`
      SELECT DISTINCT LOWER(s.email) AS addr
      FROM email_subscribers s
      JOIN email_lists l ON l.id = s.list_id
      WHERE l.email_client_id IN (${idPlaceholders})
        AND LOWER(s.email) IN (${addrPlaceholders})
        AND (s.status = 'unsubscribed' OR s.unsubscribed_at IS NOT NULL)
    `).all(...linkedIds, ...addrs);
    const unsubAddrs = new Set(subRows.map(r => r.addr));

    for (const r of rows) {
      const a = r.from_address ? String(r.from_address).toLowerCase() : null;
      if (!a) continue;
      const hp = hpByAddr.get(a);
      if (hp) {
        r.hot_prospect_id = hp.id;
        r.hot_prospect_crm_customer_id = hp.crm_customer_id;
      }
      if (unsubAddrs.has(a)) r.contact_unsubscribed = true;
    }
  } catch (e) {
    console.warn('[portal] attachInboxBadges failed (non-fatal):', e?.message || e);
  }
  return rows;
}

// ─── GET /api/portal/inbox ────────────────────────────────────────────────────
// Recent replies for this customer's mailboxes. Frontend renders each row with
// from name + address, subject, snippet, classification badge (Prospect / OOO /
// Unsub'd / Neutral), received_at (relative time), and the campaign title if
// the reply matched a campaign.
//
// Limit 100 so the page stays responsive on large mailboxes.
router.get('/inbox', (req, res) => {
  const linkedEmailClientId = resolveEmailClientId(req.portalClient.id);
  if (!linkedEmailClientId) {
    return res.json({ replies: [], not_subscribed: true });
  }

  const rows = db.prepare(`
    SELECT
      r.id, r.from_address, r.from_name, r.subject, r.body_text, r.received_at,
      r.classification, r.auto_unsubscribed, r.matched_campaign_id,
      c.title AS campaign_title
    FROM email_replies r
    LEFT JOIN email_campaigns c ON c.id = r.matched_campaign_id
    WHERE r.email_client_id = ?
    ORDER BY r.received_at DESC
    LIMIT 100
  `).all(linkedEmailClientId);

  // Decorate every row with the Hot Prospect + Unsubscribed status badges.
  attachInboxBadges(rows, linkedEmailClientId);

  // Build a short snippet (first ~160 chars of body_text, or empty). This is
  // what the inbox row preview shows; full body comes from GET /replies/:id.
  const replies = rows.map(r => ({
    id:                r.id,
    from_address:      r.from_address,
    from_name:         r.from_name || (r.from_address || '').split('@')[0],
    subject:           r.subject || '(no subject)',
    snippet:           (r.body_text || '').replace(/\s+/g, ' ').slice(0, 160).trim(),
    received_at:       r.received_at,
    classification:    r.classification || 'neutral',
    auto_unsubscribed: !!r.auto_unsubscribed,
    campaign_title:    r.campaign_title || null,
    step_number:       null, // step number isn't currently stored on email_replies
    hot_prospect_id:              r.hot_prospect_id              || null,
    hot_prospect_crm_customer_id: r.hot_prospect_crm_customer_id || null,
    contact_unsubscribed:         !!r.contact_unsubscribed,
  }));

  res.json({ replies, not_subscribed: false });
});

// ─── GET /api/portal/replies/:id ──────────────────────────────────────────────
// Full reply detail. Returns body_html (preferred for the threaded view) and
// body_text (fallback). 404 (not 403) when the reply belongs to a different
// customer's email_client — leaks no info about whether the id exists.
router.get('/replies/:id', (req, res) => {
  const linkedEmailClientId = resolveEmailClientId(req.portalClient.id);
  if (!linkedEmailClientId) return res.status(404).json({ error: 'Not found' });

  const row = db.prepare(`
    SELECT
      r.id, r.email_client_id, r.inbox_id, r.message_id,
      r.from_address, r.from_name, r.subject, r.body_text, r.body_html,
      r.received_at, r.classification, r.auto_unsubscribed,
      r.matched_campaign_id, r.in_reply_to, r.references_header,
      c.title AS campaign_title,
      i.email_address AS mailbox_address
    FROM email_replies r
    LEFT JOIN email_campaigns c ON c.id = r.matched_campaign_id
    LEFT JOIN email_inboxes i ON i.id = r.inbox_id
    WHERE r.id = ?
  `).get(req.params.id);

  if (!row || row.email_client_id !== linkedEmailClientId) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Decorate with the same two badge fields the list endpoint returns, so the
  // detail modal can render them alongside the classification badge.
  attachInboxBadges([row], linkedEmailClientId);

  res.json({
    id:                row.id,
    from_address:      row.from_address,
    from_name:         row.from_name || (row.from_address || '').split('@')[0],
    subject:           row.subject || '(no subject)',
    body_text:         row.body_text || '',
    body_html:         row.body_html || null,
    received_at:       row.received_at,
    classification:    row.classification || 'neutral',
    auto_unsubscribed: !!row.auto_unsubscribed,
    campaign_title:    row.campaign_title || null,
    mailbox_address:   row.mailbox_address || null,
    hot_prospect_id:              row.hot_prospect_id              || null,
    hot_prospect_crm_customer_id: row.hot_prospect_crm_customer_id || null,
    contact_unsubscribed:         !!row.contact_unsubscribed,
  });
});

// ─── POST /api/portal/replies/:id/send ────────────────────────────────────────
// Send a reply via SES. Body: { cc, body }.
//
// From-address: the mailbox the original reply was received on (locked-in
// product decision — natural threading, mailbox already SES-verified). The
// signed-in portal user's display name is used so the recipient sees who
// at the customer is replying.
//
// Threading: In-Reply-To = the reply's message_id; References = chain of
// references_header + message_id. Gmail/Outlook use these to thread the new
// outbound message into the existing conversation.
//
// We store one row in email_outbound regardless of SES outcome. error column
// captures the failure when SES throws — surfaces to admin via audit/log
// without losing the body the customer typed.
router.post('/replies/:id/send', async (req, res) => {
  const linkedEmailClientId = resolveEmailClientId(req.portalClient.id);
  if (!linkedEmailClientId) return res.status(404).json({ error: 'Not found' });

  const { cc = '', body = '' } = req.body || {};
  const bodyText = String(body || '').trim();
  const ccText   = String(cc   || '').trim();

  if (!bodyText) {
    return res.status(400).json({ error: 'Reply body cannot be empty.' });
  }

  // Resolve the reply + the mailbox it came in on. Same 404 rule as GET /:id.
  const reply = db.prepare(`
    SELECT
      r.id, r.email_client_id, r.inbox_id, r.message_id,
      r.from_address, r.from_name, r.subject,
      r.in_reply_to, r.references_header,
      i.email_address AS mailbox_address
    FROM email_replies r
    LEFT JOIN email_inboxes i ON i.id = r.inbox_id
    WHERE r.id = ?
  `).get(req.params.id);

  if (!reply || reply.email_client_id !== linkedEmailClientId) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!reply.mailbox_address) {
    return res.status(500).json({ error: 'Mailbox for this reply could not be resolved.' });
  }

  // Build the threading chain. The new References header is the inbound
  // reply's existing References + its message_id appended (per RFC 5322).
  // We tolerate either being null.
  const inReplyTo = reply.message_id || null;
  const refsParts = [
    reply.references_header || '',
    reply.message_id || '',
  ].filter(Boolean).join(' ').trim() || null;

  // Compose subject — prefix Re: if not already present.
  const inboundSubject = reply.subject || '';
  const replySubject = /^re:/i.test(inboundSubject)
    ? inboundSubject
    : `Re: ${inboundSubject || '(no subject)'}`;

  // From-name: use the portal user's username as a friendly label. Recipient
  // sees "Dave <david@mail.engineersolutions.co.uk>". When email column has
  // a value we prefer username over email for the display name.
  const fromName  = req.portalUser.username || 'Reply';
  const fromEmail = reply.mailbox_address;

  // HTML wrapper around the plain body — keeps formatting predictable and
  // gives Outlook/Gmail a clean threaded display. Plain newlines become <br>.
  const htmlBody = `<div>${bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>`;

  // Persist the outbound row up front (with no message_id yet). If SES throws
  // we update with error; on success we update with the SES MessageId. Either
  // way the customer's typed body is never lost.
  const outboundId = `eo_${uuid()}`;
  db.prepare(`
    INSERT INTO email_outbound (
      id, email_client_id, in_reply_to_reply_id, client_user_id,
      from_address, to_address, cc_address, subject,
      body_text, body_html,
      message_id, in_reply_to_header, references_header
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    outboundId,
    linkedEmailClientId,
    reply.id,
    req.portalUser.id,
    fromEmail,
    reply.from_address,
    ccText || null,
    replySubject,
    bodyText,
    htmlBody,
    null,
    inReplyTo,
    refsParts,
  );

  try {
    const { messageId } = await sendEmail({
      to:        reply.from_address,
      toName:    reply.from_name || null,
      fromName,
      fromEmail,
      replyTo:   fromEmail,
      subject:   replySubject,
      htmlBody,
      plainBody: bodyText,
      // No tracking on portal-sent replies — they're 1:1 conversations,
      // not campaign sends.
      track_opens:  false,
      track_clicks: false,
      track_unsub:  false,
      // Threading.
      inReplyTo,
      references: refsParts,
    });

    db.prepare(`UPDATE email_outbound SET message_id = ? WHERE id = ?`)
      .run(messageId || null, outboundId);

    res.json({ ok: true, message_id: messageId, outbound_id: outboundId });
  } catch (err) {
    console.error(`[portal] reply send failed for ${req.params.id}:`, err.message);
    db.prepare(`UPDATE email_outbound SET error = ? WHERE id = ?`)
      .run(err.message.slice(0, 500), outboundId);
    res.status(502).json({ error: `Send failed: ${err.message}` });
  }
});

// ─── POST /api/portal/replies/:id/manual-unsubscribe ──────────────────────────
// Customer-side unsubscribe button. Mirror of the admin endpoint in
// routes/email.js. Same three response shapes (ok=true / not_on_lists /
// already_unsubscribed) so the frontend can render the same UI feedback.
//
// Tenant-scoped: the reply MUST belong to this customer's linked email_client.
// 404 (not 403) on cross-tenant lookups, consistent with the rest of the
// portal API (don't leak existence of other customers' replies).
//
// Audit log entry is tagged actor='user' with the portal client_user_id so
// we can tell admin-side unsubscribes apart from customer-side ones forever.
router.post('/replies/:id/manual-unsubscribe', (req, res) => {
  const linkedEmailClientId = resolveEmailClientId(req.portalClient.id);
  if (!linkedEmailClientId) return res.status(404).json({ error: 'Not found' });

  const r = db.prepare('SELECT * FROM email_replies WHERE id = ?').get(req.params.id);
  if (!r || r.email_client_id !== linkedEmailClientId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const email = r.from_address;
  const emailLc = String(email || '').toLowerCase();
  const linkedIds = resolveLinkedSet(r.email_client_id);
  const idPlaceholders = linkedIds.map(() => '?').join(',');

  const allRows = db.prepare(`
    SELECT s.* FROM email_subscribers s
    JOIN email_lists l ON s.list_id = l.id
    WHERE LOWER(s.email) = ? AND l.email_client_id IN (${idPlaceholders})
  `).all(emailLc, ...linkedIds);

  if (allRows.length === 0) {
    return res.json({
      ok: false,
      code: 'not_on_lists',
      message: 'This contact isn\'t on any of your mailing lists, so there\'s nothing to unsubscribe.',
    });
  }
  const subscribedRows = allRows.filter(s => s.status === 'subscribed');
  if (subscribedRows.length === 0) {
    return res.json({
      ok: false,
      code: 'already_unsubscribed',
      message: 'This contact is already unsubscribed from all of your mailing lists.',
    });
  }
  for (const s of subscribedRows) {
    db.prepare("UPDATE email_subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') WHERE id=?").run(s.id);
    db.prepare(`UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?`)
      .run(s.list_id, s.list_id);
  }
  db.prepare('UPDATE email_replies SET auto_unsubscribed=1 WHERE id=?').run(req.params.id);
  db.prepare(`INSERT INTO email_audit_log (id, actor, action, target_type, target_id, reply_id, metadata)
              VALUES (?, ?, 'manual_unsubscribe', 'subscriber', ?, ?, ?)`)
    .run(
      uuid(),
      'portal:' + (req.portalUser?.id || 'unknown'),
      email, req.params.id, JSON.stringify({
        email_client_id: r.email_client_id,
        linked_ids: linkedIds,
        lists_affected: subscribedRows.length,
        source: 'portal',
      })
    );
  res.json({ ok: true, lists_affected: subscribedRows.length });
});

// ─── POST /api/portal/replies/:id/manual-resubscribe ──────────────────────────
// Mirror of the admin endpoint. Same three-shape response (ok=true /
// not_on_lists / already_subscribed). Does NOT touch the per-reply
// auto_unsubscribed flag — it's audit history for the reply, not contact
// state. Tenant-scoped (404 cross-tenant).
router.post('/replies/:id/manual-resubscribe', (req, res) => {
  const linkedEmailClientId = resolveEmailClientId(req.portalClient.id);
  if (!linkedEmailClientId) return res.status(404).json({ error: 'Not found' });

  const r = db.prepare('SELECT * FROM email_replies WHERE id = ?').get(req.params.id);
  if (!r || r.email_client_id !== linkedEmailClientId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const email = r.from_address;
  const emailLc = String(email || '').toLowerCase();
  const linkedIds = resolveLinkedSet(r.email_client_id);
  const idPlaceholders = linkedIds.map(() => '?').join(',');

  const allRows = db.prepare(`
    SELECT s.* FROM email_subscribers s
    JOIN email_lists l ON s.list_id = l.id
    WHERE LOWER(s.email) = ? AND l.email_client_id IN (${idPlaceholders})
  `).all(emailLc, ...linkedIds);

  if (allRows.length === 0) {
    return res.json({
      ok: false,
      code: 'not_on_lists',
      message: 'This contact isn\'t on any of your mailing lists.',
    });
  }
  const unsubRows = allRows.filter(s => s.status === 'unsubscribed');
  if (unsubRows.length === 0) {
    return res.json({
      ok: false,
      code: 'already_subscribed',
      message: 'This contact is already subscribed to all of your mailing lists.',
    });
  }
  for (const s of unsubRows) {
    db.prepare("UPDATE email_subscribers SET status='subscribed', unsubscribed_at=NULL WHERE id=?").run(s.id);
    db.prepare(`UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?`)
      .run(s.list_id, s.list_id);
  }
  db.prepare(`INSERT INTO email_audit_log (id, actor, action, target_type, target_id, reply_id, metadata)
              VALUES (?, ?, 'manual_resubscribe', 'subscriber', ?, ?, ?)`)
    .run(
      uuid(),
      'portal:' + (req.portalUser?.id || 'unknown'),
      email, req.params.id, JSON.stringify({
        email_client_id: r.email_client_id,
        linked_ids: linkedIds,
        lists_affected: unsubRows.length,
        source: 'portal',
      })
    );
  res.json({ ok: true, lists_affected: unsubRows.length });
});

// ─── GET /api/portal/replies/:id/subscriptions ─────────────────────────────────
// Customer-portal mirror of the admin endpoint in routes/email.js. Builds
// the campaign-subscription panel for the contact who sent this reply.
//
// Tenant-scoped: the reply must belong to this customer's linked email_client.
// 404 (not 403) on cross-tenant lookups, consistent with the rest of the portal
// API (don't leak existence of other customers' replies).
//
// Shape is identical to the admin endpoint — same UI component renders both.
router.get('/replies/:id/subscriptions', (req, res) => {
  const linkedEmailClientId = resolveEmailClientId(req.portalClient.id);
  if (!linkedEmailClientId) return res.status(404).json({ error: 'Not found' });

  const r = db
    .prepare('SELECT id, email_client_id, from_address FROM email_replies WHERE id = ?')
    .get(String(req.params.id || ''));
  if (!r || r.email_client_id !== linkedEmailClientId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const panel = buildSubscriptionsPanel(
    r.email_client_id,
    r.from_address,
    { extras: { reply_id: r.id } }
  );
  if (!panel) return res.status(404).json({ error: 'contact not resolvable from reply' });
  res.json(panel);
});

// ─── PUT /api/portal/replies/:id/subscriptions ─────────────────────────────────
// Customer-side panel updates. Same body shape and behaviour as the admin
// endpoint. actor in audit log is 'portal:<user_id>' so we can tell who
// changed what forever.
//
// The applySubscriptionsUpdate helper itself enforces that any campaign_id
// in the body belongs to the prospect's linked set — so even a portal user
// can't accidentally (or maliciously) tick a campaign owned by a different
// customer. Belt-and-braces with the tenant scope on the reply lookup above.
router.put('/replies/:id/subscriptions', (req, res) => {
  const linkedEmailClientId = resolveEmailClientId(req.portalClient.id);
  if (!linkedEmailClientId) return res.status(404).json({ error: 'Not found' });

  const r = db
    .prepare('SELECT id, email_client_id, from_address FROM email_replies WHERE id = ?')
    .get(String(req.params.id || ''));
  if (!r || r.email_client_id !== linkedEmailClientId) {
    return res.status(404).json({ error: 'Not found' });
  }

  applySubscriptionsUpdate(
    r.email_client_id,
    r.from_address,
    req.body || {},
    {
      actor: 'portal:' + (req.portalUser?.id || 'unknown'),
      extras: { reply_id: r.id, source: 'portal' },
    }
  );
  const panel = buildSubscriptionsPanel(
    r.email_client_id,
    r.from_address,
    { extras: { reply_id: r.id } }
  );
  res.json(panel);
});

// ─── 3b-iii: Campaigns view ───────────────────────────────────────────────────
// Read-only list of email campaigns the customer has had sent on their behalf.
// Filtered by the email-service-linked email_client (same join as inbox).
//
// Reply counts are computed from email_replies.matched_campaign_id rather than
// stored on email_campaigns — that's where the matcher actually lands them.
// tracking_off flags campaigns where opens AND clicks were both off; the
// frontend renders "—" for those columns instead of 0 to make clear that "0
// opens" is "we didn't track" not "no one opened".

// ─── GET /api/portal/campaigns ────────────────────────────────────────────────
//
// Returns the full list of campaigns for this customer, with everything the
// portal's new Campaigns view needs to render the list table and the per-row
// expanded panel WITHOUT a second roundtrip (except the heavy per-campaign
// detail payload, which lives at GET /campaigns/:id and only loads when a
// row is expanded).
//
// Per campaign we return:
//   - identity:   id, title, started_at
//   - status:     'scheduled' | 'sending' | 'sent' | 'failed'
//                 plus is_drip / steps_total / steps_sent / drip_status
//                 so the frontend can show "In progress · 1/3" pills.
//   - subject:    the visible subject line (step 1's subject; falls back to
//                 campaigns.subject for pre-multi-step campaigns).
//   - combined headline numbers, aggregated across ALL steps:
//                 sent, tracked, untracked, opens, clicks, bounces, unsubs,
//                 replies.
//   - tracking_mode + tracking_split_available — see the note below.
//   - steps[]:    per-step rollup (no html body — that's in the detail route):
//                 { step_number, delay_days, subject, sent, tracked, opens,
//                   clicks, bounces, unsubs, replies, sent_at, status }
//
// THE TRACKING-SPLIT HONESTY RULE
// -------------------------------
// email_sends.tracked is a new column (added this session). For rows inserted
// BEFORE this feature shipped it's defaulted to 0 — which means the literal
// "tracked" count for historic campaigns is unreliable. We surface this via
// `tracking_split_available: false` when ALL of a campaign's sends are
// untracked AND the campaign's tracking_mode is not 'off'. The frontend uses
// this flag to show just the campaign-level tracking pill (e.g. "Tracking:
// smart") with no specific tracked/untracked numbers attached, rather than
// falsely claiming "0 of 369 tracked". New campaigns sent after this deploy
// will always have at least some tracked rows when mode != 'off', so they
// get the full split.
//
// Returns { campaigns: [...], not_subscribed: bool }.
router.get('/campaigns', (req, res) => {
  const linkedEmailClientId = resolveEmailClientId(req.portalClient.id);
  if (!linkedEmailClientId) {
    return res.json({ campaigns: [], not_subscribed: true });
  }

  const campaigns = db.prepare(`
    SELECT
      id, title, subject, status,
      tracking_mode, track_opens, track_clicks,
      unsubscribe_count,
      sent_at, scheduled_at, created_at
    FROM email_campaigns
    WHERE email_client_id = ?
    ORDER BY COALESCE(sent_at, scheduled_at, created_at) DESC
  `).all(linkedEmailClientId);

  if (campaigns.length === 0) {
    return res.json({ campaigns: [], not_subscribed: false });
  }

  const campaignIds = campaigns.map(c => c.id);
  const placeholders = campaignIds.map(() => '?').join(',');

  // Per-step rollup from email_sends. We aggregate per (campaign, step_number)
  // so the frontend can render the per-step tabs without a second query.
  // status='sent' (or anything not 'failed'/'bounced') counts as a real send;
  // 'bounced' counts toward the bounce column; 'failed' is excluded from
  // everything (failed to even hand off to SES — never reached the recipient).
  const sendRows = db.prepare(`
    SELECT
      campaign_id,
      step_number,
      COUNT(*) AS total,
      SUM(CASE WHEN status NOT IN ('failed','bounced') THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status NOT IN ('failed','bounced') AND tracked = 1 THEN 1 ELSE 0 END) AS tracked,
      SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opens,
      SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicks,
      SUM(CASE WHEN status = 'bounced' OR bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounces,
      MIN(sent_at) AS first_sent_at,
      MAX(sent_at) AS last_sent_at
    FROM email_sends
    WHERE campaign_id IN (${placeholders})
    GROUP BY campaign_id, step_number
  `).all(...campaignIds);

  // Index by campaign for fast lookup
  const sendsByCampaign = new Map();
  for (const r of sendRows) {
    if (!sendsByCampaign.has(r.campaign_id)) sendsByCampaign.set(r.campaign_id, []);
    sendsByCampaign.get(r.campaign_id).push(r);
  }

  // Step definitions (subject + delay_days). Excludes html_body — heavy and
  // not needed for the list response.
  const stepDefs = db.prepare(`
    SELECT campaign_id, step_number, subject, delay_days
    FROM email_campaign_steps
    WHERE campaign_id IN (${placeholders})
    ORDER BY campaign_id, step_number
  `).all(...campaignIds);
  const stepsByCampaign = new Map();
  for (const s of stepDefs) {
    if (!stepsByCampaign.has(s.campaign_id)) stepsByCampaign.set(s.campaign_id, []);
    stepsByCampaign.get(s.campaign_id).push(s);
  }

  // Reply counts per campaign + per step. Step attribution: replies are
  // matched to a campaign (matched_campaign_id) but not to a specific step —
  // a reply to step 2 still threads on the campaign. So per-step reply count
  // is "not directly attributable"; we surface the total at campaign level
  // and a per-step total of "—" on every step except by using the count of
  // replies received AFTER that step's sends started (best approximation).
  // Keep it simple for now: total at campaign level, per-step UNSPECIFIED.
  const replyCounts = db.prepare(`
    SELECT matched_campaign_id, COUNT(*) AS n
    FROM email_replies
    WHERE email_client_id = ? AND matched_campaign_id IN (${placeholders})
    GROUP BY matched_campaign_id
  `).all(linkedEmailClientId, ...campaignIds);
  const replyMap = new Map(replyCounts.map(r => [r.matched_campaign_id, r.n]));

  // Per-campaign unsubscribe count. We count subscribers who unsubscribed
  // AFTER receiving any send from this campaign — i.e. anyone in email_sends
  // for this campaign whose subscriber row has unsubscribed_at set after
  // their first send_at. This is approximate (could attribute an unsub that
  // happened months later to the campaign that touched them last), but it's
  // the same approximation the existing email_campaigns.unsubscribe_count
  // would have made, and it's what we have without a per-unsub source table.
  // We use email_campaigns.unsubscribe_count directly when populated, since
  // that's already the value the operator sees in the admin UI — keeps the
  // two views consistent.
  // (Falling back to 0 when null — never NaN/undefined.)

  res.json({
    campaigns: campaigns.map(c => {
      const sendsForCampaign = sendsByCampaign.get(c.id) || [];
      const stepsForCampaign = stepsByCampaign.get(c.id) || [];

      // Combined headline across all steps
      const combined = sendsForCampaign.reduce((acc, r) => {
        acc.sent    += r.sent    || 0;
        acc.tracked += r.tracked || 0;
        acc.opens   += r.opens   || 0;
        acc.clicks  += r.clicks  || 0;
        acc.bounces += r.bounces || 0;
        return acc;
      }, { sent: 0, tracked: 0, opens: 0, clicks: 0, bounces: 0 });
      const untracked = Math.max(0, combined.sent - combined.tracked);

      // Drip awareness
      const stepsTotal = stepsForCampaign.length || 1;
      const stepsSent  = sendsForCampaign.filter(r => (r.sent || 0) > 0).length;
      const isDrip     = stepsTotal > 1;
      const dripStatus =
        stepsSent === 0           ? 'not_started' :
        stepsSent >= stepsTotal   ? 'completed'   :
                                    'in_progress';

      // Customer-friendly campaign status. For drips, "all sent" only fires
      // when every step has fired; otherwise we surface 'in_progress' so the
      // frontend can show the amber "In progress · X/N" pill.
      let status;
      if (c.status === 'failed') {
        status = 'failed';
      } else if (c.status === 'sending' || c.status === 'paused') {
        status = 'sending';
      } else if (isDrip && dripStatus === 'in_progress') {
        status = 'in_progress';
      } else if (c.sent_at || c.status === 'sent' || combined.sent > 0) {
        status = 'sent';
      } else {
        status = 'scheduled';
      }

      // Tracking-split availability — see header comment.
      const trackingOn = c.tracking_mode && c.tracking_mode !== 'off';
      const trackingSplitAvailable =
        !trackingOn ? true                                  /* nothing to split — honest */
        : combined.tracked > 0 ? true                       /* real data */
        : false;                                            /* pre-feature campaign */

      // Per-step rollup. Sends for a step may not exist yet (future drip step).
      // step subject falls back to the campaign subject for step 1, and to
      // '(no subject set)' for unconfigured follow-up steps.
      const steps = stepsForCampaign.map(def => {
        const s = sendsForCampaign.find(r => r.step_number === def.step_number) || {};
        const stepSent     = s.sent    || 0;
        const stepTracked  = s.tracked || 0;
        const stepStatus =
          stepSent === 0 ? 'pending'
          : stepSent > 0 && c.status !== 'failed' ? 'sent'
          : 'failed';
        return {
          step_number: def.step_number,
          delay_days:  def.delay_days || 0,
          subject:     def.subject || (def.step_number === 1 ? c.subject : '(no subject set)'),
          sent:        stepSent,
          tracked:     stepTracked,
          untracked:   Math.max(0, stepSent - stepTracked),
          opens:       s.opens   || 0,
          clicks:      s.clicks  || 0,
          bounces:     s.bounces || 0,
          sent_at:     s.first_sent_at || null,
          status:      stepStatus,
        };
      });
      // If there are no step rows but the campaign has sends (very old data
      // before the steps table existed), synthesise a single step from the
      // campaign itself so the frontend always has at least one tab.
      if (steps.length === 0 && combined.sent > 0) {
        steps.push({
          step_number: 1,
          delay_days:  0,
          subject:     c.subject || '',
          sent:        combined.sent,
          tracked:     combined.tracked,
          untracked:   untracked,
          opens:       combined.opens,
          clicks:      combined.clicks,
          bounces:     combined.bounces,
          sent_at:     c.sent_at,
          status:      'sent',
        });
      }

      return {
        id:       c.id,
        title:    c.title,
        subject:  c.subject || '',
        status,
        is_drip:        isDrip,
        steps_total:    stepsTotal,
        steps_sent:     stepsSent,
        drip_status:    dripStatus,
        tracking_mode:  c.tracking_mode || 'off',
        tracking_split_available: trackingSplitAvailable,
        sent:      combined.sent,
        tracked:   combined.tracked,
        untracked: untracked,
        opens:     combined.opens,
        clicks:    combined.clicks,
        bounces:   combined.bounces,
        unsubs:    c.unsubscribe_count || 0,
        replies:   replyMap.get(c.id) || 0,
        steps,
        started_at: c.sent_at || c.scheduled_at || c.created_at,
      };
    }),
    not_subscribed: false,
  });
});

// ─── GET /api/portal/campaigns/:id ────────────────────────────────────────────
//
// Returns the heavier per-campaign payload used when a row is expanded in the
// portal Campaigns view. Kept separate from the list endpoint so the table
// loads fast and we only pay the cost for campaigns the customer actually
// drills into.
//
// Payload:
//   - everything the list returns for this campaign
//   - steps[].html_body — the actual email body that went out (for preview)
//   - steps[].from_name / from_email — sender shown to the recipient
//   - replies[]: last 30 inbound replies linked to this campaign, with
//     classification + a short snippet. Newest first.
//
// Returns 404 (not 403) for cross-tenant lookups — see portal-auth.js.
router.get('/campaigns/:id', (req, res) => {
  const linkedEmailClientId = resolveEmailClientId(req.portalClient.id);
  if (!linkedEmailClientId) return res.status(404).json({ error: 'not_found' });

  const campaign = db.prepare(`
    SELECT
      id, title, subject, from_name, from_email, reply_to,
      html_body, status,
      tracking_mode, track_opens, track_clicks,
      unsubscribe_count,
      sent_at, scheduled_at, created_at
    FROM email_campaigns
    WHERE id = ? AND email_client_id = ?
  `).get(req.params.id, linkedEmailClientId);

  if (!campaign) return res.status(404).json({ error: 'not_found' });

  // Per-step rollup — same shape as the list endpoint
  const sendRows = db.prepare(`
    SELECT
      step_number,
      SUM(CASE WHEN status NOT IN ('failed','bounced') THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status NOT IN ('failed','bounced') AND tracked = 1 THEN 1 ELSE 0 END) AS tracked,
      SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opens,
      SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicks,
      SUM(CASE WHEN status = 'bounced' OR bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounces,
      MIN(sent_at) AS first_sent_at
    FROM email_sends
    WHERE campaign_id = ?
    GROUP BY step_number
  `).all(campaign.id);
  const sendsByStep = new Map(sendRows.map(r => [r.step_number, r]));

  // Step definitions WITH html_body for preview
  const stepDefs = db.prepare(`
    SELECT step_number, subject, delay_days, html_body
    FROM email_campaign_steps
    WHERE campaign_id = ?
    ORDER BY step_number
  `).all(campaign.id);

  // Combined totals
  const combined = sendRows.reduce((acc, r) => {
    acc.sent    += r.sent    || 0;
    acc.tracked += r.tracked || 0;
    acc.opens   += r.opens   || 0;
    acc.clicks  += r.clicks  || 0;
    acc.bounces += r.bounces || 0;
    return acc;
  }, { sent: 0, tracked: 0, opens: 0, clicks: 0, bounces: 0 });
  const untracked = Math.max(0, combined.sent - combined.tracked);

  // Build steps array with html_body + per-step rollup
  const steps = stepDefs.map(def => {
    const s = sendsByStep.get(def.step_number) || {};
    const stepSent = s.sent || 0;
    const stepStatus =
      stepSent === 0 ? 'pending'
      : stepSent > 0 && campaign.status !== 'failed' ? 'sent'
      : 'failed';
    return {
      step_number: def.step_number,
      delay_days:  def.delay_days || 0,
      subject:     def.subject || (def.step_number === 1 ? campaign.subject : '(no subject set)'),
      html_body:   def.html_body || '',
      from_name:   campaign.from_name,
      from_email:  campaign.from_email,
      sent:        stepSent,
      tracked:     s.tracked || 0,
      untracked:   Math.max(0, stepSent - (s.tracked || 0)),
      opens:       s.opens   || 0,
      clicks:      s.clicks  || 0,
      bounces:     s.bounces || 0,
      sent_at:     s.first_sent_at || null,
      status:      stepStatus,
    };
  });
  // Fallback for very old single-step campaigns with no row in
  // email_campaign_steps (theoretically backfilled but defensive).
  if (steps.length === 0) {
    steps.push({
      step_number: 1,
      delay_days:  0,
      subject:     campaign.subject || '',
      html_body:   campaign.html_body || '',
      from_name:   campaign.from_name,
      from_email:  campaign.from_email,
      sent:        combined.sent,
      tracked:     combined.tracked,
      untracked:   untracked,
      opens:       combined.opens,
      clicks:      combined.clicks,
      bounces:     combined.bounces,
      sent_at:     campaign.sent_at,
      status:      combined.sent > 0 ? 'sent' : 'pending',
    });
  }

  // Recent replies — last 30, newest first, with a snippet from body_text.
  // Snippet is 160 chars; we strip newlines so it sits on one line in the UI.
  const replies = db.prepare(`
    SELECT
      id, from_address, from_name, subject, received_at,
      classification, body_text
    FROM email_replies
    WHERE email_client_id = ? AND matched_campaign_id = ?
    ORDER BY received_at DESC
    LIMIT 30
  `).all(linkedEmailClientId, campaign.id).map(r => ({
    id:             r.id,
    from_address:   r.from_address,
    from_name:      r.from_name,
    subject:        r.subject,
    received_at:    r.received_at,
    classification: r.classification,
    snippet: (r.body_text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
  }));

  // Drip awareness — same logic as the list endpoint
  const stepsTotal = stepDefs.length || 1;
  const stepsSent  = sendRows.filter(r => (r.sent || 0) > 0).length;
  const isDrip     = stepsTotal > 1;
  const dripStatus =
    stepsSent === 0         ? 'not_started' :
    stepsSent >= stepsTotal ? 'completed'   :
                              'in_progress';

  const trackingOn = campaign.tracking_mode && campaign.tracking_mode !== 'off';
  const trackingSplitAvailable =
    !trackingOn ? true
    : combined.tracked > 0 ? true
    : false;

  res.json({
    id:            campaign.id,
    title:         campaign.title,
    subject:       campaign.subject || '',
    is_drip:       isDrip,
    steps_total:   stepsTotal,
    steps_sent:    stepsSent,
    drip_status:   dripStatus,
    tracking_mode: campaign.tracking_mode || 'off',
    tracking_split_available: trackingSplitAvailable,
    sent:      combined.sent,
    tracked:   combined.tracked,
    untracked: untracked,
    opens:     combined.opens,
    clicks:    combined.clicks,
    bounces:   combined.bounces,
    unsubs:    campaign.unsubscribe_count || 0,
    replies:   replies.length,
    steps,
    replies_list: replies,
    started_at: campaign.sent_at || campaign.scheduled_at || campaign.created_at,
  });
});

// ─── GET /api/portal/content-rules ────────────────────────────────────────────
// Returns the customer's "refine my posts" rules — short numbered constraints
// that override the LinkedIn algorithm and RAG document.
// Returns { rules: [{ id, text }, ...] }. Empty array if the customer has none
// or doesn't have LinkedIn enabled (we don't 404 in that case — the UI is
// served the empty list and the modal opens normally so the customer can add
// their first rule).
router.get('/content-rules', (req, res) => {
  const linkedinClientId = resolveLinkedinClientId(req.portalClient.id);
  if (!linkedinClientId) return res.json({ rules: [] });

  const client = db.prepare(`SELECT content_rules FROM clients WHERE id = ?`).get(linkedinClientId);
  if (!client) return res.json({ rules: [] });

  res.json({ rules: parseRules(client) });
});

// ─── PUT /api/portal/content-rules ────────────────────────────────────────────
// Replaces the customer's rules with the supplied array. Body:
//   { rules: [{ id?: string, text: string }, ...] }
// - Each rule.text must be a non-empty string ≤ RULE_MAX_LENGTH chars
// - Maximum RULES_MAX_COUNT rules
// - Whitespace-only rules and duplicates (same text trimmed) are dropped
// - Missing/non-string ids are regenerated server-side so the array is stable
// Returns the canonical saved list so the UI can update from the server-truth
// state instead of guessing.
router.put('/content-rules', (req, res) => {
  const linkedinClientId = resolveLinkedinClientId(req.portalClient.id);
  if (!linkedinClientId) {
    return res.status(403).json({ error: 'LinkedIn service not enabled for this customer' });
  }

  const incoming = Array.isArray(req.body?.rules) ? req.body.rules : null;
  if (!incoming) return res.status(400).json({ error: 'Body must include { rules: [...] }' });

  const seen = new Set();
  const cleaned = [];
  for (const r of incoming) {
    if (typeof r?.text !== 'string') continue;
    const text = r.text.trim();
    if (!text) continue;
    if (text.length > RULE_MAX_LENGTH) {
      return res.status(400).json({ error: `Each rule must be at most ${RULE_MAX_LENGTH} characters` });
    }
    const dedupKey = text.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    cleaned.push({
      id:   (typeof r.id === 'string' && r.id) ? r.id : uuid(),
      text,
    });
    if (cleaned.length >= RULES_MAX_COUNT) break; // hard cap
  }

  db.prepare(`UPDATE clients SET content_rules = ? WHERE id = ?`).run(
    JSON.stringify(cleaned),
    linkedinClientId,
  );

  res.json({ rules: cleaned });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRM — Hot Prospects (customer-portal side)
//
// Mirrors the admin-side endpoints in routes/hot-prospects.js, but scoped to
// the signed-in customer's email_client_id (resolved from the session cookie,
// never trusted from the URL or body — same rule as everywhere else in this
// file). All rows are added with added_by = 'portal:<client_user_id>' so the
// origin is auditable.
//
// The thread endpoint joins email_replies + email_outbound live, just like
// the admin one — new mail with the prospect auto-appears.
// ─────────────────────────────────────────────────────────────────────────────

// Local helpers, mirroring routes/hot-prospects.js exactly. Duplicated rather
// than imported to keep portal.js self-contained (and so a tweak to one side
// can't accidentally change the other).
function _normaliseProspectEmail(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  return s.length ? s : null;
}
function _validateFollowUpDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return undefined;
  const iso = d.toISOString().slice(0, 10);
  if (iso !== s) return undefined;
  return s;
}

// Linked-row resolution for hot prospects. Mirrors resolveLinkedSet() in
// routes/hot-prospects.js — see the long comment block there for the
// reasoning. Given any email_clients id, returns the full set of ids that
// belong to the same real customer (portal anchor + inbox-owning row, when
// they differ). Used so Rob's portal sees prospects flagged on the linked
// mail.engineeringsolutions.co.uk row in addition to ones flagged directly
// against the cube6 anchor.
function _resolveProspectLinkedSet(emailClientId) {
  if (!emailClientId) return [];
  const id = String(emailClientId);
  const set = new Set([id]);
  const outward = db.prepare(`
    SELECT linked_external_id FROM customer_services
    WHERE email_client_id = ? AND service_key = 'email'
      AND linked_external_id IS NOT NULL
      AND linked_external_id != email_client_id
  `).get(id);
  if (outward?.linked_external_id) set.add(String(outward.linked_external_id));
  const inward = db.prepare(`
    SELECT email_client_id FROM customer_services
    WHERE linked_external_id = ? AND service_key = 'email'
      AND linked_external_id != email_client_id
  `).get(id);
  if (inward?.email_client_id) set.add(String(inward.email_client_id));
  return Array.from(set);
}
function _inClause(col, ids) {
  const placeholders = ids.map(() => '?').join(', ');
  return { sql: `${col} IN (${placeholders})`, params: ids };
}
function _getInboxNamesByIds(ids) {
  if (!ids || ids.length === 0) return new Map();
  const uniq = Array.from(new Set(ids.map(String)));
  const placeholders = uniq.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, name FROM email_clients WHERE id IN (${placeholders})`)
    .all(...uniq);
  return new Map(rows.map(r => [String(r.id), r.name]));
}

// Look up which of a list of emails are currently unsubscribed under any of
// the customer's linked email_client_ids. Mirror of the helper in
// routes/hot-prospects.js (kept local rather than imported so the portal
// helpers stay self-contained — see comment near _resolveProspectLinkedSet).
// Returns a Set of LOWERCASE addresses.
function computePortalUnsubAddresses(linkedIds, emails) {
  const out = new Set();
  if (!linkedIds || linkedIds.length === 0) return out;
  if (!emails || emails.length === 0) return out;
  const addrsLc = Array.from(new Set(
    emails.filter(Boolean).map(e => String(e).toLowerCase())
  ));
  if (addrsLc.length === 0) return out;
  const idPlaceholders = linkedIds.map(() => '?').join(',');
  const addrPlaceholders = addrsLc.map(() => '?').join(',');
  try {
    const rows = db.prepare(`
      SELECT DISTINCT LOWER(s.email) AS addr
      FROM email_subscribers s
      JOIN email_lists l ON l.id = s.list_id
      WHERE l.email_client_id IN (${idPlaceholders})
        AND LOWER(s.email) IN (${addrPlaceholders})
        AND (s.status = 'unsubscribed' OR s.unsubscribed_at IS NOT NULL)
    `).all(...linkedIds, ...addrsLc);
    for (const r of rows) out.add(r.addr);
  } catch (e) {
    console.warn('[portal] computePortalUnsubAddresses failed (non-fatal):', e?.message || e);
  }
  return out;
}

// Companion: returns the set of addresses with ANY subscriber row under the
// customer's linked set (regardless of status). Combined with the unsub set,
// the Hot Prospect modal can pick: Unsubscribe button (on list + subscribed),
// Re-subscribe button (on list + unsubscribed), or no button (not on list).
function computePortalOnListAddresses(linkedIds, emails) {
  const out = new Set();
  if (!linkedIds || linkedIds.length === 0) return out;
  if (!emails || emails.length === 0) return out;
  const addrsLc = Array.from(new Set(
    emails.filter(Boolean).map(e => String(e).toLowerCase())
  ));
  if (addrsLc.length === 0) return out;
  const idPlaceholders = linkedIds.map(() => '?').join(',');
  const addrPlaceholders = addrsLc.map(() => '?').join(',');
  try {
    const rows = db.prepare(`
      SELECT DISTINCT LOWER(s.email) AS addr
      FROM email_subscribers s
      JOIN email_lists l ON l.id = s.list_id
      WHERE l.email_client_id IN (${idPlaceholders})
        AND LOWER(s.email) IN (${addrPlaceholders})
    `).all(...linkedIds, ...addrsLc);
    for (const r of rows) out.add(r.addr);
  } catch (e) {
    console.warn('[portal] computePortalOnListAddresses failed (non-fatal):', e?.message || e);
  }
  return out;
}

// GET /api/portal/hot-prospects — list the customer's prospects, newest-first.
// Expands across the customer's linked email rows so prospects flagged on a
// linked inbox (e.g. mail.engineering… for Cube 6) appear here.
router.get('/hot-prospects', (req, res) => {
  const clientId = req.portalClient.id;
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inboxNames = _getInboxNamesByIds(linkedIds);
  const inClient = _inClause('email_client_id', linkedIds);

  const search = String(req.query.search || '').trim().toLowerCase();
  // Same urgency-first → converted-last ordering as the admin side.
  // See routes/hot-prospects.js GET '/' for the explanation.
  const orderBy = `
    CASE
      WHEN closed_at IS NOT NULL THEN 3
      WHEN follow_up_date IS NULL THEN 2
      WHEN follow_up_date < date('now') THEN 0
      WHEN follow_up_date = date('now') THEN 1
      ELSE 2
    END ASC,
    follow_up_date ASC,
    closed_at DESC,
    added_at DESC
  `;
  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = db
      .prepare(
        `SELECT id, email_client_id, prospect_email, prospect_name,
                follow_up_date, notes, added_by, added_at, updated_at,
                closed_at, closed_by,
                status, tag_color, portal_first_viewed_at
           FROM hot_prospects
          WHERE ${inClient.sql}
            AND (LOWER(COALESCE(prospect_name,'')) LIKE ? OR LOWER(prospect_email) LIKE ?)
          ORDER BY ${orderBy}`
      )
      .all(...inClient.params, like, like);
  } else {
    rows = db
      .prepare(
        `SELECT id, email_client_id, prospect_email, prospect_name,
                follow_up_date, notes, added_by, added_at, updated_at,
                closed_at, closed_by,
                status, tag_color, portal_first_viewed_at
           FROM hot_prospects
          WHERE ${inClient.sql}
          ORDER BY ${orderBy}`
      )
      .all(...inClient.params);
  }

  const hasLinkedInboxes = linkedIds.length > 1;
  // contact_unsubscribed + contact_on_list — drive Unsubscribe vs
  // Re-subscribe vs no-button in the prospect detail modal:
  //   on_list && !unsubd → Unsubscribe button
  //   on_list && unsubd  → Re-subscribe button
  //   !on_list           → no button (e.g. Formspree leads not on any list)
  const emails = rows.map(r => r.prospect_email);
  const unsubAddrs  = computePortalUnsubAddresses(linkedIds, emails);
  const onListAddrs = computePortalOnListAddresses(linkedIds, emails);
  const projected = rows.map(r => {
    const emailLc = String(r.prospect_email || '').toLowerCase();
    return {
      ...r,
      source_inbox_name: inboxNames.get(String(r.email_client_id)) || null,
      contact_unsubscribed: unsubAddrs.has(emailLc),
      contact_on_list:      onListAddrs.has(emailLc),
    };
  });

  res.json({ prospects: projected, has_linked_inboxes: hasLinkedInboxes });
});

// POST /api/portal/hot-prospects — add a prospect. Body:
//   { prospect_email, prospect_name?, follow_up_date?, notes?, source_reply_id? }
// No email_client_id in the body — it's derived from the session.
//
// Option B write path (decision 2026-05-20, second session): the prospect is
// saved against the customer's INBOX-OWNING row (e.g. mail.engineeringsolu…),
// NOT the portal anchor (cube6). That keeps the row's email_client_id aligned
// with the inbox the source_reply_id came from, and matches the admin write
// path so the source_inbox_name label reads accurately on both sides.
// Self-linked / unlinked customers fall through to the anchor's own id.
router.post('/hot-prospects', (req, res) => {
  const portalAnchorId = req.portalClient.id;
  const inboxOwningId = resolveEmailClientId(portalAnchorId) || portalAnchorId;
  const {
    prospect_email,
    prospect_name,
    follow_up_date,
    notes,
    source_reply_id,
  } = req.body || {};

  const prospectEmail = _normaliseProspectEmail(prospect_email);
  if (!prospectEmail || !prospectEmail.includes('@')) {
    return res.status(400).json({ error: 'valid prospect_email required' });
  }

  // source_reply_id auto-fills prospect_name. The reply must live on any row
  // in the customer's linked set (not just the anchor) since the inbox the
  // reply landed in is the inbox-owning row, not the anchor.
  const linkedIds = _resolveProspectLinkedSet(portalAnchorId);
  const inReply = _inClause('email_client_id', linkedIds);
  let resolvedName = (prospect_name !== undefined && prospect_name !== null)
    ? String(prospect_name).trim() || null
    : null;
  if (!resolvedName && source_reply_id) {
    const reply = db
      .prepare(
        `SELECT from_name FROM email_replies
          WHERE id = ? AND ${inReply.sql}`
      )
      .get(String(source_reply_id), ...inReply.params);
    if (reply && reply.from_name) {
      resolvedName = String(reply.from_name).trim() || null;
    }
  }

  const followUp = _validateFollowUpDate(follow_up_date);
  if (followUp === undefined) {
    return res.status(400).json({ error: "follow_up_date must be 'YYYY-MM-DD' or null" });
  }

  const cleanNotes = (notes === undefined || notes === null)
    ? null
    : (String(notes).trim() || null);

  const addedBy = `portal:${req.portalUser.id}`;
  // Detect insert-vs-update so the customer-portal "Send to Hot Prospects"
  // button can show the right banner. The uniqueness key on the table is
  // (email_client_id, prospect_email) — so look up against the inbox-owning
  // id, which is what we'll INSERT against.
  const existing = db
    .prepare('SELECT id FROM hot_prospects WHERE email_client_id = ? AND prospect_email = ?')
    .get(inboxOwningId, prospectEmail);
  const wasNew = !existing;

  const id = uuid();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const stmt = db.prepare(`
    INSERT INTO hot_prospects (
      id, email_client_id, prospect_email, prospect_name,
      follow_up_date, notes, added_by, added_at, updated_at,
      source_reply_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email_client_id, prospect_email) DO UPDATE SET
      prospect_name   = COALESCE(excluded.prospect_name, hot_prospects.prospect_name),
      follow_up_date  = CASE WHEN excluded.follow_up_date IS NOT NULL
                             THEN excluded.follow_up_date
                             ELSE hot_prospects.follow_up_date END,
      notes           = COALESCE(excluded.notes, hot_prospects.notes),
      source_reply_id = COALESCE(hot_prospects.source_reply_id, excluded.source_reply_id),
      updated_at      = excluded.updated_at
    RETURNING id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by, source_reply_id,
              status, tag_color, portal_first_viewed_at
  `);
  const row = stmt.get(
    id, inboxOwningId, prospectEmail, resolvedName,
    followUp, cleanNotes, addedBy, now, now,
    source_reply_id || null
  );
  res.json({ prospect: row, was_new: wasNew });
});

// PUT /api/portal/hot-prospects/:id — update follow-up date / notes / name.
// Customers can only update prospects on their own list (the id must belong
// to their email_client_id). Cross-tenant lookups return 404, never 403, to
// match the project's standing privacy rule.
router.put('/hot-prospects/:id', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  // Ownership check spans the customer's linked set so a prospect saved
  // against the linked inbox row (Option B write path) is still editable
  // by this portal session.
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const existing = db
    .prepare(`SELECT * FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`)
    .get(id, ...inOwn.params);
  if (!existing) {
    return res.status(404).json({ error: 'prospect not found' });
  }

  const updates = {};
  if ('follow_up_date' in (req.body || {})) {
    const v = _validateFollowUpDate(req.body.follow_up_date);
    if (v === undefined) {
      return res.status(400).json({ error: "follow_up_date must be 'YYYY-MM-DD' or null" });
    }
    updates.follow_up_date = v;
  }
  if ('notes' in (req.body || {})) {
    const raw = req.body.notes;
    updates.notes = (raw === null || raw === undefined)
      ? null
      : (String(raw).trim() || null);
  }
  if ('prospect_name' in (req.body || {})) {
    const raw = req.body.prospect_name;
    updates.prospect_name = (raw === null || raw === undefined)
      ? null
      : (String(raw).trim() || null);
  }
  // Status — fixed-set enum, same shape as admin route.
  if ('status' in (req.body || {})) {
    const raw = req.body.status;
    const VALID_STATUSES = ['new', 'contacted', 'no_response'];
    if (!VALID_STATUSES.includes(raw)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    updates.status = raw;
  }
  // tag_color — customer-chosen palette override, null clears.
  if ('tag_color' in (req.body || {})) {
    const raw = req.body.tag_color;
    if (raw === null || raw === undefined || raw === '') {
      updates.tag_color = null;
    } else {
      const VALID_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'grey'];
      if (!VALID_COLORS.includes(raw)) {
        return res.status(400).json({ error: `tag_color must be one of: ${VALID_COLORS.join(', ')}, or null` });
      }
      updates.tag_color = raw;
    }
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no updatable fields supplied' });
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).concat('updated_at = ?');
  const values = Object.values(updates).concat(now, id);

  db.prepare(`UPDATE hot_prospects SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  const row = db
    .prepare(
      `SELECT id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by, source_reply_id,
              status, tag_color, portal_first_viewed_at
         FROM hot_prospects WHERE id = ?`
    )
    .get(id);
  res.json({ prospect: row });
});

// POST /api/portal/hot-prospects/:id/mark-viewed — stamp
// portal_first_viewed_at on first open. Mirror of the admin endpoint but
// tracks the portal audience separately. Tenant-scoped (404 for foreign ids).
// Idempotent — safe to fire-and-forget on every modal open.
router.post('/hot-prospects/:id/mark-viewed', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const existing = db
    .prepare(`SELECT id, portal_first_viewed_at FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`)
    .get(id, ...inOwn.params);
  if (!existing) {
    return res.status(404).json({ error: 'prospect not found' });
  }
  if (existing.portal_first_viewed_at) {
    return res.json({ prospect: { id, portal_first_viewed_at: existing.portal_first_viewed_at } });
  }
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    'UPDATE hot_prospects SET portal_first_viewed_at = ?, updated_at = ? WHERE id = ?'
  ).run(now, now, id);
  res.json({ prospect: { id, portal_first_viewed_at: now } });
});

// GET /api/portal/hot-prospects/unread-count — number of active prospects
// the portal session hasn't viewed yet (portal_first_viewed_at IS NULL AND
// closed_at IS NULL). Drives the customer-portal sidebar number badge on
// the "Hot Prospects" row. Tenant-scoped across the customer's linked set.
//
// Returns { count: N } — keeps the contract loose so future additions
// (e.g. unread-by-category breakdown) don't break consumers.
router.get('/hot-prospects/unread-count', (req, res) => {
  const clientId = req.portalClient.id;
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inClient = _inClause('email_client_id', linkedIds);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM hot_prospects
        WHERE ${inClient.sql}
          AND portal_first_viewed_at IS NULL
          AND closed_at IS NULL`
    )
    .get(...inClient.params);
  res.json({ count: row?.count || 0 });
});

// POST /api/portal/hot-prospects/:id/resubscribe — re-subscribe a Hot
// Prospect back to the customer's mailing lists. Mirror of the admin
// endpoint in routes/hot-prospects.js. Tenant-scoped across the linked
// set so a prospect belonging to a foreign customer can't be touched.
//
// Returns the same three-shape response (ok=true / not_on_lists /
// already_subscribed) so the frontend can show consistent feedback.
router.post('/hot-prospects/:id/resubscribe', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const prospect = db
    .prepare(`SELECT * FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`)
    .get(id, ...inOwn.params);
  if (!prospect) {
    return res.status(404).json({ error: 'prospect not found' });
  }

  const emailLc = String(prospect.prospect_email || '').toLowerCase();
  const idPlaceholders = linkedIds.map(() => '?').join(',');

  const allRows = db.prepare(`
    SELECT s.* FROM email_subscribers s
    JOIN email_lists l ON s.list_id = l.id
    WHERE LOWER(s.email) = ? AND l.email_client_id IN (${idPlaceholders})
  `).all(emailLc, ...linkedIds);

  if (allRows.length === 0) {
    return res.json({
      ok: false,
      code: 'not_on_lists',
      message: 'This contact isn\'t on any of your mailing lists.',
    });
  }
  const unsubRows = allRows.filter(s => s.status === 'unsubscribed');
  if (unsubRows.length === 0) {
    return res.json({
      ok: false,
      code: 'already_subscribed',
      message: 'This contact is already subscribed to all of your mailing lists.',
    });
  }
  for (const s of unsubRows) {
    db.prepare("UPDATE email_subscribers SET status='subscribed', unsubscribed_at=NULL WHERE id=?").run(s.id);
    db.prepare(`UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?`)
      .run(s.list_id, s.list_id);
  }
  db.prepare(`INSERT INTO email_audit_log (id, actor, action, target_type, target_id, metadata)
              VALUES (?, ?, 'hot_prospect_resubscribe', 'subscriber', ?, ?)`)
    .run(
      uuid(),
      'portal:' + (req.portalUser?.id || 'unknown'),
      prospect.prospect_email, JSON.stringify({
        hot_prospect_id: id,
        email_client_id: prospect.email_client_id,
        linked_ids: linkedIds,
        lists_affected: unsubRows.length,
        source: 'portal',
      })
    );
  res.json({ ok: true, lists_affected: unsubRows.length });
});

// POST /api/portal/hot-prospects/:id/unsubscribe — mirror of the admin
// endpoint in routes/hot-prospects.js. Operator use case (from the customer
// side): "the prospect explicitly told me to stop emailing them, take them
// off my list straight from their prospect record." Tenant-scoped across
// the linked set so a foreign prospect can't be flipped. Same three-shape
// response as the rest of the unsub/resub endpoints.
router.post('/hot-prospects/:id/unsubscribe', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const prospect = db
    .prepare(`SELECT * FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`)
    .get(id, ...inOwn.params);
  if (!prospect) {
    return res.status(404).json({ error: 'prospect not found' });
  }

  const emailLc = String(prospect.prospect_email || '').toLowerCase();
  const idPlaceholders = linkedIds.map(() => '?').join(',');

  const allRows = db.prepare(`
    SELECT s.* FROM email_subscribers s
    JOIN email_lists l ON s.list_id = l.id
    WHERE LOWER(s.email) = ? AND l.email_client_id IN (${idPlaceholders})
  `).all(emailLc, ...linkedIds);

  if (allRows.length === 0) {
    return res.json({
      ok: false,
      code: 'not_on_lists',
      message: 'This contact isn\'t on any of your mailing lists, so there\'s nothing to unsubscribe.',
    });
  }
  const subscribedRows = allRows.filter(s => s.status === 'subscribed');
  if (subscribedRows.length === 0) {
    return res.json({
      ok: false,
      code: 'already_unsubscribed',
      message: 'This contact is already unsubscribed from all of your mailing lists.',
    });
  }
  for (const s of subscribedRows) {
    db.prepare("UPDATE email_subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') WHERE id=?").run(s.id);
    db.prepare(`UPDATE email_lists SET subscriber_count=(SELECT COUNT(*) FROM email_subscribers WHERE list_id=? AND status='subscribed') WHERE id=?`)
      .run(s.list_id, s.list_id);
  }
  db.prepare(`INSERT INTO email_audit_log (id, actor, action, target_type, target_id, metadata)
              VALUES (?, ?, 'hot_prospect_unsubscribe', 'subscriber', ?, ?)`)
    .run(
      uuid(),
      'portal:' + (req.portalUser?.id || 'unknown'),
      prospect.prospect_email, JSON.stringify({
        hot_prospect_id: id,
        email_client_id: prospect.email_client_id,
        linked_ids: linkedIds,
        lists_affected: subscribedRows.length,
        source: 'portal',
      })
    );
  res.json({ ok: true, lists_affected: subscribedRows.length });
});

// ─── GET /api/portal/hot-prospects/:id/subscriptions ───────────────────────────
// Customer-portal mirror of the admin Hot Prospect panel endpoint in
// routes/hot-prospects.js. Same shape, same renderer on the frontend.
//
// Tenant-scoped via _resolveProspectLinkedSet + _inClause — the prospect
// MUST belong to this customer's linked set. 404 (not 403) on mismatch.
router.get('/hot-prospects/:id/subscriptions', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const prospect = db
    .prepare(`SELECT id, email_client_id, prospect_email FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`)
    .get(id, ...inOwn.params);
  if (!prospect) return res.status(404).json({ error: 'prospect not found' });
  const panel = buildSubscriptionsPanel(
    prospect.email_client_id,
    prospect.prospect_email,
    { extras: { prospect_id: prospect.id } }
  );
  if (!panel) return res.status(404).json({ error: 'prospect not found' });
  res.json(panel);
});

// ─── PUT /api/portal/hot-prospects/:id/subscriptions ───────────────────────────
// Customer-side panel updates. Same body shape and behaviour as the admin
// endpoint. Audit actor records who made the change from where.
router.put('/hot-prospects/:id/subscriptions', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const prospect = db
    .prepare(`SELECT id, email_client_id, prospect_email FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`)
    .get(id, ...inOwn.params);
  if (!prospect) return res.status(404).json({ error: 'prospect not found' });
  applySubscriptionsUpdate(
    prospect.email_client_id,
    prospect.prospect_email,
    req.body || {},
    {
      actor: 'portal:' + (req.portalUser?.id || 'unknown'),
      extras: { hot_prospect_id: prospect.id, source: 'portal' },
    }
  );
  const panel = buildSubscriptionsPanel(
    prospect.email_client_id,
    prospect.prospect_email,
    { extras: { prospect_id: prospect.id } }
  );
  res.json(panel);
});

// POST /api/portal/hot-prospects/:id/mark-converted — mark as converted.
// Tenant-scoped across the customer's linked set. Idempotent: calling on an
// already-closed row preserves the original closed_at/closed_by.
router.post('/hot-prospects/:id/mark-converted', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const existing = db
    .prepare(`SELECT id FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`)
    .get(id, ...inOwn.params);
  if (!existing) {
    return res.status(404).json({ error: 'prospect not found' });
  }
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const closedBy = `portal:${req.portalUser.id}`;
  db.prepare(`
    UPDATE hot_prospects
       SET closed_at = COALESCE(closed_at, ?),
           closed_by = COALESCE(closed_by, ?),
           updated_at = ?
     WHERE id = ?
  `).run(now, closedBy, now, id);
  const row = db
    .prepare(
      `SELECT id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by, source_reply_id,
              status, tag_color, portal_first_viewed_at
         FROM hot_prospects WHERE id = ?`
    )
    .get(id);
  res.json({ prospect: row });
});

// POST /api/portal/hot-prospects/:id/reopen — undo a mark-converted.
router.post('/hot-prospects/:id/reopen', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const existing = db
    .prepare(`SELECT id FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`)
    .get(id, ...inOwn.params);
  if (!existing) {
    return res.status(404).json({ error: 'prospect not found' });
  }
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    UPDATE hot_prospects
       SET closed_at = NULL, closed_by = NULL, updated_at = ?
     WHERE id = ?
  `).run(now, id);
  const row = db
    .prepare(
      `SELECT id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by, source_reply_id,
              status, tag_color, portal_first_viewed_at
         FROM hot_prospects WHERE id = ?`
    )
    .get(id);
  res.json({ prospect: row });
});

// GET /api/portal/hot-prospects/due-counts — sidebar badge counts. Scoped
// to the customer's linked set, so portal counts reflect only this customer.
router.get('/hot-prospects/due-counts', (req, res) => {
  const clientId = req.portalClient.id;
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN follow_up_date < date('now') THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN follow_up_date = date('now') THEN 1 ELSE 0 END) AS due_today
    FROM hot_prospects
    WHERE ${inOwn.sql}
      AND closed_at IS NULL
      AND follow_up_date IS NOT NULL
      AND follow_up_date <= date('now')
  `).get(...inOwn.params);
  const overdue = Number(row?.overdue || 0);
  const dueToday = Number(row?.due_today || 0);
  res.json({ overdue, due_today: dueToday, total: overdue + dueToday });
});

// DELETE /api/portal/hot-prospects/:id — remove from list. Tenant-scoped
// across the customer's linked set so prospects on a linked inbox row are
// removable from the portal too.
router.delete('/hot-prospects/:id', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inOwn = _inClause('email_client_id', linkedIds);
  const existing = db
    .prepare(`SELECT id FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`)
    .get(id, ...inOwn.params);
  if (!existing) {
    return res.status(404).json({ error: 'prospect not found' });
  }
  db.prepare('DELETE FROM hot_prospects WHERE id = ?').run(id);
  res.json({ ok: true });
});

// GET /api/portal/hot-prospects/:id/thread — full email history with this
// prospect, built live from email_replies + email_outbound. Tenant-scoped
// across the customer's linked set so messages on a linked inbox row show
// up in the thread alongside messages on the anchor row.
router.get('/hot-prospects/:id/thread', (req, res) => {
  const clientId = req.portalClient.id;
  const id = String(req.params.id || '');
  const linkedIds = _resolveProspectLinkedSet(clientId);
  const inboxNames = _getInboxNamesByIds(linkedIds);
  const inOwn = _inClause('email_client_id', linkedIds);

  const prospect = db
    .prepare(
      `SELECT id, email_client_id, prospect_email, prospect_name,
              follow_up_date, notes, added_by, added_at, updated_at,
              closed_at, closed_by, source_reply_id,
              status, tag_color, portal_first_viewed_at
         FROM hot_prospects WHERE id = ? AND ${inOwn.sql}`
    )
    .get(id, ...inOwn.params);
  if (!prospect) {
    return res.status(404).json({ error: 'prospect not found' });
  }

  const inboundClause  = _inClause('email_client_id', linkedIds);
  const outboundClause = _inClause('email_client_id', linkedIds);

  const inbound = db
    .prepare(
      `SELECT id, email_client_id, from_address, from_name, subject,
              body_text, body_html, received_at, matched_campaign_id
         FROM email_replies
        WHERE ${inboundClause.sql}
          AND LOWER(from_address) = ?
        ORDER BY received_at ASC`
    )
    .all(...inboundClause.params, prospect.prospect_email);

  // Source-reply pin — mirror of the admin endpoint in routes/hot-prospects.js.
  // For Formspree-flagged prospects the from_address is noreply@formspree.io
  // so the address-match query above never returns the source row; we pull it
  // in here by id and merge as if it were any other inbound row. Tenant-scoped
  // by linkedIds so a stale id can't leak in another customer's reply.
  if (prospect.source_reply_id) {
    const alreadyIncluded = inbound.some(r => r.id === prospect.source_reply_id);
    if (!alreadyIncluded) {
      const sourceClause = _inClause('email_client_id', linkedIds);
      const sourceRow = db
        .prepare(
          `SELECT id, email_client_id, from_address, from_name, subject,
                  body_text, body_html, received_at, matched_campaign_id
             FROM email_replies
            WHERE id = ?
              AND ${sourceClause.sql}`
        )
        .get(prospect.source_reply_id, ...sourceClause.params);
      if (sourceRow) inbound.push(sourceRow);
    }
  }

  const outbound = db
    .prepare(
      `SELECT id, email_client_id, from_address, to_address, subject,
              body_text, body_html, sent_at, error
         FROM email_outbound
        WHERE ${outboundClause.sql}
          AND LOWER(to_address) = ?
        ORDER BY sent_at ASC`
    )
    .all(...outboundClause.params, prospect.prospect_email);

  const merged = [
    ...inbound.map(r => ({
      kind: 'reply',
      direction: 'inbound',
      at: r.received_at,
      id: r.id,
      from_address: r.from_address,
      from_name: r.from_name,
      subject: r.subject,
      body_text: r.body_text,
      body_html: r.body_html,
      matched_campaign_id: r.matched_campaign_id,
      source_inbox_name: inboxNames.get(String(r.email_client_id)) || null,
    })),
    ...outbound.map(o => ({
      kind: 'outbound',
      direction: 'outbound',
      at: o.sent_at,
      id: o.id,
      from_address: o.from_address,
      to_address: o.to_address,
      subject: o.subject,
      body_text: o.body_text,
      body_html: o.body_html,
      error: o.error,
      source_inbox_name: inboxNames.get(String(o.email_client_id)) || null,
    })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  // contact_unsubscribed + contact_on_list — see admin-side comment for the
  // three-state logic that drives the Unsubscribe/Re-subscribe banner.
  const emailLc    = String(prospect.prospect_email || '').toLowerCase();
  const unsubAddrs  = computePortalUnsubAddresses(linkedIds, [prospect.prospect_email]);
  const onListAddrs = computePortalOnListAddresses(linkedIds, [prospect.prospect_email]);

  const prospectWithSource = {
    ...prospect,
    source_inbox_name: inboxNames.get(String(prospect.email_client_id)) || null,
    has_linked_inboxes: linkedIds.length > 1,
    contact_unsubscribed: unsubAddrs.has(emailLc),
    contact_on_list:      onListAddrs.has(emailLc),
  };

  res.json({ prospect: prospectWithSource, thread: merged });
});

// ─── GET /api/portal/facebook-ads ─────────────────────────────────────────────
// Read-only Facebook performance for the logged-in customer (decision #107).
// Studio never writes to Facebook — Manus makes/manages the campaigns; this is
// just the customer's window onto spend / reach / leads / cost-per-lead + their
// live ads.
//
// Scoping: the customer's ad account lives in facebook_ads, keyed by the
// customer's OWN id (the admin sets it on the portal-facing row), so we look it
// up directly by req.portalClient.id — no linked_external_id hop is needed here
// (unlike email). This is correct for both the Cube6-linked and Manson-self-
// linked shapes: both get their facebook_ads row under their own portal id.
//
// Always 200. The frontend renders one of three clean states from the flags:
//   • no_account  → customer has no ad account set yet  → "appear once live"
//   • ok:false    → Meta call failed                    → soft error line
//   • ok:true     → account + window totals + ad cards (ads may be empty)
router.get('/facebook-ads', async (req, res) => {
  if (!metaConfigured()) {
    return res.json({ ok: false, configured: false, error: 'Facebook is not connected right now.' });
  }

  const window = ['7d', '30d', 'lifetime'].includes(req.query.window) ? req.query.window : '30d';

  const fa = db.prepare(
    'SELECT ad_account_id FROM facebook_ads WHERE email_client_id = ?'
  ).get(req.portalClient.id);

  if (!fa || !fa.ad_account_id) {
    return res.json({ ok: true, configured: true, no_account: true, window, ads: [] });
  }

  const overview = await getAdsOverview({ window, adAccountId: fa.ad_account_id });
  res.json({ configured: true, ...overview });
});

// ─── GET /api/portal/meta-pixels ──────────────────────────────────────────────
// Read-only Meta Pixel activity for the logged-in customer (decision #107).
// Anonymous aggregate website events only (page views, leads, …) — no personal
// or contact data. Scoped directly by the customer's own id (the admin keys the
// pixel row to the portal-facing id), so no linked_external_id hop — correct for
// both the Cube6-linked and Manson-self-linked shapes, same as facebook-ads.
// Always 200; flags drive the UI: no_pixel · ok:false · ok:true.
router.get('/meta-pixels', async (req, res) => {
  if (!metaConfigured()) {
    return res.json({ ok: false, configured: false, error: 'Tracking is not connected right now.' });
  }

  const window = ['7d', '30d', 'lifetime'].includes(req.query.window) ? req.query.window : '30d';

  const px = db.prepare(
    'SELECT pixel_id FROM facebook_pixels WHERE email_client_id = ?'
  ).get(req.portalClient.id);

  if (!px || !px.pixel_id) {
    return res.json({ ok: true, configured: true, no_pixel: true, window, events: [], series: [] });
  }

  const stats = await getPixelStats({ window, pixelId: px.pixel_id });
  res.json({ configured: true, ...stats });
});

export default router;
