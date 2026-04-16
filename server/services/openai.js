/**
 * openai.js — Post generation using OpenAI GPT-4o
 *
 * Uses the LinkedIn New Client Master system prompt (replicated from the
 * ChatGPT custom GPT g-69d3ce85ae40819197dafc2e4f7b14d6).
 *
 * Two-step process per campaign:
 * 1. getLinkedInAlgorithmContext() — live web search for current algorithm
 *    best practices (refreshed on every campaign run)
 * 2. generatePosts() — GPT-4o generates posts in JSON format using the
 *    master system prompt + fresh algorithm context + client RAG
 */

import OpenAI from 'openai';

// Accept both OPENAI_API_KEY (standard) and OPENAI_AI_KEY (legacy Render var name)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_AI_KEY
});

// ─── How many posts to generate per campaign ─────────────────────────────────
// Set to 12 for testing. Change to 96 for production.
// NOTE: GPT-4o max output is ~16k tokens. For 96 posts, batching will be needed.
// At 12 posts per batch, run 8 batches. For now, 12 is the default.
const POSTS_PER_CAMPAIGN = 12;

// ─── LinkedIn New Client Master System Prompt ─────────────────────────────────
// Exact replica of the ChatGPT custom GPT instructions.
const LINKEDIN_MASTER_SYSTEM_PROMPT = `You are Master, the master LinkedIn content GPT template. This GPT is not the final client-facing version. Its purpose is to be duplicated first, then customised for each new client by adding that client's uploaded files, source material, and retrieval content. Always treat this GPT as the base model that gets copied to create client-specific versions.

Once client materials are available, your job is to create high-performing LinkedIn content grounded in those uploaded files and briefing notes. Turn client profiles, brand documents, offer messaging, case studies, tone guides, audience notes, and campaign briefs into LinkedIn content that aims to grow followers, increase dwell time, attract high-quality comments, and create inbound sales opportunities.

Treat uploaded materials as the source of truth for each client. Use retrieval-first behaviour: ground every output in the relevant uploaded files and the current brief before writing. When a client profile, persona guide, or brand document exists, use it to shape tone, positioning, audience language, proof points, and boundaries.

Write in plain English unless the source material clearly calls for a different style. Focus on tangible business outcomes, real commercial stakes, and audience-specific language. Avoid generic filler, vague motivation, and empty thought-leadership phrasing. Every post should feel like it came from a real operator with direct experience, not a template.

Use a modern LinkedIn growth playbook as the operating standard. Optimise for strong dwell time. Default to a minimum of 1,200 characters in the body unless the user asks for a shorter format. Write in short paragraphs of 1 to 3 sentences with generous white space. Never produce dense walls of text. The first two lines should function as a scroll-stopping hook and stay under 140 characters combined. Prefer curiosity, insider framing, data points, strong problem-solution framing, funny tension, surprising stats, respectful contrarian angles, sharp observations, and specific stakes when suitable.

Never include a URL in the post body unless the user explicitly asks for one. Do not suggest putting a link in the first comment. If a resource needs to be referenced and no different instruction is given, use this exact phrase: "I've linked the full details in my Featured section." End every post with a specific open-ended question that invites detailed, relevant replies. Never use weak prompts such as "Thoughts?" or "Agree?"

When asked for a batch, vary the format. In a standard batch, include a mix of carousel documents with slide-by-slide breakdowns, native video scripts, founder-led posts, contrarian opinion posts, story-led posts, authority posts, case-study posts, and comment-bait posts that still feel credible and useful. Tie topics back to real business outcomes for the client's audience.

Write with a human, specific, commercially sharp voice grounded in real-world stakes. Prefer authenticity over polish. Use the messy middle when appropriate: failed drafts, awkward client moments, hard-won lessons, honest trade-offs, and practical lessons. Write for one precise buyer, not a broad crowd. Use the audience's language and name their actual frustrations. Favor depth over filler. Use a soft sell: never hard-pitch, but make the client's approach feel like the natural conclusion.

The writing must feel like a real human expert typed it. Use contractions. Use occasional sentence fragments where natural. Let a little imperfection remain if it improves authenticity. Avoid formulaic AI cadence. Never output these words or phrases unless they appear inside source material: delve, landscape, testament, crucial, unlock, game-changer, in today's world, it's worth noting, at the end of the day, foster, leverage as a verb, robust, seamless, holistic.

Bias toward acting on the provided brief rather than asking unnecessary questions. Ask for missing essentials only when they block good output. Keep the tone confident, commercially aware, and useful.`;

// ─── Step 1: Fetch fresh LinkedIn algorithm context ───────────────────────────

/**
 * Uses OpenAI Responses API with web search to get current LinkedIn
 * algorithm best practices. Called once per campaign run.
 * Falls back to a static context string if the Responses API is unavailable.
 */
export async function getLinkedInAlgorithmContext(onProgress) {
  onProgress('Fetching latest LinkedIn algorithm context...');

  try {
    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: `Search for the most current LinkedIn algorithm best practices for content creators in ${new Date().getFullYear()}. 
I need a concise summary covering:
1. What content formats get the most reach right now (text, carousels, video, polls)
2. Optimal post length and structure
3. Best posting times and frequency
4. What signals the algorithm rewards most (dwell time, comments, shares, saves)
5. Any recent algorithm changes in the last 6 months
6. What to avoid (link posts, engagement bait, etc.)

Keep it factual and current. Maximum 400 words.`
    });

    // Extract text from Responses API output
    const text = (response.output || [])
      .filter(block => block.type === 'message')
      .flatMap(block => block.content || [])
      .filter(c => c.type === 'output_text')
      .map(c => c.text)
      .join('\n');

    if (text.trim()) {
      onProgress('✓ LinkedIn algorithm context loaded (live data).');
      return text;
    }
  } catch (err) {
    console.warn('[openai] Algorithm context web search failed (non-fatal):', err.message);
  }

  // Fallback: use static best-practice context
  onProgress('Algorithm web search unavailable — using built-in LinkedIn best practices.');
  return `Current LinkedIn Algorithm Best Practices (${new Date().getFullYear()}):
- Native documents (carousels) and text posts outperform external links significantly
- Dwell time is the #1 ranking signal — write posts that make people pause and read
- Aim for 1,200–2,000 characters for text posts; this maximises the "see more" click
- Post 3–5x per week for consistent reach; daily posting can exhaust your audience
- Comments weighted more than likes; end every post with a specific, open question
- First 90 minutes after posting are critical — respond to every comment quickly
- Avoid external links in the post body — put them in comments or Featured section
- Carousels: 8–12 slides, strong cover slide with a bold single claim, value on every slide
- Personal stories and specific data points consistently outperform generic advice
- Hashtags: 3–5 maximum, highly relevant, avoid banned or oversaturated tags`;
}

// ─── Step 2: Generate posts ───────────────────────────────────────────────────

/**
 * Generates LinkedIn posts using GPT-4o with the LinkedIn Master system prompt.
 * Returns the same JSON structure as the old claude.js for pipeline compatibility.
 */
export async function generatePosts(client, onProgress, contentDna = null, algorithmContext = null) {
  const dnaSection = contentDna
    ? `\nCLIENT CONTENT DNA (writing style from Supergrow — match this exactly):\n${contentDna}\n`
    : '';

  const algoSection = algorithmContext
    ? `\nCURRENT LINKEDIN ALGORITHM CONTEXT (use this to maximise reach):\n${algorithmContext}\n`
    : '';

  const userPrompt = `CLIENT BRIEF:
Name: ${client.name}
Brand: ${client.brand}
Website: ${client.website || 'Not provided'}
Timezone: ${client.timezone}
Posting Cadence: ${client.cadence}
${dnaSection}${algoSection}
CLIENT RAG DOCUMENT (source of truth — use retrieval-first behaviour):
${client.rag_content}

CRITICAL INSTRUCTIONS — READ BEFORE WRITING A SINGLE WORD:

1. RAG DOCUMENT IS THE BIBLE. Every post topic, angle, proof point, client voice, target audience, pain point, and offer detail MUST come directly from the RAG document above. Do not invent generic LinkedIn content. Do not write about AI, productivity, or LinkedIn best practices unless those topics are explicitly in the RAG document. If the RAG is about a UK SME marketing agency targeting MDs and founders, every post must reflect that world specifically.

2. CLIENT VOICE. Match the tone, vocabulary, and personality described in the RAG exactly. If the client is plain-speaking and anti-jargon, write plain-speaking anti-jargon posts. If they use UK English, use UK English. Read the RAG for banned words and never use them.

3. TARGET AUDIENCE. Write for the specific buyer segment described in the RAG — their job titles, frustrations, goals, and language. Never write for a generic "business professional".

4. NO EMOJIS OR DECORATIVE ICONS. Do not use any emojis, bullet symbols, star symbols, thumbs up, arrows, or any decorative unicode characters anywhere in linkedin_post_text. Plain text only. Use line breaks and white space for structure, never symbols.

5. NO BULLET POINTS WITH SYMBOLS. Use numbered lists (1. 2. 3.) or plain dashes only if absolutely needed. Never use • ✓ → ★ or any icon character.

TASK:
Generate exactly ${POSTS_PER_CAMPAIGN} LinkedIn posts for this client.
Every post must be grounded in the RAG document — topics, angles, and proof points must come from it.
Vary formats — include text posts, at least 2 carousel outlines, and 1 founder-led story.
Each post body must be minimum 1,200 characters.
Optimise every post for the current algorithm context provided.

IMPORTANT — RESPONSE FORMAT:
You must respond with ONLY valid JSON. No preamble, no explanation, no markdown fences.
Use exactly this structure:

{
  "client_profile": {
    "name": "",
    "brand": "",
    "primary_offer": "",
    "target_market": "",
    "tone": "",
    "banned_claims": []
  },
  "research_notes": "Summary of key insights from the RAG document",
  "topic_schedule": [
    {"week": 1, "theme": "", "topics": []}
  ],
  "posts": [
    {
      "id": 1,
      "topic": "Specific topic",
      "angle": "Specific angle/hook approach",
      "buyer_segment": "Who this post targets",
      "cta_type": "Type of call to action",
      "content_pillar": "Authority / Story / Education / Commercial / Engagement",
      "format": "Text Post / Carousel / Video Script",
      "suggested_day": "Tuesday",
      "suggested_time": "08:00",
      "linkedin_post_text": "Full post text here — minimum 1,200 characters, short paragraphs, white space, scroll-stopping hook in first 2 lines",
      "image_prompt": "A professional LinkedIn image for: [describe specific visual that matches post content, photorealistic business style, no text in image]"
    }
  ]
}`;

  onProgress(`Sending to GPT-4o — generating ${POSTS_PER_CAMPAIGN} posts...`);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_completion_tokens: 16000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: LINKEDIN_MASTER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ]
  });

  const text = completion.choices[0].message.content;
  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error(`GPT-4o did not return valid JSON: ${text.slice(0, 200)}`);
  }

  if (!result.posts || result.posts.length === 0) {
    throw new Error('GPT-4o returned no posts');
  }

  onProgress(`✓ GPT-4o generated ${result.posts.length} posts.`);
  return result;
}

// ─── Regenerate a single post (operator requested rewrite) ───────────────────

/**
 * Rewrites one post from scratch using the full LinkedIn Master prompt.
 * Keeps topic/angle/format/pillar but generates entirely new text + image_prompt.
 * Used when the operator clicks "Regenerate Post" on a card.
 */
export async function regenerateSinglePost(post, client, contentDna = null) {
  const dnaNote = contentDna
    ? `\nContent DNA (match this writing style exactly):\n${contentDna}\n`
    : '';

  const prompt = `You are rewriting a single LinkedIn post for a client. The operator was not happy with the original text and has requested a fresh rewrite.

CLIENT:
Name: ${client.name}
Brand: ${client.brand}
${dnaNote}
CLIENT RAG SUMMARY:
${(client.rag_content || '').slice(0, 3000)}

POST BRIEF (keep the same strategic intent — rewrite the text):
Topic: ${post.topic}
Angle: ${post.angle}
Buyer segment: ${post.buyer_segment}
CTA type: ${post.cta_type}
Content pillar: ${post.content_pillar}
Format: ${post.format || 'Text Post'}
Suggested day: ${post.suggested_day || 'Any'}
Suggested time: ${post.suggested_time || 'Any'}

RULES:
- Minimum 1,200 characters in the post body
- First 2 lines = scroll-stopping hook, under 140 chars combined
- Short paragraphs, generous white space
- End with a specific open-ended question — never "Thoughts?"
- No external URLs in the post body
- No banned words: delve, landscape, testament, crucial, unlock, game-changer
- Make it feel like a real human expert typed it
- NO emojis, NO decorative icons, NO bullet symbols (no •, ✓, →, ★, thumbs up, or any unicode decoration)
- Plain text only — use line breaks and white space for structure

Respond ONLY with valid JSON, no preamble, no markdown fences:
{
  "linkedin_post_text": "...",
  "image_prompt": "A professional LinkedIn image for: [describe specific visual]"
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_completion_tokens: 2500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: LINKEDIN_MASTER_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]
  });

  const text = completion.choices[0].message.content;
  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error(`GPT-4o did not return valid JSON for single post: ${text.slice(0, 200)}`);
  }

  if (!result.linkedin_post_text) throw new Error('GPT-4o returned no post text');
  return result;
}

// ─── Rewrite a post that scored below 70/100 ─────────────────────────────────

/**
 * Asks GPT-4o to rewrite a single post using the Supergrow score feedback.
 * Returns the improved post text only.
 */
export async function fixPost(post, scoreFeedback, suggestions = [], contentDna = null) {
  const dnaNote = contentDna
    ? `\nContent DNA (match this writing style):\n${contentDna}\n`
    : '';

  const suggestionsNote = suggestions.length > 0
    ? `\nSpecific suggestions to action:\n${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  const prompt = `You are improving a LinkedIn post that scored below 70/100 on the Supergrow quality scorer.

Original post:
${post.linkedin_post_text}

Score feedback:
${scoreFeedback}
${suggestionsNote}${dnaNote}
Post context:
- Topic: ${post.topic}
- Angle: ${post.angle}
- Target buyer: ${post.buyer_segment}
- CTA type: ${post.cta_type}
- Format: ${post.format || 'Text Post'}

Rewrite the post to score 70 or above out of 100. Fix all issues raised in the feedback and action every suggestion.
Keep the same topic, angle, and CTA intent. Minimum 1,200 characters. Short paragraphs with white space.
Return ONLY the improved post text — no preamble, no explanation, no JSON.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_completion_tokens: 2000,
    messages: [
      { role: 'system', content: LINKEDIN_MASTER_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]
  });

  return completion.choices[0].message.content.trim();
}
