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

const mcp = createMCP(toolbox, {
  serverInfo: { name: 'toolbox-tools', version: '0.1.0' },
});
await mcp.connect(new StdioServerTransport());
await new Promise(() => {});
