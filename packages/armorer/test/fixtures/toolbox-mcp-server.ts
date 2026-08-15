import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// The adjacent streamable-HTTP test exercises Armorer's createMCP adapter. This child fixture
// isolates the OpenAI SDK's stdio-client boundary so package-level tests remain fast and runnable
// from a clean checkout without compiling Armorer's full source graph in a second Bun process.
const mcp = new McpServer({ name: 'toolbox-tools', version: '0.1.0' });
mcp.registerTool(
  'sum',
  {
    description: 'adds two numbers',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
);
// The stdio transport keeps the process alive until the client closes stdin.
// A never-resolving promise here would defeat that shutdown signal and force
// the client transport to wait for its process-termination grace period.
await mcp.connect(new StdioServerTransport());
