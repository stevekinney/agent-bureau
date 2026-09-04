import { workflow, type WorkflowState } from '@lostgradient/weft';
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
 * AB-348: split out of `session-handle.test.ts` (originally AB-330, then
 * re-owned to this issue per the coordinator note on 2026-09-04 — same root
 * cause as this file's `create-run-engine-poller-unarmed.test.ts` and
 * `create-run-engine-crash-and-adopt.test.ts` siblings). The original form
 * drove a REAL Weft engine's `startScheduler: true` background poller (a
 * real interval, since `createRunEngine` has no clock passthrough into
 * Weft's own scheduler) to fire a durable `ctx.sleep`, then polled
 * `engine.get()` with a real per-iteration `setTimeout` delay until the
 * recovered run settled.
 *
 * The fix mirrors `create-run-engine-poller-unarmed.test.ts`'s technique:
 * `startScheduler: false` (so no real background poller is ever armed) and
 * `engine.scheduler.tick(FAR_FUTURE_EPOCH_MILLISECONDS)` drives the durable
 * `ctx.sleep` past its deadline directly and synchronously, with no real
 * timer or clock read anywhere. The completion poll afterward is
 * microtask/event-loop-turn driven (`yieldToPortableEventLoop`, bounded),
 * not a real `setTimeout` delay.
 */

const fixtureRuntime = createManualRuntimeServices();

// Fixed, arbitrarily far-future epoch millisecond value used to tick the
// scheduler unambiguously past a parked timer's deadline. Not derived from
// the real clock: the deadline itself is computed from Weft's real getNow()
// when ctx.sleep() ran (bounded by whenever the test executes, far short of
// this constant), so any sufficiently distant future instant works. Same
// technique and constant as `create-run-engine-poller-unarmed.test.ts`.
const FAR_FUTURE_EPOCH_MILLISECONDS = 4_102_444_800_000; // 2100-01-01T00:00:00.000Z

// Bounded, event-loop-turn poll — never a real timer delay.
const EVENT_LOOP_POLL_MAX_ATTEMPTS = 200;
async function waitForEventLoop(predicate: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < EVENT_LOOP_POLL_MAX_ATTEMPTS; attempt++) {
    if (await predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('waitForEventLoop exceeded its attempt bound before the condition held');
}

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
    // creation; startScheduler:false means no real background poller is
    // ever armed — the durable ctx.sleep is driven directly below instead.
    const { engine: engine2 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      startScheduler: false,
    });

    try {
      // Drive the recovered ctx.sleep past its deadline directly — no real
      // timer, no clock read. `Scheduler#tick` scans persisted `wf-deadline:`
      // storage keys directly (it is not gated on `Scheduler#start` ever
      // having run — `#stopped` starts `false`), so it works whether or not
      // `startScheduler` armed the real-time poller. Poll engine.get() until
      // the recovered run settles to terminal BEFORE calling recover() — the
      // exact race the issue describes. Event-loop-turn driven, not a real
      // timer delay; re-ticks the scheduler each attempt in case recovery's
      // own checkpoint write for the resumed sleep settles asynchronously
      // after `createRunEngine` returns.
      const stateBox: { current: WorkflowState | null } = { current: null };
      await waitForEventLoop(async () => {
        await engine2.scheduler.tick(FAR_FUTURE_EPOCH_MILLISECONDS);
        stateBox.current = await engine2.get(runId);
        const current = stateBox.current;
        return current !== null && current.status !== 'running' && current.status !== 'pending';
      });
      const state = stateBox.current;

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
