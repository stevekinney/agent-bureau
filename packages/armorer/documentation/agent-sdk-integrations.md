# Agent SDK Integrations

## Overview

Toolbox supports Agent SDK workflows through MCP and direct adapters.

For OpenAI Agents, you can either:

1. Connect to a Toolbox MCP server
2. Use the direct OpenAI Agents adapter (`armorer/open-ai/agents` or `armorer/adapters/open-ai/agents`)

For Anthropic Claude Agent SDK, use MCP server integration.

## OpenAI Agents SDK (`@openai/agents`)

The OpenAI Agents SDK can consume Toolbox tools in two ways:

1. **MCP servers** (shown below) - Run Toolbox as an MCP server that the SDK connects to
2. **Direct adapter** - Convert tools directly using the [OpenAI Agents adapter](./openai-agents-sdk.md) (`armorer/open-ai/agents` or `armorer/adapters/open-ai/agents`)

The MCP approach is useful when you want to run tools in a separate process or expose them over HTTP. The direct integration is simpler for in-process usage.

### Stdio (local subprocess)

Run a Toolbox MCP server as a local process and let the agent SDK spawn it.

```typescript
// mcp-server.ts
import { createToolbox, createTool } from 'armorer';
import { createMCP } from 'armorer/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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
await mcp.connect(new StdioServerTransport());
```

```typescript
// agent.ts
import { Agent, MCPServerStdio, run } from '@openai/agents';

const server = new MCPServerStdio({
  name: 'toolbox-tools',
  command: 'node',
  args: ['dist/mcp-server.js'],
});

const agent = new Agent({
  name: 'Assistant',
  instructions: 'Use MCP tools to answer the question.',
  mcpServers: [server],
});

const result = await run(agent, 'Add 7 and 22.');
console.log(result.finalOutput);
```

### Streamable HTTP

Expose Toolbox over HTTP and connect via the Streamable HTTP MCP server.

```typescript
import { Agent, MCPServerStreamableHttp, run } from '@openai/agents';

const server = new MCPServerStreamableHttp({
  url: 'http://localhost:8000/mcp',
  name: 'toolbox-tools',
  requestInit: {
    headers: { Authorization: `Bearer ${process.env.MCP_SERVER_TOKEN}` },
  },
  cacheToolsList: true,
});

const agent = new Agent({
  name: 'Assistant',
  instructions: 'Use MCP tools to answer the question.',
  mcpServers: [server],
});

const result = await run(agent, 'Add 7 and 22.');
console.log(result.finalOutput);
```

## Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`)

Use the in-process MCP server instance with the SDK `mcpServers` configuration.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createToolbox, createTool } from 'armorer';
import { createMCP } from 'armorer/mcp';
import { z } from 'zod';

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

const result = await query({
  prompt: 'Add 7 and 22.',
  options: {
    mcpServers: {
      toolbox: {
        type: 'sdk',
        name: 'toolbox-tools',
        instance: mcp,
      },
    },
  },
});

for await (const event of result) {
  if (event.type === 'result') {
    console.log(event.result);
  }
}
```

## Related Documentation

- [MCP Server](./mcp.md) - Expose Toolbox tools over Model Context Protocol
- [OpenAI Agents SDK Integration](./openai-agents-sdk.md) - Direct `@openai/agents` adapter
- [Provider Adapters](./provider-adapters.md) - OpenAI, Anthropic, and Gemini static tool adapters
