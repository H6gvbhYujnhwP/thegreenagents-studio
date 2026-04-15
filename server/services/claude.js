import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const systemPrompt = `You are running the THEGREENAGENTS.COM client social deployment workflow.
Your job is to take the client RAG document and convert it into a complete, execution-ready LinkedIn campaign.
Treat the client RAG document as the highest-priority source of truth.
Your output must be designed for real deployment, not idea generation only.`;

// ─── Improvement 2: generatePosts now accepts optional contentDna ────────────

export async function generatePosts(client, onProgress, contentDna = null) {
  const dnaSection = contentDna
    ? `\nCONTENT DNA (writing style, tone, audience — match this exactly):\n${contentDna}\n`
    : '';

  const userPrompt = `CLIENT PROFILE:
Name: ${client.name}
Brand: ${client.brand}
Website: ${client.website || 'Not provided'}
Timezone: ${client.timezone}
Posting Cadence: ${client.cadence}
${dnaSection}
CLIENT RAG DOCUMENT:
${client.rag_content}

Follow this workflow:
1. Read and normalize the client RAG document. Extract voice, audience, offer, proof points, tone, banned words/claims.
2. Build the client operating profile as a canonical source of truth.
3. Add current platform and sector context relevant to this client.
4. Create a topic and deployment plan - commercially useful content matrix spanning 8 weeks.
5. Generate exactly 3 LinkedIn posts in the client voice, optimized for enquiries, written for real buyers.${contentDna ? ' Match the Content DNA writing style precisely.' : ''}
   Each post must be substantive (100-250 words), use line breaks for readability, and end with a clear CTA relevant to this client.
   Vary formats across the 3 posts: e.g. a story, a list, and an insight.
6. Validate all posts — remove weak, generic, or off-brand copy.

Return ONLY valid JSON in this exact structure, no other text:
{
  "client_profile": {
    "name": "",
    "brand": "",
    "primary_offer": "",
    "target_market": "",
    "tone": "",
    "banned_claims": []
  },
  "research_notes": "",
  "topic_schedule": [
    {"week": 1, "theme": "", "topics": []}
  ],
  "posts": [
    {
      "id": 1,
      "topic": "",
      "angle": "",
      "buyer_segment": "",
      "cta_type": "",
      "linkedin_post_text": "",
      "image_prompt": "A professional LinkedIn image for: [describe specific visual that matches post content, photorealistic business style, no text in image]"
    }
  ]
}

Generate all 3 posts. Each post needs a unique image_prompt that visually represents the post content.`;

  onProgress('Sending to Claude API (generating 3 posts for smoke test)...');

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 32000,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt
  });

  const text = message.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON');

  const result = JSON.parse(jsonMatch[0]);
  if (!result.posts || result.posts.length === 0) throw new Error('No posts generated');

  onProgress(`Claude generated ${result.posts.length} posts successfully.`);
  return result;
}

// ─── Improvement 4: fixPost — rewrite a post that scored below 7 ─────────────

/**
 * Asks Claude to rewrite a single post using the score feedback.
 * Returns the new post text.
 */
export async function fixPost(post, scoreFeedback, suggestions = [], contentDna = null) {
  const dnaNote = contentDna
    ? `\nContent DNA (match this writing style):\n${contentDna}\n`
    : '';

  const suggestionsNote = suggestions.length > 0
    ? `\nSpecific suggestions to action:\n${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  const prompt = `You are improving a LinkedIn post that scored below 70/100.

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

Rewrite the post to score 70 or above out of 100. Fix all issues raised in the feedback and action every suggestion.
Keep the same topic, angle, and CTA intent. Stay 100-250 words. Use line breaks for readability.
Return ONLY the improved post text — no preamble, no explanation, no JSON.`;

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
    system: systemPrompt
  });

  return message.content[0].text.trim();
}
