# MCP Server

## Overview

Expose a Toolbox registry as an MCP server, with tools, resources, and prompts.
Toolbox handles tool registration; MCP handles transport and protocol details.

## Prerequisites

- Install the MCP SDK as a runtime dependency (Toolbox does not ship transports).
- Have a registry created with `createToolbox()` and tools registered into it.

## Quick start (stdio transport)

```typescript
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

## Conversion helpers

`armorer/mcp` also exposes conversion helpers for MCP tool interoperability:

- `toMcpTools(input, options?)`: convert Toolbox tools to MCP tool definitions with handlers.
- `fromMcpTools(tools, options?)`: convert MCP tool definitions back into executable Toolbox tools.

## Streamable HTTP transport (Node.js)

Use the Streamable HTTP server transport to expose MCP over HTTP.

```typescript
import { createMCP } from 'armorer/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const mcp = createMCP(toolbox, {
  serverInfo: { name: 'toolbox-tools', version: '0.1.0' },
});

// Create an HTTP transport and hand requests to it.
const transport = new StreamableHTTPServerTransport();

// In your HTTP handler:
// const response = await transport.handleRequest(req);
// res.writeHead(response.status, response.headers);
// res.end(await response.text());

await mcp.connect(transport);
```

If you're running in a web-standard environment (Cloudflare Workers, Deno, Bun),
use the web-standard transport from the MCP SDK instead.

### Tool metadata mapping

You can declare MCP-specific metadata on tools. `createMCP` reads `metadata.mcp` by default.

```typescript
createTool(
  {
    name: 'status',
    description: 'reports status',
    input: z.object({}),
    metadata: {
      mcp: {
        title: 'Status Tool',
        annotations: { readOnlyHint: true },
        execution: { taskSupport: 'optional' },
        meta: { source: 'toolbox' },
      },
    },
    async execute() {
      return { ok: true };
    },
  },
  toolbox,
);
```

You can override or extend this with `toolConfiguration`:

```typescript
const mcp = createMCP(toolbox, {
  toolConfiguration: (tool) => ({
    title: tool.name.toUpperCase(),
  }),
});
```

#### Tool configuration precedence

`toolConfigurationFromMetadata` reads `tool.metadata.mcp`, then `toolConfiguration` overrides
any overlapping fields. The effective MCP tool configuration is:

1. `metadata.mcp` (if present and valid)
2. `toolConfiguration(tool)` (overrides any fields from metadata)
3. Runtime defaults: `description` and `input` fall back to the tool definition

If `meta` is set by either configuration, it is exposed as `_meta`. When no `meta` is set,
the tool's `metadata` object is used as `_meta` (if it's a plain object).

### Result formatting

By default, tool results are returned as:

- `content`: text (stringified result)
- `structuredContent`: only when the tool returns a plain object

You can customize this with `formatResult`:

```typescript
const mcp = createMCP(toolbox, {
  formatResult: (result) => {
    if (result.outcome === 'error') {
      return {
        content: [{ type: 'text', text: result.error ?? 'Error' }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { data: result.result },
    };
  },
});
```

Thrown exceptions from tool execution are converted into MCP errors with a text payload.
Client aborts are respected via the MCP `signal` that is passed into tool execution.

### Resources and prompts

Register additional MCP resources and prompts via registrars:

```typescript
const mcp = createMCP(toolbox, {
  resources: (server) => {
    server.registerResource('readme', 'toolbox://readme', { title: 'README' }, async () => ({
      contents: [{ uri: 'toolbox://readme', text: 'hello' }],
    }));
  },
  prompts: (server) => {
    server.registerPrompt('hello', { description: 'say hello' }, async () => ({
      messages: [{ role: 'assistant', content: { type: 'text', text: 'hello' } }],
    }));
  },
});
```

You can pass a single registrar or an array of registrars:

```typescript
const mcp = createMCP(toolbox, {
  resources: [registerDocs, registerSchemas],
  prompts: [registerAssistantPrompts],
});
```

### Tool updates

When tools are re-registered in the Toolbox registry, the MCP server refreshes
the tool definitions and notifies connected clients with `toolListChanged`.

## Agent SDK integrations

Agent SDK integration examples are documented in [Agent SDK Integrations](./agent-sdk-integrations.md), including:

- OpenAI Agents SDK via MCP (`stdio` and Streamable HTTP)
- Anthropic Claude Agent SDK via in-process MCP server
- Guidance on when to use MCP vs direct OpenAI Agents adapter
