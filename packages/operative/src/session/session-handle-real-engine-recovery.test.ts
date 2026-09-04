import { workflow } from '@lostgradient/weft';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import type { Toolbox } from 'armorer';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { createManualRuntimeServices } from 'lifecycle';

import { createAgentSession } from '../agent-session';
import { createCheckpointStore } from '../durable/checkpoint-store';
import { createRunEngine } from '../durable/create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from '../durable/run-workflow';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';

/**
 * AB-330: split out of `session-handle.test.ts` — this test drives a REAL
 * Weft engine's `startScheduler: true` background poller to fire a durable
 * `ctx.sleep`, then polls `engine.get()` with a real per-iteration
 * `setTimeout` delay until the recovered run settles. `createRunEngine`'s
 * public options carry no `getNow`/clock passthrough to Weft's
 * `Engine.create` (unlike `run-workflow.test.ts`'s `buildEngine` helper,
 * which calls `Engine.create` directly), so nothing here can be driven by a
 * manual clock; adding a passthrough is a production API surface change out
 * of this test-only issue's scope (no changeset). Real-runtime-exempted in
 * `scripts/determinism-manifest.json`, owned by this issue (AB-330).
 */

const fixtureRuntime = createManualRuntimeServices();

function createTestRunOptions() {
  return {
    generate: async () => ({ content: 'hello', toolCalls: [] }),
    toolbox: createToolbox([]) as unknown as Toolbox,
    maximumSteps: 1,
  };
}

/**
 * A workflow that parks on a durable sleep so we can dispose the engine
 * mid-flight and prove recovery picks it up.
 */
function makeParkingWorkflow(sleepMs: number) {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx) {
    yield* ctx.sleep(sleepMs);
    return {
      schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
      runId: '',
      steps: 1,
      content: 'resumed',
      finishReason: 'stop-condition' as const,
    };
  });
}

describe('D2 — Recovery-on-boot: session.recover() durable re-attach path — real engine', () => {
  it('reconciles the RunRef against a REAL Weft engine when the recovered run settles before recover() is called', async () => {
    // The reproduction from the issue (CHR-15): process A crashes mid-run,
    // process B resumes it on boot, and it settles to terminal BEFORE the
    // host calls session.recover(). The fake-engine tests in
    // `session-handle.test.ts` assume a particular shape for engine.get()'s
    // `.result` on a completed workflow — this test exercises the REAL Weft
    // engine to prove that assumption.
    const SLEEP_MS = 20;
    const storage = new MemoryStorage();
    const sessionId = 'ab-28-real-engine-session';
    const runId = `${sessionId}:0`;

    const firstKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const firstStore = createSessionStore(firstKv);
    const { engine: engine1 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: false,
    });

    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: sessionId,
      runs: [
        {
          runId,
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: '',
        },
      ],
    });
    await firstStore.save(session);

    const firstHandle = await engine1.start('agentRun', {}, { id: runId });
    for (let i = 0; i < 10; i++) await yieldToPortableEventLoop();
    engine1[Symbol.dispose]();
    void firstHandle.result().catch(() => {});

    const secondKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const secondStore = createSessionStore(secondKv);
    const secondCheckpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    // Default recover:true resumes the parked workflow synchronously during
    // creation; startScheduler:true (with a short poll interval) arms the
    // timer so its ctx.sleep actually fires within this test's window.
    const { engine: engine2 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      startScheduler: true,
      schedulerPollIntervalMs: 5,
    });

    try {
      // Poll engine.get() until the recovered run settles to terminal BEFORE
      // calling recover() — the exact race the issue describes. Capped at 5
      // attempts per this repo's polling-loop convention.
      let state: Awaited<ReturnType<typeof engine2.get>> = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        state = await engine2.get(runId);
        if (state && state.status !== 'running' && state.status !== 'pending') break;
        await new Promise((resolve) => setTimeout(resolve, SLEEP_MS * 2));
      }

      expect(state?.status).toBe('completed');
      // The real shape engine.get() returns .result in — this is exactly
      // what readTerminalRunOutcome() reads to derive the RunRef status.
      const summary = state?.result as { finishReason?: string } | undefined;
      expect(summary?.finishReason).toBe('stop-condition');

      const h = createSessionHandle(sessionId, {
        store: secondStore,
        agentName: 'agent',
        engine: engine2,
        checkpointStore: secondCheckpointStore,
        runOptions: createTestRunOptions(),
      });

      // recover() must still return null for a terminal run — reconciliation
      // is a side effect, not a resurrection into a live AgentRun.
      const reattached = await h.recover();
      expect(reattached).toBeNull();

      const persisted = await secondStore.load(sessionId);
      expect(persisted?.runs.find((r) => r.runId === runId)?.status).toBe('completed');
    } finally {
      engine2[Symbol.dispose]();
    }
  });
});
