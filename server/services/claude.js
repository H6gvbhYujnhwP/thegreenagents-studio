import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function generatePosts(client, onProgress) {
  const systemPrompt = `You are running the THEGREENAGENTS.COM client social deployment workflow.
Your job is to take the client RAG document and convert it into a complete, execution-ready LinkedIn campaign.
Treat the client RAG document as the highest-priority source of truth.
Your output must be designed for real deployment, not idea generation only.`;

  const userPrompt = `CLIENT PROFILE:
Name: ${client.name}
Brand: ${client.brand}
Website: ${client.website || 'Not provided'}
Timezone: ${client.timezone}
Posting Cadence: ${client.cadence}

CLIENT RAG DOCUMENT:
${client.rag_content}

Follow this workflow:
1. Read and normalize the client RAG document. Extract voice, audience, offer, proof points, tone, banned words/claims.
2. Build the client operating profile as a canonical source of truth.
3. Add current platform and sector context relevant to this client.
4. Create a topic and deployment plan - commercially useful content matrix.
5. Generate exactly 3 LinkedIn posts in the client voice, optimized for enquiries, written for real buyers. Each post must be substantive (100-250 words), use line breaks for readability, and end with a clear CTA relevant to this client.
6. Validate all posts - remove weak, generic, or off-brand copy.

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

  onProgress('Sending to Claude API...');

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

  return result;
}
