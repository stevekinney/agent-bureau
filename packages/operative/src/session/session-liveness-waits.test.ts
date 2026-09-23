import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

import { HumanWaitParkedEvent } from '../events';
import { createSessionStore } from './create-session-store';
import { createSessionEngine } from './session-engine-test-fixture';
import { createSessionHandle, deriveRunId } from './session-handle';
import { dispatchOnToolboxContext } from './session-handle-test-support';
import { createSessionRun, type SessionRunState } from './session-run';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('SessionHandle liveness — declared waits', () => {
  it('resumes the watchdog when an older parked invocation settles after a newer reservation', async () => {
    const sessionId = 'concurrent-parked-invocations';
    const runtime = createManualRuntimeServices();
    const state: SessionRunState = { currentRun: null, currentRunId: null };
    const parked = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const resume = mock(() => {});
    const pause = mock(() => {});
    const tool = createTool({
      name: 'park',
      description: 'Wait for release',
      input: z.object({}),
      execute: async (_input, context) => {
        dispatchOnToolboxContext(context, new HumanWaitParkedEvent('answer', `${sessionId}:0`));
        parked.resolve();
        await released.promise;
        return 'released';
      },
    });
    let generation = 0;
    const run = createSessionRun({
      sessionId,
      store: createSessionStore(textValueStore(new MemoryStorage())),
      engine: undefined,
      checkpointStore: undefined,
      agentName: 'agent',
      runOptions: {
        generate: async () => ({
          content: 'done',
          toolCalls: generation++ === 0 ? [{ name: 'park', arguments: {} }] : [],
        }),
        toolbox: createToolbox([tool]),
        maximumSteps: 1,
      },
      runtime,
      state,
      setLivenessState: () => {},
      livenessClock: {
        now: runtime.monotonic.now,
        setTimeout: runtime.timers.setTimeout,
        clearTimeout: runtime.timers.clearTimeout,
      },
      pauseSessionWatchdogForWait: pause,
      resumeSessionWatchdogAfterWait: resume,
    });
    const older = run('first');
    await parked.promise;
    expect(pause).toHaveBeenCalledTimes(1);
    await run('second').result();
    expect(resume).not.toHaveBeenCalled();
    released.resolve();
    await older.result();
    await yieldToPortableEventLoop();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(state.parkedRunId).toBeUndefined();
  });

  it('pauses missedPulseCount accrual for an unbounded review wait and resumes it once session.signal() releases it', async () => {
    const sessionId = 'human-wait-liveness-session';
    const runId = deriveRunId(sessionId, 0);
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const fakeEngine = createSessionEngine({ signal: async () => {} });

    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let signalToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });

    const parkingTool = createTool({
      name: 'requestHumanInput',
      description: 'Park waiting for human input',
      input: z.object({ signalName: z.string(), prompt: z.string().optional() }),
      execute: async (input, context) => {
        // Mirrors createRequestHumanInputTool: dispatches HumanWaitParkedEvent
        // via RuntimeToolContext.dispatch, which the toolbox forwards onto
        // this run's own emitter as a ForwardedEvent.
        dispatchOnToolboxContext(
          context,
          new HumanWaitParkedEvent(input.signalName, runId, input.prompt),
        );
        signalToolStarted();
        await toolGate;
        return 'released';
      },
    });

    let stepIndex = 0;
    const scheduled: Array<() => void> = [];
    const cleared: unknown[] = [];
    let nextId = 0;

    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      engine: fakeEngine,
      runOptions: {
        generate: async () => {
          const index = stepIndex++;
          if (index === 0) {
            return {
              content: '',
              toolCalls: [
                {
                  name: 'requestHumanInput',
                  arguments: { signalName: 'human-response', prompt: 'Approve this?' },
                },
              ],
            };
          }
          return { content: 'done', toolCalls: [] };
        },
        toolbox: createToolbox([parkingTool]),
        maximumSteps: 2,
      },
      setTimeoutFunction: (callback) => {
        scheduled.push(callback);
        return ++nextId;
      },
      clearTimeoutFunction: (timer) => {
        cleared.push(timer);
      },
    });

    const monitoring = handle.monitor({ every: 20, input: 'poll', until: () => true });

    // Let the tick's run reach the tool call and dispatch HumanWaitParkedEvent.
    await toolStarted;

    const parkedSnapshot = handle.snapshot();
    expect(parkedSnapshot.status).toBe('waiting');
    // A supplied `prompt` distinguishes a human review from a bare signal
    // (AB-88: both surface through human-wait.parked today).
    expect(parkedSnapshot.declaredWait?.reason).toBe('review');
    expect(parkedSnapshot.declaredWait?.dependency).toBe('human-response');
    // Legal only for 'signal'/'review' (AB-88's unbounded-wait exception).
    expect(parkedSnapshot.declaredWait?.deadline).toBeUndefined();
    expect(parkedSnapshot.assessment).toBe('legitimately-waiting');

    // The session watchdog is paused while parked: firing every check
    // scheduled before the park must not move missedPulseCount, and no
    // watchdog is being consulted at all.
    const pending = [...scheduled];
    scheduled.length = 0;
    for (const check of pending) check();
    expect(handle.snapshot().missedPulseCount).toBe(0);
    expect(handle.snapshot().reachability).toBe('unknown');

    // Deliver the signal — releases the declared wait and resumes the watchdog.
    await handle.signal('human-response', { approved: true });
    const resumedSnapshot = handle.snapshot();
    expect(resumedSnapshot.status).toBe('running');
    expect(resumedSnapshot.declaredWait).toBeUndefined();
    expect(resumedSnapshot.reachability).toBe('reachable');

    releaseTool();
    const result = await monitoring;
    expect(result).toBe(true);
    expect(cleared.length).toBeGreaterThan(0);
  });

  it('classifies an unprompted park as a "signal" wait, not "review"', async () => {
    const sessionId = 'human-wait-signal-session';
    const runId = deriveRunId(sessionId, 0);
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const fakeEngine = createSessionEngine({ signal: async () => {} });

    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let signalToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });

    const parkingTool = createTool({
      name: 'requestHumanInput',
      description: 'Park waiting for an external signal',
      input: z.object({ signalName: z.string() }),
      execute: async (input, context) => {
        dispatchOnToolboxContext(context, new HumanWaitParkedEvent(input.signalName, runId));
        signalToolStarted();
        await toolGate;
        return 'released';
      },
    });

    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      engine: fakeEngine,
      runOptions: {
        generate: async () => ({
          content: '',
          toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'external-event' } }],
        }),
        toolbox: createToolbox([parkingTool]),
        maximumSteps: 1,
      },
    });

    const run = handle.run('start');
    await toolStarted;

    expect(handle.snapshot().declaredWait?.reason).toBe('signal');
    expect(handle.snapshot().declaredWait?.deadline).toBeUndefined();

    releaseTool();
    await run.result();
  });

  it('clears a still-outstanding park once the run settles even if session.signal() was never called', async () => {
    const sessionId = 'human-wait-unsignaled-session';
    const runId = deriveRunId(sessionId, 0);
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);

    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let signalToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });

    const parkingTool = createTool({
      name: 'requestHumanInput',
      description: 'Park waiting for human input',
      input: z.object({ signalName: z.string() }),
      execute: async (input, context) => {
        dispatchOnToolboxContext(context, new HumanWaitParkedEvent(input.signalName, runId));
        signalToolStarted();
        await toolGate;
        return 'released';
      },
    });

    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      runOptions: {
        generate: async () => ({
          content: 'done',
          toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'human-response' } }],
        }),
        toolbox: createToolbox([parkingTool]),
        maximumSteps: 1,
      },
    });

    const run = handle.run('start');
    await toolStarted;
    expect(handle.snapshot().status).toBe('waiting');

    // The run finishes on its own (maximumSteps: 1) without session.signal()
    // ever being called — the park bookkeeping must not be left stranded.
    releaseTool();
    await run.result();
    // The settle cleanup runs one extra microtask after `result()` resolves
    // (it is chained via `.catch().finally()`, not attached directly to the
    // same promise `result()` returns) — matches the pre-existing
    // `currentRun`/`currentRunId` cleanup's own timing in this file.
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.snapshot().status).toBe('created');
    expect(handle.snapshot().declaredWait).toBeUndefined();
  });
});
