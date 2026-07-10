import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';
import { CompletableEventTarget } from 'lifecycle';
import type { ActiveRun, CombinedOperativeEventMap, GenerateFunction, Toolbox } from 'operative';
import { HumanWaitParkedEvent, stopWhen } from 'operative';
import { z } from 'zod';

import { createTestGateway, requestJSON, waitForRunState } from '../test';

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

/** A `beforeExecute` policy that always requires approval. */
function createNeedsApprovalToolbox(approvalSecret: string, charges: number[]): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'Operator approval required',
            action: { message: 'Approve charge' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

/**
 * Builds a bare-bones `ActiveRun` a test can `store.register()` directly, to
 * simulate a durable run parked on `requestHumanInput` (operative's F3 HITL
 * tool) without a full generate/toolbox-driven run — see AB-20's PR
 * description for why no real caller drives that tool through a durable run
 * yet.
 */
function createParkedActiveRun(): {
  activeRun: ActiveRun;
  emitter: CompletableEventTarget<CombinedOperativeEventMap>;
} {
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  // Casts mirror operative's own `createActiveRun`/`createDurableActiveRun`
  // (create-run.ts, active-run-adapter.ts): `ActiveRun`'s `on`/`once`/
  // `subscribe`/`events` are generic over `CombinedOperativeEventType`
  // (`keyof CombinedOperativeEventMap`, not intersected with `string`), which
  // `.bind()` on `CompletableEventTarget`'s `K extends string`-constrained
  // methods cannot structurally satisfy — the same cast operative's own
  // production adapters use for this exact assignment.
  const activeRun: ActiveRun = {
    result: new Promise<never>(() => {}),
    abort: () => {},
    addEventListener: emitter.addEventListener.bind(emitter) as ActiveRun['addEventListener'],
    removeEventListener: emitter.removeEventListener.bind(
      emitter,
    ) as ActiveRun['removeEventListener'],
    on: emitter.on.bind(emitter) as ActiveRun['on'],
    once: emitter.once.bind(emitter) as ActiveRun['once'],
    subscribe: emitter.subscribe.bind(emitter) as ActiveRun['subscribe'],
    events: emitter.events.bind(emitter) as ActiveRun['events'],
    toObservable: emitter.toObservable.bind(emitter),
    complete: emitter.complete.bind(emitter),
    [Symbol.dispose]: () => {},
  };
  return { activeRun, emitter };
}

describe('reviews routes', () => {
  it('GET /api/v1/reviews lists both a tool-approval and a human-wait pending item', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      generate: async (context) =>
        context.step === 0
          ? {
              content: '',
              toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
            }
          : { content: 'ok', toolCalls: [] },
      toolbox: createNeedsApprovalToolbox('route-test-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
    });

    const gateway = await createTestGateway(bureau);

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Charge the customer' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const { activeRun, emitter } = createParkedActiveRun();
    const runId = gateway.bureau.store.register(activeRun, 'run-parked-human-wait');
    emitter.dispatchEvent(new HumanWaitParkedEvent('human-response', runId, 'Approve refund?'));

    const response = await requestJSON(gateway, '/api/v1/reviews');
    expect(response.status).toBe(200);
    const reviews = (await response.json()) as Array<{ kind: string; id: string }>;

    expect(reviews.some((review) => review.kind === 'tool-approval')).toBe(true);
    expect(reviews.some((review) => review.kind === 'human-wait')).toBe(true);
    expect(reviews).toHaveLength(2);
  });

  it('GET /api/v1/reviews returns an empty array when nothing is pending', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const response = await requestJSON(gateway, '/api/v1/reviews');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('POST /api/v1/reviews/:id/approve resumes a tool-approval, attributed to the caller', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      generate: async (context) =>
        context.step === 0
          ? {
              content: '',
              toolCalls: [{ id: 'call-2', name: 'charge-card', arguments: { cents: 750 } }],
            }
          : { content: 'ok', toolCalls: [] },
      toolbox: createNeedsApprovalToolbox('route-test-secret-2', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      // A KV store is required for the audit trail to persist anything; that
      // in turn makes `createGateway` auto-provision an API key store, which
      // requires authentication on every route (including this test's own
      // `/api/v1/runs` POST) — so every request below carries the static
      // `authToken` bearer, which the authentication middleware accepts
      // alongside managed keys and attributes as principal `'static-token'`.
      persistence: textValueStore(new MemoryStorage()),
    });
    const gateway = await createTestGateway(bureau, { authToken: 'test-admin-token' });
    const authorization = { authorization: 'Bearer test-admin-token' };

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authorization,
      body: JSON.stringify({ message: 'Charge the customer' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const listResponse = await requestJSON(gateway, '/api/v1/reviews', { headers: authorization });
    const [review] = (await listResponse.json()) as Array<{ id: string }>;
    expect(review).toBeDefined();

    const approveResponse = await requestJSON(
      gateway,
      `/api/v1/reviews/${encodeURIComponent(review!.id)}/approve`,
      { method: 'POST', headers: authorization },
    );
    expect(approveResponse.status).toBe(200);
    const outcome = await approveResponse.json();
    expect(outcome.decision).toBe('approve');
    expect(charges).toEqual([750]);

    // The audit trail attributes the decision to the authenticated principal.
    const auditResponse = await requestJSON(
      gateway,
      `/api/v1/audit?runId=${encodeURIComponent(createdRun.id)}&type=review.tool-approval.approved`,
      { headers: authorization },
    );
    const auditRecords = (await auditResponse.json()) as Array<{ principal?: string }>;
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]!.principal).toBe('static-token');
  });

  it('POST /api/v1/reviews/:id/deny records the decision without executing the tool', async () => {
    const charges: number[] = [];
    const bureau = await createBureau({
      generate: async (context) =>
        context.step === 0
          ? {
              content: '',
              toolCalls: [{ id: 'call-3', name: 'charge-card', arguments: { cents: 999 } }],
            }
          : { content: 'ok', toolCalls: [] },
      toolbox: createNeedsApprovalToolbox('route-test-secret-3', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
    });
    const gateway = await createTestGateway(bureau);

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Charge the customer' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    const listResponse = await requestJSON(gateway, '/api/v1/reviews');
    const [review] = (await listResponse.json()) as Array<{ id: string }>;

    const denyResponse = await requestJSON(
      gateway,
      `/api/v1/reviews/${encodeURIComponent(review!.id)}/deny`,
      { method: 'POST', body: JSON.stringify({ reason: 'Looks fraudulent' }) },
    );
    expect(denyResponse.status).toBe(200);
    const outcome = await denyResponse.json();
    expect(outcome.decision).toBe('deny');
    expect(charges).toEqual([]);

    const listAfter = await requestJSON(gateway, '/api/v1/reviews');
    expect(await listAfter.json()).toEqual([]);
  });

  it('POST /api/v1/reviews/:id/approve returns 404 for an unknown review id', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const response = await requestJSON(gateway, '/api/v1/reviews/nope/approve', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });
});
