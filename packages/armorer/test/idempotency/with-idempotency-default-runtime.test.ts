import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../src/create-tool';
import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import { fullInputKey } from '../../src/idempotency/key-generators';
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
 * Split out of with-idempotency.test.ts (AB-292) so the
 * scripts/determinism-manifest.json realRuntimeExemptions entry this file
 * needs covers only this one test: it deliberately verifies withIdempotency's
 * DEFAULT prevalidation deadline scheduler (no injected `runtime` or
 * `setTimeoutFunction`), i.e. that it schedules and races the deadline with
 * the real platform timer when the caller supplies none. Injecting a manual
 * runtime here would defeat the point of the test — confirmed empirically:
 * doing so breaks this test (the async schema-prevalidation race no longer
 * resolves), which is itself evidence the default path is what's under test.
 */
describe('withIdempotency', () => {
  it('uses the default prevalidation deadline scheduler when no scheduler is supplied', async () => {
    const cache = createToolResultCache({ store: createTestStore(), defaultTTL: 60_000 });
    const controller = new AbortController();
    let callCount = 0;
    const tool = createTool({
      name: 'default-scheduled-prevalidation',
      description: 'Completes async idempotency prevalidation with default scheduling',
      version: '1.0.0',
      input: z.object({ value: z.string() }).superRefine(async () => {}),
      idempotencyKey: (input: unknown) => fullInputKey(input),
      async execute({ value }) {
        callCount++;
        return value;
      },
    });
    const wrapped = withIdempotency(tool, {
      cache,
      tenantId: 'tenant-a',
    });

    await expect(
      wrapped.execute(
        { value: 'allowed' },
        {
          requestContext: { ...requestContext, deadline: Date.now() + 60_000 },
          signal: controller.signal,
        },
      ),
    ).resolves.toBe('allowed');
    expect(callCount).toBe(1);
  });
});
