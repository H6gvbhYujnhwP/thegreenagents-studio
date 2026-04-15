/**
 * supergrow.js — Supergrow MCP service
 *
 * AUTH: API key is passed as a URL query param — no username/password session
 * required. URL: https://mcp.supergrow.ai/mcp?api_key=YOUR_KEY
 * Each client has their own key stored in clients.supergrow_api_key.
 *
 * TRANSPORT: Supergrow's server may use either:
 *   - StreamableHTTPClientTransport (modern, POST+GET SSE)
 *   - SSEClientTransport (legacy, GET /sse + POST /messages)
 * This module tries Streamable HTTP first, falls back to SSE automatically,
 * and caches the working transport per API key to avoid re-probing on every call.
 *
 * SESSION ISOLATION: A fresh Client+Transport is created per call — the SDK
 * does not support reuse across concurrent async calls reliably.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// ─── Transport type cache ─────────────────────────────────────────────────────
// Maps apiKey → 'streamable' | 'sse'
// Avoids re-probing on every call once we know which transport works.
const transportCache = new Map();

// ─── Core connection helpers ──────────────────────────────────────────────────

function buildMcpUrl(apiKey) {
  return `https://mcp.supergrow.ai/mcp?api_key=${apiKey}`;
}

/** Reject a promise after ms milliseconds with a clear label. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Supergrow MCP timeout (${ms}ms): ${label}`)),
      ms
    );
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

/** Create and connect a fresh MCP client using the specified transport type. */
async function createAndConnect(url, type) {
  const client = new Client(
    { name: 'greenagents-studio', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = type === 'streamable'
    ? new StreamableHTTPClientTransport(new URL(url))
    : new SSEClientTransport(new URL(url));

  await withTimeout(client.connect(transport), 15000, 'connect');
  return { client, transport };
}

/**
 * Connect, trying Streamable HTTP first then falling back to legacy SSE.
 * Caches the successful transport type per API key.
 */
async function connectClient(apiKey) {
  const url = buildMcpUrl(apiKey);
  const cached = transportCache.get(apiKey);

  if (cached) {
    return createAndConnect(url, cached);
  }

  try {
    const conn = await createAndConnect(url, 'streamable');
    transportCache.set(apiKey, 'streamable');
    return conn;
  } catch (err) {
    console.warn(`[supergrow] StreamableHTTP failed (${err.message}) — trying SSE fallback`);
    const conn = await createAndConnect(url, 'sse');
    transportCache.set(apiKey, 'sse');
    return conn;
  }
}

/**
 * Connect, call one MCP tool, disconnect.
 * Clears transport cache on any failure so next call re-probes cleanly.
 */
async function callSupergrowTool(apiKey, toolName, toolArgs = {}) {
  let client;
  try {
    const conn = await connectClient(apiKey);
    client = conn.client;

    const result = await withTimeout(
      client.callTool({ name: toolName, arguments: toolArgs }),
      20000,
      toolName
    );
    return result;

  } catch (err) {
    // Clear cache so the next call re-probes — avoids getting stuck after transient failures
    transportCache.delete(apiKey);

    if (err.message?.includes('401') || err.message?.includes('Unauthorized')) {
      throw new Error(`Supergrow auth failed — check the API key for this client. (${err.message})`);
    }
    throw err;

  } finally {
    try { await client?.close(); } catch (_) {}
  }
}

// ─── Response parsing helpers ─────────────────────────────────────────────────

/** Pull plain text out of an MCP tool result (handles both string and array content) */
function extractText(result) {
  if (!result) return '';
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    const block = result.content.find(b => b.type === 'text');
    return block?.text ?? '';
  }
  return '';
}

/**
 * Try to parse JSON from MCP response text.
 * Strips markdown code fences before parsing. Falls back to raw string.
 */
function parseMcpJson(text) {
  if (!text) return null;
  // Strip ```json ... ``` fences that some MCP servers emit
  const clean = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
  try {
    return JSON.parse(clean);
  } catch (_) {
    const match = clean.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (match) {
      try { return JSON.parse(match[1]); } catch (_2) {}
    }
  }
  return text;
}

/** Extract a numeric score (0-100) from score_post response.
 *  Supergrow scores out of 100 — e.g. { "score": 72, "feedback": "...", "suggestions": [...] }
 */
function extractScore(text) {
  if (!text) return null;
  // Try JSON parse first — the real response is a JSON object
  try {
    const obj = JSON.parse(text);
    if (typeof obj.score === 'number') return obj.score;
  } catch (_) {}
  // Fallback: regex patterns for score out of 100
  const patterns = [
    /"overall_score"\s*:\s*(\d+(?:\.\d+)?)/i,
    /"score"\s*:\s*(\d+(?:\.\d+)?)/i,
    /overall\s+score[:\s]+(\d+(?:\.\d+)?)/i,
    /score[:\s]+(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*\/\s*100/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n >= 0 && n <= 100) return n;
    }
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List all workspaces for a given Supergrow API key.
 * Returns an array of { id, name, language, ... } objects.
 */
export async function listWorkspaces(apiKey) {
  const result = await callSupergrowTool(apiKey, 'list_workspaces', {});
  const text = extractText(result);
  const parsed = parseMcpJson(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed?.workspaces && Array.isArray(parsed.workspaces)) return parsed.workspaces;
  if (parsed?.data && Array.isArray(parsed.data)) return parsed.data;
  console.warn('[supergrow] list_workspaces: unexpected response shape', text?.slice(0, 200));
  return [];
}

/**
 * Fetch the Content DNA for a workspace.
 * Returns the raw text/JSON string — passed verbatim into the Claude prompt.
 */
export async function getContentDna(workspaceId, apiKey) {
  const result = await callSupergrowTool(apiKey, 'get_content_dna', {
    workspace_id: workspaceId
  });
  return extractText(result);
}

/**
 * Fetch connected LinkedIn company pages for a workspace.
 * Returns the first page's linked_in_company_page_id, or null if none found.
 */
export async function getCompanyPageId(workspaceId, apiKey) {
  const result = await callSupergrowTool(apiKey, 'get_company_pages', {
    workspace_id: workspaceId
  });
  const text = extractText(result);
  const parsed = parseMcpJson(text);

  let pages = [];
  if (Array.isArray(parsed)) pages = parsed;
  else if (parsed?.pages && Array.isArray(parsed.pages)) pages = parsed.pages;
  else if (parsed?.data && Array.isArray(parsed.data)) pages = parsed.data;
  else if (parsed?.company_pages && Array.isArray(parsed.company_pages)) pages = parsed.company_pages;

  if (!pages.length) return null;
  const page = pages[0];
  return (
    page.linked_in_company_page_id ??
    page.linkedInCompanyPageId ??
    page.company_page_id ??
    page.id ??
    null
  );
}

/**
 * Score a post via Supergrow's score_post tool.
 * Scores are 0-100. Quality gate threshold is 70.
 * Returns { score: number|null, feedback: string, suggestions: string[], raw: string }
 */
export async function scorePost(workspaceId, postText, apiKey) {
  const result = await callSupergrowTool(apiKey, 'score_post', {
    workspace_id: workspaceId,
    text: postText
  });
  const raw = extractText(result);
  const parsed = parseMcpJson(raw);
  const score = (parsed && typeof parsed.score === 'number') ? parsed.score : extractScore(raw);
  const feedback = (parsed && parsed.feedback) ? parsed.feedback : raw;
  const suggestions = (parsed && Array.isArray(parsed.suggestions)) ? parsed.suggestions : [];
  return { score, feedback, suggestions, raw };
}

/**
 * Queue a post for LinkedIn publishing (approval_mode = "auto").
 * Required: workspaceId, apiKey, postText
 * Optional: imageUrls[], companyPageId
 */
export async function queuePost({ workspaceId, apiKey, postText, imageUrls = [], companyPageId = null }) {
  const args = {
    workspace_id: workspaceId,
    text: postText,                    // Supergrow schema: 'text' not 'content'
    ...(imageUrls.length > 0 && { image_urls: imageUrls }),
    ...(companyPageId && { linked_in_company_page_id: companyPageId })
  };
  return callSupergrowTool(apiKey, 'queue_post', args);
}

/**
 * Create a draft post without publishing (approval_mode = "draft").
 * Same arguments as queuePost.
 */
export async function createDraft({ workspaceId, apiKey, postText, imageUrls = [], companyPageId = null }) {
  const args = {
    workspace_id: workspaceId,
    text: postText,                    // Supergrow schema: 'text' not 'content'
    ...(imageUrls.length > 0 && { image_urls: imageUrls }),
    ...(companyPageId && { linked_in_company_page_id: companyPageId })
  };
  return callSupergrowTool(apiKey, 'create_post', args);
}

/**
 * List all tools exposed by the Supergrow MCP server for this API key.
 * Call this once in development to see real tool names and argument schemas.
 * Usage: node -e "import('./server/services/supergrow.js').then(m => m.listTools('YOUR_KEY').then(console.log))"
 */
export async function listTools(apiKey) {
  const { client } = await connectClient(apiKey);
  try {
    const result = await withTimeout(client.listTools(), 15000, 'listTools');
    return result.tools;
  } finally {
    try { await client.close(); } catch (_) {}
  }
}
