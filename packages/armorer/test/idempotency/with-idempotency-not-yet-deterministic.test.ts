import { beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
import type { ToolResultCache } from '../../src/idempotency/types';
import { withIdempotency } from '../../src/idempotency/with-idempotency';

const requestContext = {
  runId: 'run-a',
  agentId: 'agent-a',
  authority: {
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
} as const;

function createTestStore() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix: string) => [...map.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

/**
 * AB-292: split out of with-idempotency.test.ts. Deliberately NOT added to
 * scripts/determinism-manifest.json's deterministicDirectories — it is a
 * documented, not-yet-resolved determinism-gate violation, reported to the
 * AB-292 coordinator rather than exempted with a placeholder reason.
 *
 * The real 12ms setTimeout below races a real per-iteration renewal timer
 * (armed at leaseDurationMs / 2, driven by withIdempotency's default real
 * RuntimeServices since no runtime/setTimeoutFunction override is passed)
 * against this tool's own real sleep. Converting it is not a mechanical
 * substitution: the crafted `now: () => [100, 100, 105][clockReads++]`
 * sequence encodes a specific, order-dependent relationship between three
 * now() reads (admission, a renewal check, and the deadline-cancel timer's
 * delay calculation) and real elapsed wall-clock time inside
 * cache.completeStarted's own fencing. An attempt to drive this
 * deterministically with ManualRuntimeServices.advance() (replacing the
 * tool's real sleep with a manually-released deferred) hung indefinitely:
 * the deadline-cancel timer only stops lease renewal, it does not abort the
 * in-flight tool.executeWith(...) call, so the outer execute() promise never
 * settles until the tool itself resolves. Reproducing the original test's
 * exact behavior needs tracing the real relationship between the mocked
 * now() call order and cache.completeStarted's internal fencing — dedicated
 * follow-up work, not a rewrite bundled with this pull request's other
 * fixes.
 */
describe('withIdempotency', () => {
  let cache: ToolResultCache;

  beforeEach(() => {
    cache = createToolResultCache({
      store: createTestStore(),
      defaultTTL: 60_000,
    });
  });

  it('stops renewing at the absolute deadline and rejects renewal failures', async () => {
    const createSlowTool = (name: string) =>
      createTool({
        name,
        description: 'Slow direct idempotency execution',
        version: '1.0.0',
        input: z.object({ value: z.number() }),
        idempotencyKey: (input: unknown) => fullInputKey(input),
        async execute({ value }) {
          await new Promise((resolve) => setTimeout(resolve, 12));
          return value;
        },
      });

    let clockReads = 0;
    const deadlineTool = withIdempotency(createSlowTool('deadline-fence'), {
      cache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 5,
      now: () => [100, 100, 105][clockReads++] ?? 105,
    });
    const deadlineExecution = deadlineTool.execute({ value: 9 }, { requestContext });
    await expect(deadlineExecution).rejects.toThrow('lost its execution fence');

    let renewalCalls = 0;
    const rejectingRenewalCache: ToolResultCache = {
      ...cache,
      async renewStarted() {
        renewalCalls += 1;
        if (renewalCalls === 1) return true;
        throw new Error('renewal store unavailable');
      },
    };
    const renewalFailureTool = withIdempotency(createSlowTool('renewal-failure'), {
      cache: rejectingRenewalCache,
      tenantId: 'tenant-a',
      leaseDurationMs: 4,
      maximumExecutionDurationMs: 100,
    });

    await expect(renewalFailureTool.execute({ value: 10 }, { requestContext })).rejects.toThrow(
      'lost its execution fence',
    );
  });
});
