/**
 * portal.js — Customer-portal DATA routes (chunk 3, partial: posts only).
 *
 * Mounted at /api/portal in server/index.js. All routes here require a
 * customer-portal session (requirePortalSession from portal-auth.js) and
 * filter every query by the resolved customer's id — never trust ids from
 * the URL or body.
 *
 * This file currently only contains GET /posts. Inbox + campaigns + replies
 * + send routes will land in subsequent commits — staged so each chunk can be
 * verified before piling on more surface area.
 */
import { Router } from 'express';
import db from '../db.js';
import { requirePortalSession } from './portal-auth.js';

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

export default router;
