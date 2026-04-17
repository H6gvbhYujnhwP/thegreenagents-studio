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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const POSTS_PER_CAMPAIGN = 12;

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

CONTENT RULES

Every post should do at least one of these:
- teach
- reframe
- challenge a bad assumption
- show proof
- tell a useful story
- expose a costly mistake
- explain a decision
- create a qualified conversation

Write for the client's buyers, not their peers.

Default rules:
- use short paragraphs
- avoid walls of text
- keep the first 2 lines strong — hook must earn attention
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

CRITICAL OUTPUT RULE

Your entire response must be valid JSON and nothing else.
Do not output a research summary. Do not output any text before or after the JSON.
Do not explain your thinking. Do not introduce the posts.
Start your response with the { character and end with the } character.
Any text outside the JSON object will cause the entire pipeline to fail.`;

// ─── Generate posts using Claude with web search + prompt caching ─────────────
export async function generatePosts(client, onProgress, contentDna = null) {
  onProgress('Starting Claude — researching LinkedIn algorithm and industry trends...');

  const dnaSection = contentDna
    ? `\nCLIENT CONTENT DNA (writing style from Supergrow — match this voice exactly):\n${contentDna}\n`
    : '';

  // Build the user message — RAG is included here with cache_control
  // so it gets cached alongside the system prompt on repeated calls
  const userContent = [
    {
      type: 'text',
      text: `CLIENT BRIEF:
Name: ${client.name}
Brand: ${client.brand}
Website: ${client.website || 'Not provided'}
Timezone: ${client.timezone}
Posting Cadence: ${client.cadence}
${dnaSection}
CLIENT RAG DOCUMENT — THE ONLY SOURCE OF TRUTH FOR THIS CAMPAIGN:`,
    },
    {
      type: 'text',
      text: client.rag_content || 'No RAG document uploaded for this client.',
      // Cache the RAG content — it's large and reused across calls
      cache_control: { type: 'ephemeral' }
    },
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

  onProgress('Claude is researching LinkedIn trends and reading the RAG document...');

  let response;
  try {
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 16000,
      system: [
        {
          type: 'text',
          text: STAGE3_SYSTEM_PROMPT,
          // Cache the system prompt — reused across all calls in this campaign
          cache_control: { type: 'ephemeral' }
        }
      ],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search'
        }
      ],
      messages: [
        { role: 'user', content: userContent }
      ]
    });
  } catch (err) {
    // If web search fails (e.g. not available on this key), retry without it
    console.warn('[claude] Web search failed, retrying without search tool:', err.message);
    onProgress('Web search unavailable — generating from RAG only...');
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 16000,
      system: [
        {
          type: 'text',
          text: STAGE3_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [
        { role: 'user', content: userContent }
      ]
    });
  }

  // Handle tool use — Claude may do web searches before responding
  // We need to handle the full agentic loop
  let fullResponse = response;
  let messages = [{ role: 'user', content: userContent }];

  while (fullResponse.stop_reason === 'tool_use') {
    onProgress('Claude is searching the web for LinkedIn algorithm data...');

    const toolUseBlock = fullResponse.content.find(b => b.type === 'tool_use');
    if (!toolUseBlock) break;

    // Add assistant message with tool use
    messages.push({ role: 'assistant', content: fullResponse.content });

    // Add tool result (web search results come back automatically in extended thinking)
    // For web_search_20250305, we need to provide a tool_result
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseBlock.id,
        content: 'Search completed. Use the results to inform your post generation.'
      }]
    });

    fullResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 16000,
      system: [
        {
          type: 'text',
          text: STAGE3_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search'
        }
      ],
      messages
    });
  }

  // Extract the final text response
  const textBlock = fullResponse.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text content');

  onProgress('✓ Claude finished writing — parsing posts...');

  // Strip any markdown fences if present
  const raw = textBlock.text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();

  let result;
  try {
    result = JSON.parse(raw);
  } catch (err) {
    // Try to extract JSON object from the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        result = JSON.parse(match[0]);
      } catch (_) {}
    }
    if (!result) throw new Error(`Claude did not return valid JSON: ${raw.slice(0, 300)}`);
  }

  if (!result.posts || result.posts.length === 0) {
    throw new Error('Claude returned no posts');
  }

  // Log cache usage if available
  const usage = fullResponse.usage;
  if (usage?.cache_read_input_tokens > 0) {
    console.log(`[claude] Cache hit — ${usage.cache_read_input_tokens} tokens from cache, ${usage.cache_creation_input_tokens || 0} new`);
  }

  onProgress(`✓ Claude generated ${result.posts.length} posts.`);
  return result;
}

// ─── Get LinkedIn algorithm context (kept for compatibility, now handled by Claude inline) ──
export async function getLinkedInAlgorithmContext(onProgress) {
  // Claude now handles research inline during generatePosts.
  // This function is kept so campaigns.js doesn't need changing.
  onProgress('LinkedIn research will be handled by Claude during post generation.');
  return null;
}

// ─── Regenerate a single post using Claude ────────────────────────────────────
export async function regenerateSinglePost(post, client, contentDna = null) {
  const dnaNote = contentDna
    ? `\nContent DNA (match this writing style exactly):\n${contentDna}\n`
    : '';

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
  let result;
  try {
    result = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Claude did not return valid JSON for single post: ${raw.slice(0, 200)}`);
  }

  if (!result.linkedin_post_text) throw new Error('Claude returned no post text');
  return result;
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
  return textBlock.text.trim();
}
