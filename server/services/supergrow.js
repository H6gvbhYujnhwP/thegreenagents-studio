import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ─── helpers ───────────────────────────────────────────────────────────────

function makeMcpClient(apiKey) {
  const mcpUrl = `https://mcp.supergrow.ai/mcp?api_key=${apiKey}`;
  const client = new Client(
    { name: 'greenagents-studio', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  return { client, transport };
}

/** Pull plain text out of an MCP tool result */
function extractText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  const block = result.content.find(b => b.type === 'text');
  return block ? block.text : '';
}

/** Try to parse JSON from MCP text; fall back to raw string */
function parseMcpJson(text) {
  const match = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (match) {
    try { return JSON.parse(match[1]); } catch (_) {}
  }
  return text;
}

/** Extract a numeric score (0-10) from score_post response text */
function extractScore(text) {
  const patterns = [
    /overall\s+score[:\s]+(\d+(?:\.\d+)?)/i,
    /"score"\s*:\s*(\d+(?:\.\d+)?)/i,
    /score[:\s]+(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*\/\s*10/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseFloat(m[1]);
      if (!isNaN(n)) return n;
    }
  }
  const nums = text.match(/\b(\d+(?:\.\d+)?)\b/g);
  if (nums) {
    for (const n of nums) {
      const v = parseFloat(n);
      if (v >= 0 && v <= 10) return v;
    }
  }
  return null;
}

// ─── Improvement 1: list_workspaces ────────────────────────────────────────

/**
 * Fetch all workspaces for a given Supergrow API key.
 * Returns an array of { id, name, language, ... } objects.
 */
export async function listWorkspaces(apiKey) {
  const { client, transport } = makeMcpClient(apiKey);
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'list_workspaces', arguments: {} });
    const text = extractText(result);
    const parsed = parseMcpJson(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.workspaces)) return parsed.workspaces;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    return [];
  } finally {
    await client.close();
  }
}

// ─── Improvement 2: get_content_dna ────────────────────────────────────────

/**
 * Fetch the Content DNA for a workspace.
 * Returns the raw text/JSON string — passed verbatim into the Claude prompt.
 */
export async function getContentDna(workspaceId, apiKey) {
  const { client, transport } = makeMcpClient(apiKey);
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'get_content_dna',
      arguments: { workspace_id: workspaceId }
    });
    return extractText(result);
  } finally {
    await client.close();
  }
}

// ─── Improvement 3: get_company_pages ──────────────────────────────────────

/**
 * Fetch connected LinkedIn company pages for a workspace.
 * Returns the first page's linked_in_company_page_id, or null if none found.
 */
export async function getCompanyPageId(workspaceId, apiKey) {
  const { client, transport } = makeMcpClient(apiKey);
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'get_company_pages',
      arguments: { workspace_id: workspaceId }
    });
    const text = extractText(result);
    const parsed = parseMcpJson(text);

    let pages = [];
    if (Array.isArray(parsed)) pages = parsed;
    else if (parsed && Array.isArray(parsed.pages)) pages = parsed.pages;
    else if (parsed && Array.isArray(parsed.data)) pages = parsed.data;
    else if (parsed && Array.isArray(parsed.company_pages)) pages = parsed.company_pages;

    if (pages.length === 0) return null;

    const page = pages[0];
    return page.linked_in_company_page_id
      || page.linkedInCompanyPageId
      || page.company_page_id
      || page.id
      || null;
  } finally {
    await client.close();
  }
}

// ─── Improvement 4: score_post ─────────────────────────────────────────────

/**
 * Score a post via Supergrow's score_post tool.
 * Returns { score: number|null, feedback: string, raw: string }
 */
export async function scorePost(workspaceId, postText, apiKey) {
  const { client, transport } = makeMcpClient(apiKey);
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'score_post',
      arguments: {
        workspace_id: workspaceId,
        text: postText
      }
    });
    const raw = extractText(result);
    const score = extractScore(raw);
    return { score, feedback: raw, raw };
  } finally {
    await client.close();
  }
}

// ─── Post-publishing functions (updated with optional companyPageId) ────────

export async function queuePost({ workspaceId, apiKey, postText, imageUrls = [], companyPageId = null }) {
  const { client, transport } = makeMcpClient(apiKey);
  await client.connect(transport);

  const args = {
    workspace_id: workspaceId,
    content: postText,
    ...(imageUrls.length > 0 && { image_urls: imageUrls }),
    ...(companyPageId && { linked_in_company_page_id: companyPageId })
  };

  const result = await client.callTool({ name: 'queue_post', arguments: args });
  await client.close();
  return result;
}

export async function createDraft({ workspaceId, apiKey, postText, imageUrls = [], companyPageId = null }) {
  const { client, transport } = makeMcpClient(apiKey);
  await client.connect(transport);

  const args = {
    workspace_id: workspaceId,
    content: postText,
    ...(imageUrls.length > 0 && { image_urls: imageUrls }),
    ...(companyPageId && { linked_in_company_page_id: companyPageId })
  };

  const result = await client.callTool({ name: 'create_post', arguments: args });
  await client.close();
  return result;
}
