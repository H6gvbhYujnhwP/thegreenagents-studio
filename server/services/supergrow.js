import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function queuePost({ workspaceId, apiKey, postText, imageUrls = [] }) {
  const mcpUrl = `https://mcp.supergrow.ai/mcp?api_key=${apiKey}`;

  const client = new Client({ name: 'greenagents-studio', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  await client.connect(transport);

  const args = {
    workspace_id: workspaceId,
    content: postText,
    ...(imageUrls.length > 0 && { image_urls: imageUrls })
  };

  const result = await client.callTool({ name: 'queue_post', arguments: args });
  await client.close();

  return result;
}

export async function createDraft({ workspaceId, apiKey, postText, imageUrls = [] }) {
  const mcpUrl = `https://mcp.supergrow.ai/mcp?api_key=${apiKey}`;

  const client = new Client({ name: 'greenagents-studio', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  await client.connect(transport);

  const args = {
    workspace_id: workspaceId,
    content: postText,
    ...(imageUrls.length > 0 && { image_urls: imageUrls })
  };

  const result = await client.callTool({ name: 'create_post', arguments: args });
  await client.close();

  return result;
}
