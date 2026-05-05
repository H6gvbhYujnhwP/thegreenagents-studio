/**
 * algorithm.js — LinkedIn Algorithm Brief routes
 *
 * POST /api/algorithm/run   — triggers the Marketing Analyst Agent (Claude + web search)
 * GET  /api/algorithm/brief — returns the current stored brief + metadata
 */

import { Router } from 'express';
import Anthropic   from '@anthropic-ai/sdk';
import db          from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Marketing Analyst Agent system prompt ────────────────────────────────────
const ANALYST_SYSTEM_PROMPT = `You are the Lead LinkedIn Marketing Analyst. Your mission is to act as the intelligence layer for downstream content-creator agents.

You do not write posts. You run a research protocol to discover what is working on the LinkedIn algorithm this week, analyse the post styles of the fastest-growing creators globally, and produce a structured Algorithm & Style Brief that the creator agents must read before drafting content.

Core Directives:
- Ignore stale advice. The LinkedIn algorithm changes frequently. Source fresh data only.
- Focus on post performance, not follower count. Look for accounts growing through high dwell time, saves, and deep contextual comments.
- Be prescriptive. Downstream agents need exact instructions, not vague observations.
- Tell them exactly how long posts should be, what formats to use, and what to avoid.

When triggered, execute these research steps using your web search tool:

STEP 1: Search for the latest LinkedIn algorithm data from The Shield Index (theshieldindex.com), AuthoredUp blog (authoredup.com/blog), and Richard van der Blom's recent posts. Also scan Reddit r/LinkedInTips for the current year.

STEP 2: Search Favikon's public rankings for the fastest-growing LinkedIn creators in Marketing & Sales (app.favikon.com/public/ranking/creators/marketing-sales_linkedin-growth_linkedin/). Find the top 3 creators sorted by Growth %. Analyse the anatomy of their recent high-performing posts: hook structure, formatting, length, and how they end posts to trigger comments.

After completing research, output a structured brief in this EXACT format — no preamble, start directly with the heading:

# LinkedIn Algorithm & Style Brief (Week of [current date])

## 1. The Current Algorithm Reality
[Top 3 ranking signals that matter this week based on fresh research]

## 2. What Kills Reach This Week
[Exact tactics currently being penalised — be specific]

## 3. Winning Post Anatomy
- Format Winner: [best performing format right now]
- Hook Style: [how top creators open their first two lines]
- Body Structure: [character count, paragraph style, white space]
- Sign-off: [how they end to trigger quality comments]

## 4. Directives for Creator Agents
[3-4 bullet points of strict instructions agents must follow this week]

## Sources
[List the sources you consulted]`;

// ─── GET /api/algorithm/brief ─────────────────────────────────────────────────
router.get('/brief', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM linkedin_settings WHERE id = 1').get();
  res.json({
    brief:      row?.algorithm_brief || null,
    updatedAt:  row?.brief_updated_at || null,
    running:    row?.brief_running === 1
  });
});

// ─── POST /api/algorithm/run ──────────────────────────────────────────────────
router.post('/run', requireAuth, async (req, res) => {
  // Check not already running
  const row = db.prepare('SELECT brief_running FROM linkedin_settings WHERE id = 1').get();
  if (row?.brief_running === 1) {
    return res.status(409).json({ error: 'Analysis already running' });
  }

  // Mark as running
  db.prepare('UPDATE linkedin_settings SET brief_running = 1 WHERE id = 1').run();
  res.json({ ok: true, message: 'LinkedIn analysis started' });

  // Run asynchronously
  runAnalysis().catch(err => {
    console.error('[algorithm] Analysis failed:', err.message);
    db.prepare('UPDATE linkedin_settings SET brief_running = 0 WHERE id = 1').run();
  });
});

async function runAnalysis() {
  console.log('[algorithm] Starting LinkedIn Marketing Analyst run...');

  try {
    // web_search_20250305 is a server-side tool — Anthropic executes searches
    // automatically. We do NOT manually handle tool_use loops for this tool.
    // Just make one call with the beta header and wait for end_turn.
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: ANALYST_SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      betas: ['web-search-2025-03-05'],
      messages: [{
        role: 'user',
        content: `Run the weekly LinkedIn analysis now. Today's date is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.

Execute both research steps using your web_search tool:
1. Search for current LinkedIn algorithm signals from Shield Index, AuthoredUp, Richard van der Blom, and Reddit r/LinkedInTips
2. Search Favikon rankings for fastest-growing Marketing & Sales creators — analyse their post anatomy

Then output the Algorithm & Style Brief in the exact format specified. Start directly with the # heading.`
      }]
    });

    console.log(`[algorithm] Claude finished — stop_reason: ${response.stop_reason}`);

    // Extract text — may be in multiple blocks if web search results interleaved
    const brief = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (!brief) throw new Error('Claude returned no text content');

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE linkedin_settings
      SET algorithm_brief = ?, brief_updated_at = ?, brief_running = 0
      WHERE id = 1
    `).run(brief, now);

    console.log(`[algorithm] Analysis complete — brief updated at ${now}`);
  } catch (err) {
    console.error('[algorithm] Analysis error:', err.message);
    db.prepare('UPDATE linkedin_settings SET brief_running = 0 WHERE id = 1').run();
    throw err;
  }
}

// Export so campaigns.js can pull the brief for injection
export function getCurrentBrief() {
  const row = db.prepare('SELECT algorithm_brief FROM linkedin_settings WHERE id = 1').get();
  return row?.algorithm_brief || null;
}

export default router;
