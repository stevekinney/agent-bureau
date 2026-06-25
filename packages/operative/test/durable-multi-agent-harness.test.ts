/**
 * Tests for {@link createDurableMultiAgentHarness} — the durable multi-agent
 * test utility designed in Phase A3.
 *
 * These tests are written WITHOUT real timers (no `setTimeout`/`setInterval`
 * waits). All scheduling uses `yieldToPortableEventLoop` internally through
 * the harness helpers.
 *
 * ## Weft status semantics
 *
 * `ctx.waitForSignal` parks a workflow in-process but leaves its durable
 * storage status as `'running'`, not `'suspended'`. The `'suspended'` status
 * requires an explicit `engine.suspend(id)` call. Accordingly:
 * - After `waitForSuspend`, the workflow is `'running'` (parked at signal)
 * - After `signal()` + completion, the workflow is `'completed'`
 *
 * The harness enables Phase F (durable multi-agent layer) tests; the acceptance
 * criterion for that phase is:
 *   "a parked HITL run parks on the signal wait, a signal releases it, the
 *    continuation runs; all without real timers"
 *
 * Each test here proves one facet of that contract.
 */

import { workflow } from '@lostgradient/weft';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { afterEach, describe, expect, it } from 'bun:test';

import { createDurableMultiAgentHarness } from '../src/test/durable-multi-agent-harness';

// Drain the inline-launch queue between tests — a pending deferred launch
// from one test can starve the next under full `bun test` concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

// ─── helper workflows ─────────────────────────────────────────────────────────
//
// Each test that needs a specific workflow injects it via the `runWorkflow`
// option, replacing the production `createRunWorkflow`. This avoids the
// "agentRun already registered" collision that would occur if tests tried to
// call `engine.register(...)` on a harness that already registered the
// production workflow.

/**
 * A workflow that parks on a named signal and returns the received payload.
 * Models a HITL approval gate: the run waits until a human sends the signal.
 */
function makeHitlWorkflow() {
  return workflow({ name: 'agentRun' }).execute(async function* (
    ctx,
    input: { requestId: string },
  ) {
    const payload = yield* ctx.waitForSignal<{ approved: boolean }>('human-response');
    return { requestId: input.requestId, approved: payload.approved };
  });
}

/**
 * A workflow that immediately completes with a doubled value. Models a
 * lightweight child run — used to verify child-run handle tracking.
 */
function makeImmediateWorkflow() {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx, input: { value: number }) {
    // Use ctx.memo so this async generator has at least one yield point,
    // satisfying the require-yield lint rule. ctx.memo is a no-op on the
    // first call (immediately returns the value), so the workflow completes
    // in a single step without any external I/O.
    const doubled = yield* ctx.memo('doubled', () => input.value * 2);
    return { doubled };
  });
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('createDurableMultiAgentHarness', () => {
  describe('harness construction', () => {
    it('creates a harness with a live engine and empty child-run list', async () => {
      // Construction without a custom workflow uses the production createRunWorkflow.
      const harness = await createDurableMultiAgentHarness();

      try {
        expect(harness.engine).toBeDefined();
        expect(harness.childRunHandles).toEqual([]);
        expect(typeof harness.signal).toBe('function');
        expect(typeof harness.waitForSuspend).toBe('function');
        expect(typeof harness.waitForCondition).toBe('function');
        expect(typeof harness.yield).toBe('function');
        expect(typeof harness.dispose).toBe('function');
      } finally {
        harness.dispose();
      }
    });

    it('exposes both the engine and its checkpoint store on the engine field', async () => {
      const harness = await createDurableMultiAgentHarness();

      try {
        expect(harness.engine.engine).toBeDefined();
        expect(harness.engine.checkpointStore).toBeDefined();
      } finally {
        harness.dispose();
      }
    });

    it('accepts a custom runWorkflow that replaces the production workflow', async () => {
      // Provide the immediate workflow: if it were the default createRunWorkflow,
      // starting it with { value: 7 } would fail (wrong input shape).
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeImmediateWorkflow(),
      });

      try {
        const { engine } = harness.engine;
        const handle = await engine.start('agentRun', { value: 7 });
        const result = await handle.result();
        expect(result).toEqual({ doubled: 14 });
      } finally {
        harness.dispose();
      }
    });
  });

  describe('child-run handle tracking', () => {
    it('records a handle when a workflow starts', async () => {
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeImmediateWorkflow(),
      });

      try {
        const { engine } = harness.engine;
        const handle = await engine.start('agentRun', { value: 7 });

        // WorkflowStartedEvent fires ASYNCHRONOUSLY (inside the inline
        // launch-queue flush: startQueuedInlineWorkflowExecution first awaits
        // loadWorkflowState, THEN dispatches the event — so it may take more
        // than one macrotask turn). Use waitForCondition to poll reliably.
        await harness.waitForCondition(
          () => harness.childRunHandles.length === 1,
          'child run handle not recorded',
        );

        expect(harness.childRunHandles[0]?.runId).toBe(handle.id);
        expect(harness.childRunHandles[0]?.workflowType).toBe('agentRun');
        expect(harness.childRunHandles[0]?.handle).toBeDefined();

        await handle.result();
      } finally {
        harness.dispose();
      }
    });

    it('records handles for every workflow started, in start order', async () => {
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeImmediateWorkflow(),
      });

      try {
        const { engine } = harness.engine;

        const handle1 = await engine.start('agentRun', { value: 1 });
        const handle2 = await engine.start('agentRun', { value: 2 });
        const handle3 = await engine.start('agentRun', { value: 3 });

        // Each start event is async (fires after loadWorkflowState in the queue
        // flush). Wait until all three are recorded before asserting order.
        await harness.waitForCondition(
          () => harness.childRunHandles.length === 3,
          'not all child run handles were recorded',
        );

        expect(harness.childRunHandles[0]?.runId).toBe(handle1.id);
        expect(harness.childRunHandles[1]?.runId).toBe(handle2.id);
        expect(harness.childRunHandles[2]?.runId).toBe(handle3.id);

        await Promise.all([handle1.result(), handle2.result(), handle3.result()]);
      } finally {
        harness.dispose();
      }
    });

    it('provides a usable WorkflowHandle in the tracked entry', async () => {
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeImmediateWorkflow(),
      });

      try {
        const { engine } = harness.engine;

        const nativeHandle = await engine.start('agentRun', { value: 21 });
        await nativeHandle.result();

        // The start event is async; poll until the handle appears.
        await harness.waitForCondition(
          () => harness.childRunHandles.length === 1,
          'child run handle not tracked after completion',
        );

        const tracked = harness.childRunHandles[0];
        expect(tracked).toBeDefined();

        // The tracked handle snapshots the completed run correctly.
        const snapshot = await tracked!.handle.snapshot();
        expect(snapshot).not.toBeNull();
        expect(snapshot!.status).toBe('completed');
      } finally {
        harness.dispose();
      }
    });

    it('tracks handles for HITL workflows that park on a signal', async () => {
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeHitlWorkflow(),
      });

      try {
        const { engine } = harness.engine;
        const handle = await engine.start('agentRun', { requestId: 'track-hitl' });

        // The start event fires asynchronously after the launch-queue flushes.
        // Poll until the handle appears.
        await harness.waitForCondition(
          () => harness.childRunHandles.length === 1,
          'HITL child run handle not tracked',
        );

        expect(harness.childRunHandles[0]?.runId).toBe(handle.id);

        // Release so the engine can be cleanly disposed.
        await harness.signal(handle.id, 'human-response', { approved: true });
        await handle.result();
      } finally {
        harness.dispose();
      }
    });
  });

  describe('signal delivery', () => {
    it('delivers a signal to a workflow parked on ctx.waitForSignal', async () => {
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeHitlWorkflow(),
      });

      try {
        const { engine } = harness.engine;
        const handle = await engine.start('agentRun', { requestId: 'req-1' });

        // Wait until the engine has processed the inline launch (left 'pending').
        await harness.waitForSuspend(handle.id);

        // At this point the workflow is 'running' and parked at waitForSignal.
        const parkedSnapshot = await handle.snapshot();
        expect(parkedSnapshot?.status).toBe('running');

        // Deliver the human's decision.
        await harness.signal(handle.id, 'human-response', { approved: true });

        // Drain until the run resumes and completes.
        const result = await handle.result();
        expect(result).toEqual({ requestId: 'req-1', approved: true });
      } finally {
        harness.dispose();
      }
    });

    it('delivers signals with a payload and the workflow receives the typed value', async () => {
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeHitlWorkflow(),
      });

      try {
        const { engine } = harness.engine;
        const handle = await engine.start('agentRun', { requestId: 'req-deny' });
        await harness.waitForSuspend(handle.id);

        // Deliver a rejection payload.
        await harness.signal(handle.id, 'human-response', { approved: false });

        const result = await handle.result();
        expect(result).toEqual({ requestId: 'req-deny', approved: false });
      } finally {
        harness.dispose();
      }
    });

    it('can buffer a signal sent before the workflow parks and deliver it on park', async () => {
      // Weft buffers signals delivered before the workflow reaches waitForSignal.
      // This tests the signal-first-then-park path.
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeHitlWorkflow(),
      });

      try {
        const { engine } = harness.engine;
        const handle = await engine.start('agentRun', { requestId: 'pre-signal' });

        // Send the signal BEFORE the workflow has even run — Weft buffers it.
        await harness.signal(handle.id, 'human-response', { approved: true });

        // The workflow receives the buffered signal when it reaches waitForSignal.
        const result = await handle.result();
        expect(result).toEqual({ requestId: 'pre-signal', approved: true });
      } finally {
        harness.dispose();
      }
    });

    it('signal delivery via harness and via engine direct both release a parked run', async () => {
      // Two independent runs; one released via harness.signal, one via engine.signal.
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeHitlWorkflow(),
      });

      try {
        const { engine } = harness.engine;

        const harnessHandle = await engine.start('agentRun', { requestId: 'via-harness' });
        const directHandle = await engine.start('agentRun', { requestId: 'via-direct' });

        // Wait for both to park at their signal waits.
        await harness.waitForSuspend(harnessHandle.id);
        await harness.waitForSuspend(directHandle.id);

        // Both are now 'running' and parked on waitForSignal.
        const snap1 = await harnessHandle.snapshot();
        const snap2 = await directHandle.snapshot();
        expect(snap1?.status).toBe('running');
        expect(snap2?.status).toBe('running');

        // Release them via different paths.
        await harness.signal(harnessHandle.id, 'human-response', { approved: true });
        await engine.signal(directHandle.id, 'human-response', { approved: false });

        const result1 = await harnessHandle.result();
        const result2 = await directHandle.result();

        expect(result1).toEqual({ requestId: 'via-harness', approved: true });
        expect(result2).toEqual({ requestId: 'via-direct', approved: false });
      } finally {
        harness.dispose();
      }
    });
  });

  describe('waitForSuspend', () => {
    it('resolves once the workflow has left pending and is parked at waitForSignal', async () => {
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeHitlWorkflow(),
      });

      try {
        const { engine } = harness.engine;
        const handle = await engine.start('agentRun', { requestId: 'suspend-test' });

        // Immediately after start, the workflow is 'pending' (in the launch queue).
        const initialSnapshot = await handle.snapshot();
        expect(initialSnapshot?.status).toBe('pending');

        // After waitForSuspend, the workflow has left 'pending' and is parked.
        await harness.waitForSuspend(handle.id);

        const snapshot = await handle.snapshot();
        // 'running' = parked at ctx.waitForSignal; Weft does not change status
        // to 'suspended' for signal-park (that requires engine.suspend()).
        expect(snapshot?.status).toBe('running');

        // Clean up: signal to let the run complete so the engine disposes cleanly.
        await harness.signal(handle.id, 'human-response', { approved: true });
        await handle.result();
      } finally {
        harness.dispose();
      }
    });

    it('throws a clear error if the workflow terminates before parking', async () => {
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeImmediateWorkflow(),
      });

      try {
        const { engine } = harness.engine;
        const handle = await engine.start('agentRun', { value: 5 });

        // Let the run finish — waitForSuspend should detect the terminal state.
        await handle.result();

        // Now calling waitForSuspend should surface the terminal status rather
        // than hanging.
        await expect(harness.waitForSuspend(handle.id)).rejects.toThrow('terminal status');
      } finally {
        harness.dispose();
      }
    });

    it('can wait using the run id from the child-run list', async () => {
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeHitlWorkflow(),
      });

      try {
        const { engine } = harness.engine;
        await engine.start('agentRun', { requestId: 'from-child-list' });

        // Poll until the async start event fires and the handle is recorded.
        await harness.waitForCondition(
          () => harness.childRunHandles.length === 1,
          'child run handle not tracked',
        );

        // Use the tracked handle's runId to call waitForSuspend.
        const tracked = harness.childRunHandles[0];
        expect(tracked).toBeDefined();

        await harness.waitForSuspend(tracked!.runId);

        const snapshot = await tracked!.handle.snapshot();
        // 'running' = parked at ctx.waitForSignal.
        expect(snapshot?.status).toBe('running');

        // Release.
        await harness.signal(tracked!.runId, 'human-response', { approved: true });
        await tracked!.handle.result();
      } finally {
        harness.dispose();
      }
    });
  });

  describe('waitForCondition', () => {
    it('resolves immediately when the condition is already true', async () => {
      const harness = await createDurableMultiAgentHarness();

      try {
        await harness.waitForCondition(() => true, 'should never fail');
        // If we reach here, the condition resolved without error.
        expect(true).toBe(true);
      } finally {
        harness.dispose();
      }
    });

    it('resolves when the condition becomes true after several yields', async () => {
      const harness = await createDurableMultiAgentHarness();
      let counter = 0;

      try {
        // Start a background increment (deferred).
        const increment = async () => {
          for (let i = 0; i < 5; i++) {
            await yieldToPortableEventLoop();
            counter++;
          }
        };
        void increment();

        await harness.waitForCondition(() => counter >= 5, 'counter did not reach 5');
        expect(counter).toBeGreaterThanOrEqual(5);
      } finally {
        harness.dispose();
      }
    });

    it('throws after the maximum attempts when the condition is never true', async () => {
      const harness = await createDurableMultiAgentHarness();

      try {
        await expect(harness.waitForCondition(() => false, 'always false', 3)).rejects.toThrow(
          'always false',
        );
      } finally {
        harness.dispose();
      }
    });

    it('accepts an async condition predicate', async () => {
      const harness = await createDurableMultiAgentHarness();

      try {
        let resolved = false;
        void Promise.resolve().then(() => {
          resolved = true;
        });

        await harness.waitForCondition(async () => resolved, 'async predicate never resolved');
        expect(resolved).toBe(true);
      } finally {
        harness.dispose();
      }
    });
  });

  describe('full HITL scenario (the Phase F acceptance criterion)', () => {
    it('parks a HITL run at waitForSignal, delivers a signal, continuation runs — no real timers', async () => {
      /**
       * This is the canonical acceptance-criterion test for Phase A3 / Phase F:
       * "a parked HITL run parks on the signal wait, a signal releases it, the
       *  continuation runs; all without real timers."
       *
       * Note: Weft status semantics — `ctx.waitForSignal` does NOT change the
       * workflow's durable status to 'suspended'. The workflow stays 'running'
       * while parked. 'suspended' requires an explicit engine.suspend() call.
       */
      const harness = await createDurableMultiAgentHarness({
        runWorkflow: makeHitlWorkflow(),
      });

      try {
        const { engine } = harness.engine;

        // ── 1. Start a run that will park on the approval gate ──────────────
        const handle = await engine.start('agentRun', { requestId: 'phase-f-acceptance' });

        // The run starts as 'pending' (in the inline launch queue).
        const pendingSnapshot = await handle.snapshot();
        expect(pendingSnapshot?.status).toBe('pending');

        // ── 2. Wait for the run to park at ctx.waitForSignal ─────────────────
        await harness.waitForSuspend(handle.id);

        // After the queue has flushed: status is 'running' (parked at signal).
        const parkedSnapshot = await handle.snapshot();
        expect(parkedSnapshot?.status).toBe('running');

        // The start event fires asynchronously; poll until it's recorded.
        await harness.waitForCondition(
          () => harness.childRunHandles.length === 1,
          'child run handle not recorded after waitForSuspend',
        );
        expect(harness.childRunHandles[0]?.runId).toBe(handle.id);

        // ── 3. Deliver the human's approval ─────────────────────────────────
        await harness.signal(handle.id, 'human-response', { approved: true });

        // ── 4. The continuation runs and the workflow completes ──────────────
        const result = await handle.result();
        expect(result).toEqual({ requestId: 'phase-f-acceptance', approved: true });

        const finalSnapshot = await handle.snapshot();
        expect(finalSnapshot?.status).toBe('completed');
      } finally {
        harness.dispose();
      }
    });
  });
});
