import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { JsonValue } from '../core/serialization/json';
import { createTool, createToolCall } from '../create-tool';
import { createToolbox } from '../create-toolbox';
import type { ToolPolicyDecision } from '../is-tool';

const ownerId = 'settled-shape-owner';

function requestContext() {
  return {
    authority: {
      principalId: ownerId,
      tenantId: 'settled-shape-tenant',
      ownerId,
      capabilities: [],
      authorizationRevision: '1',
    },
    audience: 'tenant' as const,
    agentId: 'settled-shape-agent',
    runId: 'settled-shape-run',
  };
}

/**
 * COR-1261. `settled` is terminal, and a consumer that records settlements
 * compares them against the execution result. These assert equality with
 * `result.error` rather than checking a shape in isolation, because the defect
 * was not that either value was wrong on its own — it was that the two
 * disagreed in type, on some failure paths and not others, with nothing in
 * either shape announcing which path produced it.
 */
async function settlementFor(
  name: string,
  overrides: {
    policy?: ToolPolicyDecision;
    execute?: () => Promise<unknown>;
    input?: z.ZodType;
    argumentsValue?: Record<string, JsonValue>;
  },
) {
  const tool = createTool({
    name,
    version: '1.0.0',
    description: 'settled error shape test tool',
    input: overrides.input ?? z.object({}),
    ...(overrides.policy
      ? { policy: { beforeExecute: () => overrides.policy as ToolPolicyDecision } }
      : {}),
    execute: overrides.execute ?? (async () => 'ok'),
  });
  const toolbox = createToolbox([tool]);
  const settled: unknown[] = [];
  toolbox.addEventListener('settled', (event) => {
    settled.push((event as unknown as { error: unknown }).error);
  });
  const result = await toolbox.execute(
    createToolCall(tool.name, overrides.argumentsValue ?? {}, `${name}-call`),
    { ownerId, requestContext: requestContext() },
  );
  return { result, settled };
}

describe('the settled event carries the same error the result carries', () => {
  it('on the generic execute-error path', async () => {
    const { result, settled } = await settlementFor('settled-shape-throw', {
      execute: async () => {
        throw new Error('execution blew up');
      },
    });

    expect(result.outcome).toBe('error');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual(result.error);
    expect(result.error?.code).toBe('INTERNAL_ERROR');
  });

  it('on the validation path, without losing the Zod issues from the result', async () => {
    const { result, settled } = await settlementFor('settled-shape-validation', {
      input: z.object({ count: z.number() }),
      argumentsValue: { count: 'not a number' },
    });

    expect(result.outcome).toBe('error');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual(result.error);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    // `validate-error` keeps the ZodError, so the issues still reach the result.
    expect(result.error?.details).toBeDefined();
  });

  it('on the policy-denied path', async () => {
    const { result, settled } = await settlementFor('settled-shape-denied', {
      policy: { allow: false, reason: 'Policy says no' },
    });

    expect(result.outcome).toBe('error');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual(result.error);
    expect(result.error?.code).toBe('POLICY_DENIED');
  });

  it('on the cancellation path', async () => {
    const controller = new AbortController();
    const tool = createTool({
      name: 'settled-shape-cancelled',
      version: '1.0.0',
      description: 'settled error shape test tool',
      input: z.object({}),
      execute: async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('should have been cancelled');
      },
    });
    const toolbox = createToolbox([tool]);
    const settled: unknown[] = [];
    toolbox.addEventListener('settled', (event) => {
      settled.push((event as unknown as { error: unknown }).error);
    });

    const result = await toolbox.execute(
      createToolCall(tool.name, {}, 'settled-shape-cancelled-call'),
      { ownerId, requestContext: requestContext(), signal: controller.signal },
    );

    expect(result.outcome).toBe('error');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual(result.error);
    expect(result.error?.code).toBe('CANCELLED');
  });

  it('never settles a bare Error on any of those paths', async () => {
    // The defect's signature: a value with no own enumerable keys, which
    // compares unequal to the structured result error and serializes to `{}`.
    const cases = await Promise.all([
      settlementFor('settled-shape-bare-throw', {
        execute: async () => {
          throw new Error('boom');
        },
      }),
      settlementFor('settled-shape-bare-denied', {
        policy: { allow: false, reason: 'no' },
      }),
    ]);

    for (const { settled } of cases) {
      expect(settled[0]).not.toBeInstanceOf(Error);
      expect(Object.keys(settled[0] as object).toSorted()).toEqual([
        'category',
        'code',
        'message',
        'retryable',
      ]);
    }
  });
});
