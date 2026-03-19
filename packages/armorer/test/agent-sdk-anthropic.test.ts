import { type createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { createMCP } from '../src/mcp';

type McpSdkServerConfigurationWithInstance = ReturnType<typeof createSdkMcpServer>;

describe('Anthropic Agent SDK MCP integration', () => {
  it('accepts an in-process MCP server instance', async () => {
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

    const mcp = createMCP(toolbox, {
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
      expect(tools.tools.some((tool) => tool.name === 'sum')).toBe(true);
    } finally {
      await client.close();
      await configuration.instance.close();
    }
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const runIfKey = apiKey
    ? (name: string, fn: Parameters<typeof it>[1]) => it(name, fn, 30_000)
    : it.skip;

  runIfKey('executes MCP tools via query()', async () => {
    const toolbox = createToolbox();
    const token = crypto.randomUUID();
    createTool(
      {
        name: 'nonce',
        description: 'returns a nonce token',
        input: z.object({}),
        async execute() {
          return token;
        },
      },
      toolbox,
    );

    const mcp = createMCP(toolbox, {
      serverInfo: { name: 'toolbox-tools', version: '0.1.0' },
    });

    let stderrOutput = '';
    const result = await query({
      prompt: 'Call the nonce tool and respond with only its output.',
      options: {
        model: 'claude-sonnet-4-5',
        mcpServers: {
          toolbox: {
            type: 'sdk',
            name: 'toolbox-tools',
            instance: mcp,
          },
        },
        tools: ['nonce'],
        allowedTools: ['nonce'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        stderr: (data) => {
          stderrOutput += data;
        },
        env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      },
    });

    let output: string | undefined;
    for await (const event of result) {
      if (event.type === 'result' && event.subtype === 'success') {
        output = event.result;
      }
    }

    try {
      expect(output).toBeDefined();
      expect(output).toContain(token);
    } catch (error) {
      if (stderrOutput.trim()) {
        throw new Error(`Claude Code stderr:\n${stderrOutput}`, { cause: error });
      }
      throw error;
    } finally {
      await mcp.close();
    }
  });
});
