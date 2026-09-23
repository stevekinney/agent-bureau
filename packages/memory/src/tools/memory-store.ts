import { createTool } from 'armorer';
import { z } from 'zod';

import type { Memory } from '../types';

const memoryStoreInput = z.object({
  content: z.string().describe('The content to store in memory'),
  tags: z.array(z.string()).optional().describe('Tags to associate with the memory'),
  importance: z.number().optional().describe('Importance score between 0 and 1'),
  evergreen: z
    .boolean()
    .optional()
    .describe('Whether this memory should be exempt from temporal decay'),
});

/**
 * Creates a tool that stores information in memory for later recall.
 */
export function createMemoryStoreTool(memory: Memory) {
  return createTool({
    name: 'memory_store',
    description: 'Store information in memory for later recall',
    input: memoryStoreInput,
    async execute(params) {
      const entry = await memory.remember(params.content, {
        source: 'tool',
        ...(params.tags !== undefined ? { tags: params.tags } : {}),
        ...(params.importance !== undefined ? { importance: params.importance } : {}),
        ...(params.evergreen !== undefined ? { evergreen: params.evergreen } : {}),
      });

      return {
        id: entry.id,
        content: entry.content,
        stored: true,
      };
    },
  });
}
