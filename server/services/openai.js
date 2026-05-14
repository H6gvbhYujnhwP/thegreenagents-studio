/**
 * openai.js — Post generation using Claude Sonnet
 *
 * Switched from GPT-4o to Claude claude-sonnet-4-5 for better instruction-following,
 * voice matching, and RAG grounding.
 *
 * Features:
 * - Prompt caching on system prompt + RAG (faster, ~90% cheaper on cached tokens)
 * - Web search tool enabled (Claude researches LinkedIn algorithm live before writing)
 * - Stage 3 LinkedIn Content Agent system prompt
 * - Same JSON output format as before — rest of app unchanged
 *
 * NOTE: File is named openai.js for import compatibility but uses Anthropic SDK.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  parseRules,
  renderRulesPromptBlock,
  validatePostAgainstRules,
  MAX_VALIDATION_ATTEMPTS,
} from './content-rules.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const POSTS_PER_CAMPAIGN = 12;

// ─── Robust JSON parsing for Claude responses ────────────────────────────────
// Tries three strategies in order:
//   1. Direct JSON.parse on the (markdown-fence-stripped) raw text
//   2. Greedy outer-object extraction via /\{[\s\S]*\}/ and re-parse
//   3. Repair pass — strips stray non-JSON tokens that the model occasionally
//      hallucinates between fields (e.g. the literal word "Menu" appearing
//      between two key-value pairs on the Manson Group 2026-05-12 run with
//      stop_reason="end_turn"). The regex matches: between `,` and the next
//      `"key":`, any non-quote/non-brace/non-bracket/non-comma token, and
//      removes it. Conservative — only fires in JSON-structural positions
//      where a key opener should follow a comma, so legitimate string values
//      containing commas can't be damaged.
// Returns the parsed object or null if all strategies fail.
function tryParseClaudeJSON(raw) {
  try { return JSON.parse(raw); } catch (_) {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) {}
  try {
    const repaired = match[0].replace(/,(\s*)[^"{}\[\],\s][^",{}\[\]]*?(\s+)"/g, ',$1$2"');
    return JSON.parse(repaired);
  } catch (_) {}
  return null;
}

// ─── AI output sanitiser ──────────────────────────────────────────────────────
// Strips stray non-Latin characters that Claude very occasionally emits in the
// middle of otherwise-fine English prose. Most often invisible Unicode (zero-
// width chars, byte-order marks) but visible CJK / Cyrillic / Arabic chars
// have also been observed in the wild — first reported on a Manson Group post
// where the phrase "your packaging hits a Materials Recovery Facility" had
// stray CJK glyphs spliced into it mid-sentence.
//
// Whitelist is deliberately generous so we don't mangle legitimate text:
//   - Tab, LF, CR (so paragraph breaks survive)
//   - Printable ASCII (U+0020–U+007E)
//   - Latin-1 Supplement + Latin Extended-A/B (U+00A0–U+024F) — covers all
//     European accented chars (é à ü ñ ç ø etc.) for customer/place names
//   - General Punctuation block subset (U+2010–U+2027, U+2030–U+205E) —
//     em-dash, en-dash, ellipsis, curly quotes, bullet, etc. Claude uses
//     these heavily as part of its writing style
//   - Currency Symbols (U+20A0–U+20CF) — €, £ etc.
//
// Strips everything else: CJK (U+3000+), Cyrillic (U+0400+), Arabic (U+0600+),
// Hebrew, Thai, Devanagari, zero-width chars, etc.
//
// Recurses through arrays + plain objects so a whole post object can be passed
// in. Non-string leaves (numbers, booleans, null) are untouched. Logs a count +
// sample when stripping happens, so we have visibility into how often it fires.
const ALLOWED_CHARS_RE = /[^\t\n\r\u0020-\u007E\u00A0-\u024F\u2010-\u2027\u2030-\u205E\u20A0-\u20CF]/g;

function sanitizeAiText(value, _ctx = 'root') {
  if (typeof value === 'string') {
    const stripped = [];
    const cleaned  = value.replace(ALLOWED_CHARS_RE, (ch) => {
      stripped.push(ch);
      return '';
    });
    if (stripped.length > 0) {
      // Log a sample of what was stripped so we can spot patterns. Cap at 10
      // chars + show their hex codes so CJK glyphs are visible in logs even
      // if the log viewer can't render them.
      const sample = stripped.slice(0, 10)
        .map(c => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
        .join(' ');
      console.log(`[sanitize] stripped ${stripped.length} non-Latin char(s) from AI output (${_ctx}): ${sample}${stripped.length > 10 ? ' …' : ''}`);
    }
    return cleaned;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => sanitizeAiText(item, `${_ctx}[${i}]`));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeAiText(v, `${_ctx}.${k}`);
    }
    return out;
  }
  return value;
}

// ─── Stage 3 LinkedIn Content Agent System Prompt ────────────────────────────
// This is cached by Anthropic's prompt caching — sent once, reused across
// all posts in a campaign at ~90% token cost reduction.
const STAGE3_SYSTEM_PROMPT = `You are a LinkedIn Content Agent.

You are Stage 3 only.

Your job is to create high-performing LinkedIn content using:
1. the client's RAG file
2. the client's uploaded source materials
3. fresh live web research completed before each batch

You are not allowed to write from generic memory when client materials or current research should guide the answer.

PRIMARY OBJECTIVE

Create client-specific LinkedIn posts that:
- sound like the client
- align with their positioning and USP
- attract the right buyers
- build trust and authority
- increase dwell time and meaningful comments
- support commercial goals without hard-selling

MANDATORY EXECUTION ORDER

For every content request:
1. Read the client RAG file and relevant uploaded source materials first.
2. Use your web search tool to run a fresh live research check before writing any posts.
3. Create the requested posts informed by both the RAG and the research.
4. Silently run a quality check before finalising.

Do not skip research.
Do not create posts first and research later.

MANDATORY PRE-WRITING RESEARCH

Use your web search tool to research the following before writing a single post:

A. Search for current LinkedIn algorithm best practices and content performance data for the current year. Find: which formats perform best right now, what signals LinkedIn rewards (dwell time, comments, saves), what to avoid (link posts, engagement bait, obvious AI patterns), and any recent observations from the last 60 days.

B. Search for current news and trends relevant to the client's specific industry. Find: one timely development, one buyer pain point currently being discussed, one strong content angle for this week.

Use search results directly to inform your post topics, hooks, and format choices. Do not skip this step.

RETRIEVAL-FIRST RULE

The client RAG file is the main source of truth.

Use the RAG file to determine: offers, audience, USP, proof, objections, brand voice, safe claims, risky claims, terminology, content goals, content boundaries.

If the RAG file answers a question, follow it. Do not replace client truth with generic best practice.

VOICE RULE

Write in the client's voice, not your own.

Match: tone, vocabulary, level of polish, humour level, directness, founder/operator/expert style, phrases they naturally use, phrases they avoid.

Do not sound like a generic LinkedIn ghostwriter.
Do not sound corporate.
Do not sound like polished AI.
Sound like a real human who has been in this industry for years and has opinions.

HUMAN-SOUNDING WRITING RULES

Posts must feel like a real person typed them, not an AI. To achieve this:

Use contractions naturally. Use sentence fragments where a real person would. Let thoughts run slightly rough at the edges. Use specific details, not vague generalities. Reference real situations, not hypothetical ones. Have opinions. Be willing to say something is wrong or bad. Use the client's actual vocabulary from the RAG.

Avoid: symmetrical list structures that scream AI, identical sentence lengths, corporate rhythm, hedging language, vague encouragement, anything that sounds like it was optimised for politeness.

STORY-FIRST WRITING RULE — THIS IS THE DEFAULT STRUCTURE FOR EVERY POST

Every post must be story-led. The story comes first. The insight, lesson, or argument is revealed through the story — not stated upfront and then illustrated.

Do not open with a claim or thesis. Open with a scene, a person, a moment, a conversation, or a specific situation. Put the reader inside the story before you give them the point.

Wrong structure (argument-led):
"Waiting for budget approval is often the most expensive option. A manufacturing business I spoke to had a problem..."

Right structure (story-led):
"A manufacturing business I spoke to had a packaging line that kept jamming. Three months of overtime. Missed delivery windows. A major client starting to look elsewhere. The fix was sitting in a quote on the MD's desk — but it wasn't in this year's budget..."

The insight lands at the end of the story, not the top. The reader earns it.

Every post must include at minimum one of:
- a real conversation the client had with a buyer or prospect
- a specific situation a client or contact was in
- something the writer observed or noticed directly
- a decision someone made (or didn't make) and what happened

The story must be specific. Real job titles. Real industries. Real consequences. Real timelines. Not "a business I know" — "a fabrication firm in the Midlands" or "an MD I spoke to last month." Specificity is what makes it feel true.

After the story, the post draws out the lesson — briefly and plainly. One or two paragraphs max. Then the closing question.

This applies to ALL post formats — Text Posts, Founder Stories, and Video Scripts. Founder Stories go deepest into the personal experience. Text Posts use a client or third-party story. Video Scripts open with the story hook before pulling out to the bigger point.

Write for the client's buyers, not their peers.

Default rules:
- use short paragraphs
- avoid walls of text
- keep the first 2 lines strong — hook must earn attention by dropping into a scene or situation
- no filler, no motivational fluff, no generic thought leadership
- no hard sell
- no external links unless explicitly requested
- never "link in first comment"
- end with a specific open-ended question that invites qualified replies

FORMATTING RULES — ABSOLUTE AND NON-NEGOTIABLE

NO EMOJIS. Zero emojis anywhere in any post text. Not one. No thumbs up, no stars, no arrows, no check marks, no hearts, nothing. No exceptions.

NO DECORATIVE SYMBOLS. No bullet symbols, checkmarks, right arrows, star symbols, diamond symbols, or any unicode decoration character. Plain text only. No exceptions.

PARAGRAPH SPACING IS MANDATORY. Every paragraph must be separated by a blank line. Short paragraphs of 1 to 3 sentences only. Never write a wall of text.

CAROUSEL POST RULE. For carousel format posts, linkedin_post_text is the post caption only — a compelling hook of 200 to 400 characters that makes someone want to swipe. Do NOT write "Swipe to learn more" or any generic CTA. Write a specific, curiosity-driven hook grounded in the post topic. Do NOT put slide content inside linkedin_post_text. Slide content goes exclusively in the carousel_slides field.

FORMAT MIX RULE

For a batch of 12 posts, use ONLY these formats:
- 8 to 9 Text Posts
- 2 to 3 Founder Story posts (personal voice, first person, written as if John typed it)
- 1 Video Script

DO NOT generate any Carousel or Document posts. No carousels. No documents. Text only.

Rotate content types: contrarian take, buyer pain, myth-busting, story/war story, case study, proof-led insight, framework/checklist, behind the scenes, trend interpretation, objection handling.

SAFE WRITING RULES

Do not invent stats, case studies, results, testimonials, customer names, timelines, guarantees, or category claims. Do not overclaim. Respect compliance limits and client-specific banned phrases.

BANNED WORDS

Never use: delve, landscape, testament, crucial, unlock, game-changer, in today's world, it's worth noting, at the end of the day, foster, leverage as a verb, robust, seamless, holistic.

Also avoid any client-specific banned phrases found in their RAG document.

QUALITY CHECK BEFORE FINALISING

Before finalising, silently check every post:
- opens with a story, scene, or specific situation — NOT a claim or thesis
- the insight lands after the story, not before it
- the story is specific: real industry, real role, real consequence, real timeline
- grounded in RAG and source materials
- informed by fresh research
- sounds like this specific client, not a generic ghostwriter
- hook is sharp in the first 2 lines (under 140 characters combined)
- no emojis, no decorative symbols anywhere
- every paragraph separated by a blank line
- format choice fits the idea
- no unsupported claims
- ending question is specific and invites qualified replies
- soft sell, not hard sell
- could this post only have come from this specific client? If no, rewrite it.

BATCH UNIQUENESS CHECK — run this across all posts before responding:
- Does each post teach a genuinely different lesson from every other post?
- Do the closing questions all ask something different?
- Would a reader who read all posts learn 12 distinct things, not 1 thing told 12 ways?
If not, identify the duplicate posts and rewrite them with a completely different angle before outputting.

CRITICAL OUTPUT RULE

Your entire response must be valid JSON and nothing else.
Do not output a research summary. Do not output any text before or after the JSON.
Do not explain your thinking. Do not introduce the posts.
Start your response with the { character and end with the } character.
Any text outside the JSON object will cause the entire pipeline to fail.`;

// ─── Generate posts using Claude with web search + prompt caching ─────────────
export async function generatePosts(client, onProgress, contentDna = null, algorithmBrief = null) {
  onProgress('Starting Claude — researching LinkedIn algorithm and industry trends...');

  const dnaSection = contentDna
    ? `\nCLIENT CONTENT DNA (writing style from Supergrow — match this voice exactly):\n${contentDna}\n`
    : '';

  const briefSection = algorithmBrief
    ? `\nLINKEDIN ALGORITHM & STYLE BRIEF (current week — follow these directives exactly):\n${algorithmBrief}\n`
    : '';

  // Build the user message — RAG is included here with cache_control
  // so it gets cached alongside the system prompt on repeated calls
  const rules           = parseRules(client);
  const rulesPromptBlock = renderRulesPromptBlock(rules); // null if no rules

  const userContent = [
    {
      type: 'text',
      text: `CLIENT BRIEF:
Name: ${client.name}
Brand: ${client.brand}
Website: ${client.website || 'Not provided'}
Timezone: ${client.timezone}
Posting Cadence: ${client.cadence}
${dnaSection}${briefSection}
CLIENT RAG DOCUMENT — THE ONLY SOURCE OF TRUTH FOR THIS CAMPAIGN:`,
    },
    {
      type: 'text',
      text: client.rag_content || 'No RAG document uploaded for this client.',
      // Cache the RAG content — it's large and reused across calls
      cache_control: { type: 'ephemeral' }
    },
    // Customer "refine my posts" rules go HERE — after cached RAG, before
    // the TASK block. Deliberately NOT cached so edits/deletes to rules
    // take effect on the next call regardless of Anthropic's 5-min cache
    // window. When `rules` is empty, the block is null and we skip it
    // entirely (no "no rules" noise sent to the model).
    ...(rulesPromptBlock ? [rulesPromptBlock] : []),
    {
      type: 'text',
      text: `

TASK:
1. Use your web_search tool now to research: (a) current LinkedIn algorithm best practices and format performance for ${new Date().getFullYear()}, and (b) current trends and buyer pain points in this client's industry.
2. Then generate exactly ${POSTS_PER_CAMPAIGN} LinkedIn posts for this client.

Every topic, angle, proof point, and voice detail MUST come from the RAG document above.
Vary formats across the batch as instructed.
Separate every paragraph with a blank line. No emojis. No decorative symbols.
Text post bodies must be minimum 1,200 characters.
carousel_slides must always be null — no carousel format is used.
Founder story posts: first person, specific, human — not polished.

TOPIC DIVERSITY — MANDATORY:
The ${POSTS_PER_CAMPAIGN} posts must cover genuinely different topics drawn from the RAG. Do not repeat the same core message or lesson in multiple posts.

Required content angle rotation — each post must use a different angle from this list:
- Myth-busting (challenge a wrong belief buyers hold)
- How it works (explain a process or product mechanic the buyer doesn't know)
- Objection handling (address a specific reason buyers hesitate)
- Stat or data point (ground an insight in a real number or trend)
- Client story / case study (specific situation, outcome, what changed)
- Contrarian take (disagree with conventional wisdom in this space)
- Behind the scenes (how decisions get made, how the process actually works)
- Buyer pain (name a specific costly problem buyers live with and accept)
- Comparison (this approach vs that approach — what most people miss)
- Trend or timing (something changing in the market right now that matters)
- FAQ / common question (answer what buyers always ask but rarely get a straight answer to)
- Stakes (what happens if you don't act — specific and tangible, not vague)

No two posts may share the same angle. No two posts may end with the same type of question.

ANTI-DUPLICATION GATE — CRITICAL:
Before writing each post, state internally: "What is the single core lesson this post teaches that NONE of the previous posts teach?" If you cannot name a distinct lesson, pick a different topic.

Before finalising your response, scan all ${POSTS_PER_CAMPAIGN} posts and check:
- Does every post have a different core lesson?
- Does every post have a different CTA or closing question?
- Could a reader learn something new from post 8 that they did not learn from posts 1-7?

If any two posts are teaching the same thing in different words, rewrite the duplicate before responding.

RESPONSE FORMAT — CRITICAL:
Your ENTIRE response must be valid JSON and nothing else.
Start your response with { and end with }.
No research summary. No preamble. No explanation. No markdown fences.
If you output anything before the opening { the entire response will fail.

{
  "posts": [
    {
      "id": 1,
      "topic": "Specific topic from client RAG",
      "angle": "Specific angle grounded in client positioning",
      "buyer_segment": "Exact buyer described in RAG",
      "cta_type": "Type of call to conversation",
      "content_pillar": "Authority / Story / Education / Commercial / Engagement",
      "format": "Text Post / Carousel / Video Script",
      "suggested_day": "Tuesday",
      "suggested_time": "08:00",
      "linkedin_post_text": "Post body — blank line between every paragraph, no emojis, no symbols, 1200+ chars for text posts, specific caption only for carousels",
      "carousel_slides": null,
      "image_prompt": "Specific visual description — photorealistic, relevant to this client world, no text overlays"
    }
  ]
}

For carousel posts, carousel_slides must be an array:
[{"slide": 1, "title": "...", "body": "..."}, {"slide": 2, "title": "...", "body": "..."}]
For text posts and video scripts, carousel_slides must be null.`
    }
  ];

  onProgress('Claude is writing posts — this takes 2-3 minutes, please wait...');

  // Use streaming to avoid the SDK 10-minute non-streaming timeout.
  // stream.finalMessage() collects all streamed chunks and returns the complete message.
  //
  // Wrapped in a helper because we may need to call it twice — if Claude's
  // first response can't be parsed as JSON (rare model anomaly: stray tokens
  // hallucinated into the middle of valid JSON, e.g. the literal word "Menu"
  // appearing between two field separators on the Manson Group run in
  // 2026-05-12 logs — `stop_reason: end_turn` so the model THOUGHT it had
  // finished, but the output wasn't parseable). On retry we tighten the
  // "respond ONLY with JSON" instruction, which is usually enough.
  async function callClaudeForPosts(extraInstruction) {
    const userContentForCall = extraInstruction
      ? [
          ...userContent,
          { type: 'text', text: extraInstruction }
        ]
      : userContent;
    try {
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-5',
        max_tokens: 64000,
        system: [
          {
            type: 'text',
            text: STAGE3_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' }
          }
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: userContentForCall }]
      }, {
        headers: { 'anthropic-beta': 'web-search-2025-03-05' }
      });
      const r = await stream.finalMessage();
      console.log('[claude] generatePosts stream complete — stop_reason:', r.stop_reason);
      return r;
    } catch (err) {
      console.warn('[claude] Streaming with web search failed, retrying without:', err.message);
      onProgress('Generating posts from RAG (no live search)...');
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-5',
        max_tokens: 64000,
        system: [
          {
            type: 'text',
            text: STAGE3_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [{ role: 'user', content: userContentForCall }]
      });
      const r = await stream.finalMessage();
      console.log('[claude] generatePosts fallback stream complete — stop_reason:', r.stop_reason);
      return r;
    }
  }

  // Try parse strategies in order of strictness (delegated to module-level
  // tryParseClaudeJSON — see header comment for the strategy list and the
  // Manson 2026-05-12 case the repair pass was designed for).

  let fullResponse;
  let result = null;
  let lastRaw = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const extra = attempt === 2
      ? 'IMPORTANT: your previous response was not valid JSON. Respond ONLY with the JSON object specified above. Do not include any other text, words, prose, or comments — not before the JSON, not after it, and not anywhere inside the JSON structure. Every character must be part of valid JSON.'
      : null;
    fullResponse = await callClaudeForPosts(extra);

    const textBlock = fullResponse.content.find(b => b.type === 'text');
    if (!textBlock) {
      console.warn(`[claude] generatePosts attempt ${attempt}: no text content in response`);
      continue;
    }

    onProgress(attempt === 1
      ? 'Claude finished writing — parsing posts...'
      : 'Retrying parse with stricter JSON instruction...');

    // Strip any markdown fences if present
    const raw = textBlock.text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    lastRaw = raw;

    result = tryParseClaudeJSON(raw);
    if (result) {
      if (attempt > 1) onProgress(`✓ Recovered on retry (attempt ${attempt}).`);
      break;
    }

    // Parse failed. Log the FULL raw response (not a 300-char slice) so we
    // can see exactly what the model produced and improve the repair pass
    // later if a new anomaly type appears.
    console.warn(`[claude] generatePosts attempt ${attempt} — JSON parse failed. Raw response (${raw.length} chars):\n${raw}`);
    if (attempt < 2) {
      onProgress(`Claude's response wasn't valid JSON — retrying once with a stricter instruction…`);
    }
  }

  if (!result) {
    throw new Error(`Claude did not return valid JSON after 2 attempts. First 1000 chars of last response: ${lastRaw.slice(0, 1000)}`);
  }

  if (!result.posts || result.posts.length === 0) {
    throw new Error('Claude returned no posts');
  }

  // Log cache usage if available
  const usage = fullResponse.usage;
  if (usage?.cache_read_input_tokens > 0) {
    console.log(`[claude] Cache hit — ${usage.cache_read_input_tokens} tokens from cache, ${usage.cache_creation_input_tokens || 0} new`);
  }

  // ── Validation pass against customer override rules ────────────────────────
  // For each post, ask Haiku 4.5 whether it violates any rule. Re-generate
  // failed posts up to MAX_VALIDATION_ATTEMPTS - 1 times with the violated
  // rules called out. If the second attempt still fails, attach a
  // validation_warnings array to the post so the customer can see the
  // flagged rule and adjust their rules document accordingly.
  if (rules.length > 0 && Array.isArray(result.posts)) {
    onProgress('Validating posts against your refine-my-posts rules…');

    // First pass — validate all posts in parallel.
    const checks = await Promise.all(result.posts.map(p =>
      validatePostAgainstRules(p.linkedin_post_text || '', rules)
    ));

    // Re-generate any failures sequentially (parallel Sonnet calls would
    // burn rate limits and provide no UX benefit at 12-post scale).
    for (let i = 0; i < result.posts.length; i++) {
      const check = checks[i];
      if (check.ok) continue;

      const original = result.posts[i];
      const failedRules = rules.filter(r =>
        check.violations.some(v => v.ruleId === r.id)
      );

      try {
        const rewritten = await regenerateSinglePost(original, client, { failedRules });
        const recheck   = await validatePostAgainstRules(
          rewritten.linkedin_post_text || '',
          rules
        );
        // Always accept the rewrite (it had more context — failed rules called
        // out explicitly), but attach warnings if it STILL violates.
        result.posts[i] = {
          ...original,
          linkedin_post_text: rewritten.linkedin_post_text || original.linkedin_post_text,
          image_prompt:       rewritten.image_prompt       || original.image_prompt,
          validation_warnings: recheck.ok ? undefined : recheck.violations,
        };
      } catch (err) {
        // Rewrite failed — keep the original post and flag it.
        console.warn(`[content-rules] Rewrite of post ${original.id} failed:`, err.message);
        result.posts[i] = {
          ...original,
          validation_warnings: check.violations,
        };
      }
    }

    const flagged = result.posts.filter(p => Array.isArray(p.validation_warnings) && p.validation_warnings.length > 0).length;
    if (flagged > 0) {
      onProgress(`⚠ ${flagged} post(s) flagged after validation — review them in the portal.`);
    } else {
      onProgress(`✓ All posts pass the refine-my-posts rules.`);
    }
  }

  onProgress(`✓ Claude generated ${result.posts.length} posts.`);
  // Strip stray non-Latin chars across all generated post text (occasional
  // Claude artefact — see sanitizeAiText header). Recurses into the posts
  // array so every text field on every post is cleaned.
  return sanitizeAiText(result, `generatePosts:${client.name || client.id || '?'}`);
}

// ─── Get LinkedIn algorithm context (kept for compatibility, now handled by Claude inline) ──
export async function getLinkedInAlgorithmContext(onProgress) {
  // Claude now handles research inline during generatePosts.
  // This function is kept so campaigns.js doesn't need changing.
  onProgress('LinkedIn research will be handled by Claude during post generation.');
  return null;
}

// ─── Regenerate a single post using Claude ────────────────────────────────────
// `opts` accepts:
//   - contentDna:  string, Supergrow writing-style block (legacy, optional)
//   - failedRules: array of {id, text}, rules that the previous draft violated
//                  (used during bulk-generation retries — extra emphasis on
//                  these specific rules in the rewrite prompt)
//
// Customer override rules (from clients.content_rules) are ALWAYS read fresh
// from the client row passed in. Because portal.js fetches the client right
// before calling this on every regen, the customer's latest rules apply on
// every single-post regen — no caching, no staleness.
export async function regenerateSinglePost(post, client, opts = {}) {
  const { contentDna = null, failedRules = [] } = (opts && typeof opts === 'object') ? opts : {};

  const dnaNote = contentDna
    ? `\nContent DNA (match this writing style exactly):\n${contentDna}\n`
    : '';

  // Read the customer's refine-my-posts rules fresh from the client row.
  // renderRulesPromptBlock returns null when there are none — we skip the
  // block entirely in that case rather than send empty noise.
  const rules            = parseRules(client);
  const rulesPromptBlock = renderRulesPromptBlock(rules, { failedRules });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 3000,
    system: [
      {
        type: 'text',
        text: STAGE3_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Rewrite this LinkedIn post. The operator was not satisfied and requested a fresh version.

CLIENT RAG — ground the rewrite entirely in this material:`,
          },
          {
            type: 'text',
            text: (client.rag_content || '').slice(0, 4000),
            cache_control: { type: 'ephemeral' }
          },
          // Customer refine-my-posts rules — non-cached so edits/deletes take
          // effect on the very next regen (which is exactly what we promised
          // the customer).
          ...(rulesPromptBlock ? [rulesPromptBlock] : []),
          {
            type: 'text',
            text: `${dnaNote}
POST BRIEF (keep the same strategic intent, rewrite the text completely):
Topic: ${post.topic}
Angle: ${post.angle}
Buyer: ${post.buyer_segment}
Format: ${post.format || 'Text Post'}
Pillar: ${post.content_pillar}

RULES:
- Ground every sentence in the client RAG — no generic content
- Minimum 1,200 characters for text post body
- First 2 lines = scroll-stopping hook under 140 chars combined
- Blank line between every paragraph — no walls of text
- End with a specific open-ended question that invites qualified replies
- No external URLs in the post body
- No banned words: delve, landscape, testament, crucial, unlock, game-changer
- NO emojis, NO decorative symbols, plain text only
- Sound like a real human, not polished AI
- Final check: could this only come from this specific client?

Respond ONLY with valid JSON, no preamble, no markdown fences:
{
  "linkedin_post_text": "...",
  "carousel_slides": null,
  "image_prompt": "..."
}`
          }
        ]
      }
    ]
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text for single post rewrite');

  const raw = textBlock.text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
  const result = tryParseClaudeJSON(raw);
  if (!result) {
    console.warn(`[claude] regenerateSinglePost — JSON parse failed. Raw response (${raw.length} chars):\n${raw}`);
    throw new Error(`Claude did not return valid JSON for single post. First 500 chars: ${raw.slice(0, 500)}`);
  }

  if (!result.linkedin_post_text) throw new Error('Claude returned no post text');
  // Strip stray non-Latin chars (occasional Claude artefact — see header).
  return sanitizeAiText(result, `regenerateSinglePost:${client.name || client.id || '?'}`);
}

// ─── Fix a post that scored below quality threshold ───────────────────────────
export async function fixPost(post, scoreFeedback, suggestions = [], contentDna = null) {
  const dnaNote = contentDna ? `\nContent DNA:\n${contentDna}\n` : '';
  const suggestionsNote = suggestions.length > 0
    ? `\nSpecific suggestions to action:\n${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    system: STAGE3_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Improve this LinkedIn post that scored below 70/100 on the quality scorer.

Original post:
${post.linkedin_post_text}

Score feedback:
${scoreFeedback}
${suggestionsNote}${dnaNote}
Post context — Topic: ${post.topic} | Audience: ${post.buyer_segment} | Format: ${post.format || 'Text Post'}

Rewrite the post to score 70 or above. Fix all issues raised in the feedback.
Keep the same topic, angle, and CTA intent.
Minimum 1,200 characters. Blank lines between paragraphs. No emojis or symbols.
Return ONLY the improved post text — no preamble, no explanation, no JSON.`
      }
    ]
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text for post fix');
  // Strip stray non-Latin chars (occasional Claude artefact — see header).
  return sanitizeAiText(textBlock.text.trim(), `fixPost:${post.id || '?'}`);
}
