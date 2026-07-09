import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { MCPServerStdio, MCPServerStreamableHttp } from '@openai/agents';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { createMCP } from '../src/integrations/mcp';

const sourceFixtureCode = () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const createToolModule = pathToFileURL(join(currentDir, '..', 'src', 'create-tool.ts')).href;
  const createToolboxModule = pathToFileURL(
    join(currentDir, '..', 'src', 'create-toolbox.ts'),
  ).href;
  const mcpModule = pathToFileURL(
    join(currentDir, '..', 'src', 'integrations', 'mcp', 'index.ts'),
  ).href;
  return `
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { z } from 'zod';
    import { createTool } from ${JSON.stringify(createToolModule)};
    import { createToolbox } from ${JSON.stringify(createToolboxModule)};
    import { createMCP } from ${JSON.stringify(mcpModule)};

    const sum = createTool({
      name: 'sum',
      description: 'adds two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      async execute({ a, b }) {
        return a + b;
      },
    });

    const toolbox = createToolbox([sum]);
    const mcp = await createMCP(toolbox, {
      serverInfo: { name: 'toolbox-tools', version: '0.1.0' },
    });
    await mcp.connect(new StdioServerTransport());
    await new Promise(() => {});
  `;
};

const packagePath = () => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, '..');
};

describe('OpenAI Agents SDK MCP integration', () => {
  it('lists tools over stdio', async () => {
    const server = new MCPServerStdio({
      command: 'bun',
      args: ['--eval', sourceFixtureCode()],
      cwd: packagePath(),
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

    const mcp = await createMCP(toolbox, {
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
