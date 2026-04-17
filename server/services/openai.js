/**
 * openai.js — Post generation using GPT-4o
 *
 * Uses the Master LinkedIn Content Strategist system prompt.
 * Retrieval-first, client-agnostic — every post grounded in client RAG.
 */

import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_AI_KEY
});

const POSTS_PER_CAMPAIGN = 12;

const LINKEDIN_MASTER_SYSTEM_PROMPT = `You are a LinkedIn Content Agent.

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
2. Run a fresh live research check before writing any posts, unless the user explicitly says not to browse.
3. Output a short section titled "Research Summary".
4. Create the requested posts.
5. Silently run a quality check before finalising.

Do not skip research.
Do not create posts first and research later.

RETRIEVAL-FIRST RULE

The client RAG file is the main source of truth.

Use the RAG file and uploaded materials to determine:
- offers
- audience
- USP
- proof
- objections
- brand voice
- safe claims
- risky claims
- terminology
- content goals
- content boundaries

If the RAG file and source materials answer a question, follow them.
Do not replace client truth with generic best practice.

VOICE RULE

Write in the client's voice, not your own.

Match:
- tone
- vocabulary
- level of polish
- humour level
- directness
- founder/operator/expert style
- phrases they naturally use
- phrases they avoid

Do not sound like a generic LinkedIn ghostwriter.
Do not sound corporate.
Do not sound like polished AI.

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

Write for the client's buyers, not their peers, unless the brief says otherwise.

Default rules:
- use short paragraphs
- avoid walls of text
- keep the first 2 lines strong
- hook must earn attention
- no filler
- no motivational fluff
- no generic thought leadership
- no hard sell
- no external links unless explicitly requested
- never default to "link in first comment"
- end with a specific open-ended question

FORMATTING RULES — ABSOLUTE AND NON-NEGOTIABLE

NO EMOJIS. Zero emojis anywhere in any post text. Not one. No thumbs up, no stars, no arrows, no check marks, no hearts, nothing. No exceptions.

NO DECORATIVE SYMBOLS. No bullet symbols, checkmarks, right arrows, star symbols, diamond symbols, or any unicode decoration character. Plain text only. No exceptions.

PARAGRAPH SPACING IS MANDATORY. Every paragraph must be separated by a blank line. Short paragraphs of 1 to 3 sentences only. Never write a wall of text.

CAROUSEL POST RULE. For carousel format posts, linkedin_post_text is the post caption only — the short hook that appears above the document on LinkedIn (200 to 400 characters). Do NOT put slide content inside linkedin_post_text. Slide content goes exclusively in the carousel_slides field.

FORMAT MIX RULE

For a batch of 5 posts, default to:
- 2 Carousel / Document posts
- 2 Text posts
- 1 Text post or Native Video Script depending on fit

Rotate content types:
- contrarian take
- buyer pain
- myth-busting
- story / war story
- case study
- proof-led insight
- framework / checklist
- behind the scenes
- trend interpretation
- objection handling

SAFE WRITING RULES

Do not invent stats, case studies, results, testimonials, customer names, timelines, guarantees, or category claims.
Do not overclaim.
Respect compliance limits, naming restrictions, and client-specific banned phrases.

BANNED WORDS

Never use: delve, landscape, testament, crucial, unlock, game-changer, in today's world, it's worth noting, at the end of the day, foster, leverage as a verb, robust, seamless, holistic.

Also avoid any client-specific banned phrases found in their RAG document.

QUALITY CHECK BEFORE FINALISING

Before sending, silently check:
- grounded in RAG and source materials
- sounds like this client
- hook is sharp in the first 2 lines (under 140 characters combined)
- no emojis, no decorative symbols
- every paragraph separated by a blank line
- format choice fits the idea
- no unsupported claims
- ending question is specific and invites qualified replies
- soft sell, not hard sell
- varied enough across the batch
- could this post only have come from this specific client? If no, rewrite it.`;

export async function getLinkedInAlgorithmContext(onProgress) {
  onProgress('Fetching latest LinkedIn algorithm context...');

  try {
    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: `Search for the most current LinkedIn algorithm best practices and content performance data for ${new Date().getFullYear()}.
Provide a concise factual summary covering:
1. Which content formats perform best right now and why (text posts, carousels/documents, video, polls)
2. What signals LinkedIn rewards most (dwell time, comments, shares, saves, early engagement)
3. What to avoid (link posts in body, engagement bait, obvious AI-pattern content)
4. Any recent observations from practitioners in the last 60 days
5. Optimal post structure and length
Maximum 400 words. Note where evidence is strong vs directional.`
    });

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

  onProgress('Algorithm web search unavailable — using built-in LinkedIn best practices.');
  return `Current LinkedIn Platform Signals (${new Date().getFullYear()}):
- Native document posts (carousels) consistently lead engagement benchmarks
- Dwell time is the primary feed ranking signal — posts that make people pause and read perform best
- Text posts: 1,200-2,000 characters maximises see-more clicks and dwell time
- Comments are weighted more heavily than likes — end every post with a specific question
- External links in post body significantly reduce reach — use Featured section reference instead
- First 90 minutes after posting are critical for early engagement signals
- Personal story-led content and specific data points outperform generic advice
- AI-pattern writing (symmetrical lists, corporate cadence) is flagged as low quality
- Avoid engagement bait — LinkedIn reduces reach on posts asking people to like/tag/share without substance
- Posting 3-5x per week is more effective than daily posting for sustained reach`;
}

export async function generatePosts(client, onProgress, contentDna = null, algorithmContext = null) {
  const dnaSection = contentDna
    ? `\nCLIENT CONTENT DNA (writing style from Supergrow — match this voice exactly):\n${contentDna}\n`
    : '';

  const algoSection = algorithmContext
    ? `\nCURRENT LINKEDIN PLATFORM SIGNALS (use to maximise reach):\n${algorithmContext}\n`
    : '';

  const userPrompt = `CLIENT BRIEF:
Name: ${client.name}
Brand: ${client.brand}
Website: ${client.website || 'Not provided'}
Timezone: ${client.timezone}
Posting Cadence: ${client.cadence}
${dnaSection}${algoSection}
CLIENT RAG DOCUMENT — THE ONLY SOURCE OF TRUTH FOR THIS CAMPAIGN:
${client.rag_content}

EXECUTION INSTRUCTIONS:

Before writing anything, complete the 5-step internal workflow:
1. Extract what this business sells, who it sells to, their proof, their voice, their audience language
2. Distil the positioning into a single internal summary
3. Build the message hierarchy for the batch
4. Apply the risk filter — reject anything generic
5. Final check: could each post ONLY come from this client?

TASK:
Generate exactly ${POSTS_PER_CAMPAIGN} LinkedIn posts for this client.

Every topic, angle, proof point, and voice detail MUST come from the RAG document above.
Do not write about topics not present in the RAG.
Vary formats — include text posts, at least 2 carousels, and 1 founder-led story.
Separate every paragraph with a blank line. No emojis. No decorative symbols.
Text post bodies must be minimum 1,200 characters.
For carousel posts: linkedin_post_text is the caption hook only (200-400 characters). Slide content goes in carousel_slides.

RESPONSE FORMAT:
Respond with ONLY valid JSON. No preamble, no explanation, no markdown fences.

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
      "linkedin_post_text": "Post body with blank line between every paragraph. No emojis. No symbols. 1200+ chars for text posts. Caption only for carousels.",
      "carousel_slides": null,
      "image_prompt": "Specific visual description — photorealistic, relevant to this client world, no text overlays"
    }
  ]
}

For carousel posts, carousel_slides must be an array:
[{"slide": 1, "title": "...", "body": "..."}, {"slide": 2, "title": "...", "body": "..."}]
For text posts and video scripts, carousel_slides must be null.`;

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

export async function regenerateSinglePost(post, client, contentDna = null) {
  const dnaNote = contentDna
    ? `\nContent DNA (match this writing style exactly):\n${contentDna}\n`
    : '';

  const prompt = `Rewrite this LinkedIn post. The operator requested a fresh version.

CLIENT RAG — ground the rewrite entirely in this material:
${(client.rag_content || '').slice(0, 4000)}
${dnaNote}
POST BRIEF (keep the same strategic intent, rewrite the text):
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
- NO emojis, NO decorative symbols, NO bullet icons — plain text only
- Final check: could this only come from this specific client?

Respond ONLY with valid JSON, no preamble, no markdown fences:
{
  "linkedin_post_text": "...",
  "carousel_slides": null,
  "image_prompt": "..."
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

export async function fixPost(post, scoreFeedback, suggestions = [], contentDna = null) {
  const dnaNote = contentDna ? `\nContent DNA:\n${contentDna}\n` : '';
  const suggestionsNote = suggestions.length > 0
    ? `\nSpecific suggestions to action:\n${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  const prompt = `Improve this LinkedIn post that scored below 70/100 on the quality scorer.

Original post:
${post.linkedin_post_text}

Score feedback:
${scoreFeedback}
${suggestionsNote}${dnaNote}
Post context — Topic: ${post.topic} | Audience: ${post.buyer_segment} | Format: ${post.format || 'Text Post'}

Rewrite the post to score 70 or above. Fix all issues raised in the feedback.
Keep the same topic, angle, and CTA intent.
Minimum 1,200 characters. Blank lines between paragraphs. No emojis or symbols.
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
