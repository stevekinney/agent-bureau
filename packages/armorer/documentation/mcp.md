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

## OAuth client support

When connecting to an MCP server that requires authorization, `armorer/mcp` provides an
`OAuthClientProvider` implementation and thin connection orchestration on top of
`@modelcontextprotocol/sdk`'s `client/auth.js` (PKCE, RFC 9728/8414 discovery, dynamic client
registration, and token refresh) and `StreamableHTTPClientTransport`. This module never persists
anything itself — you supply a `McpOAuthTokenStorage` hook (in-memory, a database row, an encrypted
session, ...) and it reads/writes exclusively through that interface.

```typescript
import {
  completeMcpOAuthAuthorization,
  connectMcpClientWithOAuth,
  createInMemoryMcpOAuthTokenStorage,
  createMcpOAuthProvider,
  fromMcpClientTools,
  isMcpUnauthorizedError,
} from 'armorer/mcp';

const tokenStorage = createInMemoryMcpOAuthTokenStorage(); // swap for durable storage in production

const provider = createMcpOAuthProvider({
  redirectUrl: 'https://my-app.example.com/oauth/callback',
  clientMetadata: {
    client_name: 'my-app',
    redirect_uris: ['https://my-app.example.com/oauth/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  tokenStorage,
  onAuthorizationRequired(authorizationUrl) {
    // Send the resource owner here (redirect an HTTP response, open a webview, ...).
    // This module never navigates or opens a browser itself.
  },
});

try {
  const client = await connectMcpClientWithOAuth({
    serverUrl: 'https://mcp.example.com',
    provider,
  });
  const tools = await fromMcpClientTools(client);
} catch (error) {
  if (!isMcpUnauthorizedError(error)) throw error;
  // Authorization is required — onAuthorizationRequired already fired above.
}

// After the resource owner is redirected back to `redirectUrl?code=...&state=...&iss=...`:
await completeMcpOAuthAuthorization(provider, {
  serverUrl: 'https://mcp.example.com',
  callbackUrl: receivedCallbackUrl, // the full redirect URL
  tokenStorage,
});
// Now retry connectMcpClientWithOAuth(...) — it will use the newly saved tokens.
```

`completeMcpOAuthAuthorization` validates the redirect's `iss` parameter per
[RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207) against the issuer recorded during
discovery — guarding against authorization-server mix-up attacks — before ever exchanging the
authorization code for tokens. This is implemented against the MCP Authorization spec base
revision [2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization),
plus the RFC 9207 issuer-validation requirement from the
[current draft revision](https://modelcontextprotocol.io/specification/draft/basic/authorization#authorization-response-validation).

## Agent SDK integrations

Agent SDK integration examples are documented in [Agent SDK Integrations](./agent-sdk-integrations.md), including:

- OpenAI Agents SDK via MCP (`stdio` and Streamable HTTP)
- Anthropic Claude Agent SDK via in-process MCP server
- Guidance on when to use MCP vs direct OpenAI Agents adapter

## No dependence on MCP sampling or roots

`createMCP` only exposes Toolbox tools (and, optionally, resources/prompts) as an MCP
server — it never establishes an MCP client session against a host and never requests
`sampling/createMessage` or `roots/list`. `fromMcpTools` does interoperate with MCP tool
definitions (turning them into executable Toolbox tools via a caller-supplied `callTool`),
but that's a one-shot `tools/call` invocation, not a client session that could negotiate
sampling or roots capabilities — those two capabilities are never used anywhere in
`armorer/mcp`. This is intentional, not an oversight:

- **Sampling** (`sampling/createMessage`) lets an MCP server ask the connected client's
  host to run an LLM completion on its behalf. Armorer's tools call out to LLM providers
  directly (via `conversationalist`/provider adapters) rather than routing through a host's
  sampling capability — there's no reason for a tool to depend on whether the MCP client it's
  connected to happens to support sampling.
- **Roots** (`roots/list`) lets a server ask the client which filesystem/workspace roots it
  should operate within. Armorer's filesystem-touching tools (e.g. the coding toolbox) take
  paths as explicit tool input or configuration, validated by the tool itself, instead of
  discovering them through an MCP root negotiation.

Both capabilities are on a deprecation path in the MCP specification's draft revision
(tracked upstream via SEP-2577). If you need an agent to call an LLM, use a provider SDK or
`conversationalist`'s adapters directly — do not build a dependency on MCP sampling. If a tool
needs to know which paths it may touch, pass that in as tool input/configuration — do not
build a dependency on MCP roots.
