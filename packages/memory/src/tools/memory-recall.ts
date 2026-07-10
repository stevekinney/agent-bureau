import { createTool } from 'armorer';
import { z } from 'zod';

import { type MemoryGuardrailOptions, scanMemoryContent } from '../guardrail';
import type { Memory } from '../types';

const memoryRecallInput = z.object({
  query: z.string().describe('The search query to find relevant memories'),
  limit: z.number().optional().describe('Maximum number of results to return'),
  namespace: z.string().optional().describe('Memory namespace to search in'),
});

/** Options for `createMemoryRecallTool`. */
export interface CreateMemoryRecallToolOptions {
  /**
   * Runs recalled content through the shared guardrail detector pipeline
   * before it's returned to the model. Omit to skip scanning entirely
   * (recalled/ingested content passes through unchecked).
   */
  guardrail?: MemoryGuardrailOptions;
}

/**
 * Creates a tool that searches memory for relevant information.
 *
 * When `options.guardrail` is provided, every recalled entry's content is
 * scanned through the shared detector pipeline before it's returned —
 * entries whose provenance is an ingested document (tagged via `ingest()`)
 * or a directly-remembered entry are both covered, since both flow through
 * `memory.recall()`. Flagged entries are dropped (`action: 'block'`,
 * default) or kept and marked `flagged: true` (`action: 'warn'`).
 */
export function createMemoryRecallTool(
  memory: Memory,
  options: CreateMemoryRecallToolOptions = {},
) {
  const { guardrail } = options;

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

      if (!guardrail) {
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
      }

      const scanned = await Promise.all(
        results.map(async (result) => ({
          result,
          scan: await scanMemoryContent(result.content, result.metadata, guardrail),
        })),
      );

      const kept = scanned.filter(({ scan }) => !scan.blocked);
      const blockedCount = scanned.length - kept.length;

      return {
        found: kept.length > 0,
        results: kept.map(({ result, scan }) => ({
          id: result.id,
          content: scan.content,
          score: result.score,
          createdAt: result.createdAt,
          tags: result.metadata.tags,
          ...(scan.flagged ? { flagged: true as const } : {}),
        })),
        ...(blockedCount > 0 ? { blockedCount } : {}),
      };
    },
  });
}
