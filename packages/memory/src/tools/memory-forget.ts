import { createTool } from 'armorer';
import { z } from 'zod';

import type { Memory } from '../types';

const memoryForgetInput = z.object({
  id: z.string().describe('The ID of the memory entry to remove'),
});

/**
 * Creates a tool that removes a specific memory entry.
 */
export function createMemoryForgetTool(memory: Memory) {
  return createTool({
    name: 'memory_forget',
    description: 'Remove a specific memory entry',
    input: memoryForgetInput,
    async execute(params) {
      await memory.forget(params.id);
      return { deleted: true, id: params.id };
    },
  });
}
