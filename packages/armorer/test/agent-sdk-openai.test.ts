import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { MCPServerStdio, MCPServerStreamableHttp } from '@openai/agents';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { createMCP } from '../src/integrations/mcp';

const fixturePath = () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, 'fixtures', 'toolbox-mcp-server.ts');
};

describe('OpenAI Agents SDK MCP integration', () => {
  it('lists tools over stdio', async () => {
    const server = new MCPServerStdio({
      command: 'bun',
      args: [fixturePath()],
      name: 'toolbox-tools',
      cacheToolsList: true,
    });

    try {
      await server.connect();
      const tools = await server.listTools();
      expect(tools.some((tool) => tool.name === 'sum')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('lists tools over streamable HTTP', async () => {
    const sum = createTool({
      name: 'sum',
      description: 'adds two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      async execute({ a, b }) {
        return a + b;
      },
    });
    const toolbox = createToolbox([sum]);

    const mcp = createMCP(toolbox, {
      serverInfo: { name: 'toolbox-tools', version: '0.1.0' },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await mcp.connect(transport);

    const server = new MCPServerStreamableHttp({
      url: 'http://toolbox.local/mcp',
      name: 'toolbox-tools',
      cacheToolsList: true,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return transport.handleRequest(request);
      },
    });

    try {
      await server.connect();
      const tools = await server.listTools();
      expect(tools.some((tool) => tool.name === 'sum')).toBe(true);
    } finally {
      await server.close();
      await mcp.close();
    }
  });
});
