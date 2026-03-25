import { createTool } from 'armorer';
import { z } from 'zod';

import type { Memory } from '../types';

const memoryRecallInput = z.object({
  query: z.string().describe('The search query to find relevant memories'),
  limit: z.number().optional().describe('Maximum number of results to return'),
  namespace: z.string().optional().describe('Memory namespace to search in'),
});

/**
 * Creates a tool that searches memory for relevant information.
 */
export function createMemoryRecallTool(memory: Memory) {
  return createTool({
    name: 'memory_recall',
    description: 'Search memory for relevant information',
    input: memoryRecallInput,
    async execute(params) {
      const results = await memory.recall(params.query, {
        limit: params.limit,
        namespace: params.namespace,
      });

      if (results.length === 0) {
        return { found: false, results: [] };
      }

      return {
        found: true,
        results: results.map((result) => ({
          id: result.id,
          content: result.content,
          score: result.score,
          createdAt: result.createdAt,
          tags: result.metadata.tags,
        })),
      };
    },
  });
}
