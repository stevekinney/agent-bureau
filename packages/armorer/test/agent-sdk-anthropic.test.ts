import type { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { createMCP } from '../src/integrations/mcp';

type McpSdkServerConfigurationWithInstance = ReturnType<typeof createSdkMcpServer>;

describe('Anthropic Agent SDK MCP integration', () => {
  it('lists and executes tools through an in-process MCP server instance', async () => {
    const toolbox = createToolbox();
    createTool(
      {
        name: 'sum',
        description: 'adds two numbers',
        input: z.object({ a: z.number(), b: z.number() }),
        async execute({ a, b }) {
          return a + b;
        },
      },
      toolbox,
    );

    const mcp = await createMCP(toolbox, {
      serverInfo: { name: 'toolbox-tools', version: '0.1.0' },
    });

    const configuration = {
      type: 'sdk',
      name: 'toolbox-tools',
      instance: mcp,
    } satisfies McpSdkServerConfigurationWithInstance;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'anthropic-agent-sdk-test', version: '0.0.0' });
    await configuration.instance.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      const result = await client.callTool({ name: 'sum', arguments: { a: 2, b: 3 } });

      expect(tools.tools.some((tool) => tool.name === 'sum')).toBe(true);
      expect(result.content?.[0]?.text).toContain('5');
    } finally {
      await client.close();
      await configuration.instance.close();
    }
  });
});
