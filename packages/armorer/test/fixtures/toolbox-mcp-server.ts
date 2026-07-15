import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolbox } from '../../src/create-toolbox';
import { createMCP } from '../../src/integrations/mcp';

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
// The stdio transport keeps the process alive until the client closes stdin.
// A never-resolving promise here would defeat that shutdown signal and force
// the client transport to wait for its process-termination grace period.
await mcp.connect(new StdioServerTransport());
