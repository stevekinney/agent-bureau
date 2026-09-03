import { createTool, ToolboxProgressEvent, ToolboxSettledEvent } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createDefaultRuntimeServices, createManualRuntimeServices, HookRegistry } from 'lifecycle';
import { z } from 'zod';

import type { MutableChildRunRegistry } from './child-run';
import { createChildRunRegistry } from './child-run';
import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import { ToolStartedBubbleEvent } from './events';
import type { OperativeHookMap } from './hooks';
import { createMockGenerate } from './test/index';
import type { CleanupAcknowledgement, GenerateResponse } from './types';

/**
 * AB-204: `ActiveRun.closed()` — the cleanup acknowledgement. Colocated with
 * `create-run.ts` per this issue's Coordinator ruling on test file location.
 */

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

describe('ActiveRun.closed()', () => {
  it('resolves { status: "completed" } once the result promise settles normally', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // Call closed() before the run settles, so the not-required fast path
    // (first-call-already-terminal) does not apply — this exercises the
    // general "await the drain" path AC1 describes.
    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });

  it('resolves { status: "not-required" } immediately when first called after the run already settled with nothing tracked in flight', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    await activeRun.result;
    // Give closed()'s internal settlement tracker a turn to observe it.
    await Promise.resolve();

    expect(await activeRun.closed()).toEqual({ status: 'not-required' });
  });

  it('does not resolve not-required when closed() is first called before the run settles', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const pending = activeRun.closed();
    await activeRun.result;

    expect(await pending).toEqual({ status: 'completed' });
  });

  it('disqualifies the not-required fast path once abort() has been called, even after the run settles', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    const generate = createMockGenerate([textResponse('should not run')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
    });
    activeRun.abort('cancelled');

    const result = await activeRun.result;
    expect(result.finishReason).toBe('aborted');
    await Promise.resolve();

    expect(await activeRun.closed()).toEqual({ status: 'completed' });
  });

  // Regression: a code-review finding on the AB-204 pull request —
  // `cancelRequested` alone tracks only a direct `abort()` call, missing a
  // cancellation delivered through `RunOptions.signal` (which
  // `AgentRunContext.signal`/`createAgent` forward without ever calling
  // this ActiveRun's own `abort()`).
  it('disqualifies the not-required fast path when the run was cancelled through RunOptions.signal rather than abort()', async () => {
    const controller = new AbortController();
    const generate = createMockGenerate([textResponse('should not run')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
    });

    controller.abort('cancelled via caller signal');
    const result = await activeRun.result;
    expect(result.finishReason).toBe('aborted');
    await Promise.resolve();

    expect(await activeRun.closed()).not.toEqual({ status: 'not-required' });
  });

  // Regression: a code-review finding on the AB-204 pull request — a
  // signal-only cancellation must route through abort() the moment it
  // fires (not merely be observed later), including when the signal was
  // already aborted before this ActiveRun was even created.
  it('routes an already-aborted RunOptions.signal into abort() too, even when the signal was aborted before this ActiveRun was even created', async () => {
    const controller = new AbortController();
    controller.abort('already gone before creation');
    const generate = createMockGenerate([textResponse('should not run')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
    });

    const result = await activeRun.result;
    expect(result.finishReason).toBe('aborted');
    await Promise.resolve();

    expect(await activeRun.closed()).not.toEqual({ status: 'not-required' });
  });

  it('calling closed() twice after settlement returns the identical object by reference', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const first = await activeRun.closed();
    const second = await activeRun.closed();
    expect(second).toBe(first);
  });

  it('resolves { status: "unresolved", reason: "timed-out" } for a call whose own signal fires before settlement, while a concurrent signal-free call still observes the real settlement', async () => {
    let releaseGenerate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGenerate = resolve));
    const generate = async (): Promise<GenerateResponse> => {
      await gate;
      return textResponse('done');
    };
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const controller = new AbortController();
    const timedOutCall = activeRun.closed({ signal: controller.signal });
    const signalFreeCall = activeRun.closed();

    controller.abort();
    expect(await timedOutCall).toEqual({ status: 'unresolved', reason: 'timed-out' });

    releaseGenerate();
    const real = await signalFreeCall;
    expect(real).toEqual({ status: 'completed' });

    // A later call observes the identical cached settlement, never the
    // abandoned wait's outcome.
    expect(await activeRun.closed()).toBe(real);
  });

  it('resolves { status: "unresolved", reason: "timed-out" } immediately for an already-aborted signal', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const controller = new AbortController();
    controller.abort();
    expect(await activeRun.closed({ signal: controller.signal })).toEqual({
      status: 'unresolved',
      reason: 'timed-out',
    });

    await activeRun.result;
  });

  it('classifies a genuine rejection of the result promise as { status: "failed" }', async () => {
    const failure = new Error('toolbox cleanup listener threw');
    const generate = createMockGenerate([textResponse('done')]);
    // A toolbox whose `toObservable()`/`addEventListener()` satisfy the
    // forwarding this module wires up, but whose `execute-start` cleanup
    // throws — forcing `complete()` (run inside `.finally()`) to throw,
    // which rejects the public `result` promise. This is the one path that
    // exercises closed()'s `failed` classification for the in-memory loop,
    // which otherwise always resolves `result` (never rejects it).
    const toolbox = {
      toObservable: () => ({ subscribe: () => ({ unsubscribe(): void {}, closed: false }) }),
      addEventListener: () => () => {
        throw failure;
      },
    } as unknown as ReturnType<typeof createTestToolbox>;
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const closedAcknowledgement = activeRun.closed();
    let rejection: unknown;
    try {
      await activeRun.result;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBe(failure);
    expect(await closedAcknowledgement).toEqual({ status: 'failed', error: failure });
  });

  it('tracks a real tool call through execute-start/settled without breaking the completed classification', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('done'),
    ]);
    const toolbox = createTestToolbox([weatherTool]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });

  // Regression: a code-review finding on the AB-204 pull request — armorer
  // can emit a `settled` toolbox event with no preceding `execute-start`
  // (a tool call cancelled before execution begins, e.g. an already-aborted
  // signal), which would otherwise drive the `inFlightTools` counter
  // negative and corrupt `hasInFlightWork()`'s later reads. The counter is
  // clamped at zero so a "settled without a start" is a no-op, not a debt
  // future real in-flight work can never climb out of.
  it('does not corrupt in-flight tool tracking when the toolbox emits settled with no preceding execute-start', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([weatherTool]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const spuriousCall = {
      id: 'spurious-call-id',
      name: weatherTool.name,
      arguments: { location: 'nowhere' },
    };
    expect(() => {
      toolbox.dispatchEvent(new ToolboxSettledEvent({ tool: weatherTool, call: spuriousCall }));
      toolbox.dispatchEvent(new ToolboxSettledEvent({ tool: weatherTool, call: spuriousCall }));
    }).not.toThrow();

    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });

  // AB-289: a hand-constructed (or otherwise legacy) `settled` event that
  // carries no `callbackCompletion` field drains `inFlightTools`
  // synchronously, right in the listener, exactly as it did before this
  // issue — it must not be deferred by a spurious microtask.
  it('drains inFlightTools synchronously for an owned settled event with no callbackCompletion', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('done'),
    ]);
    const toolbox = createTestToolbox([weatherTool]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    let spoofed = false;
    activeRun.addEventListener('tool.started', (event) => {
      if (spoofed) return;
      spoofed = true;
      // Simulate a hand-constructed/legacy `settled` event for the SAME
      // call id armorer just started, carrying no `callbackCompletion`.
      // `ownerId` matches this run's own id (AB-290) — the same identity
      // `onSettled` requires to recognize the event as owned — so it
      // drains synchronously via the fallback `else release()` branch,
      // not `Promise.resolve().then(...)`.
      toolbox.dispatchEvent(
        new ToolboxSettledEvent({
          tool: weatherTool,
          call: { id: event.toolCallId, name: weatherTool.name, arguments: {} },
          result: { temperature: 0, location: 'spoofed' },
          ownerId: activeRun.snapshot().id,
        }),
      );
    });

    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });

  // Regression: a code-review finding on the AB-204 pull request
  // (PRRT_kwDORvupsc6elvRf) — a `failFast` parallel tool batch can settle
  // `result` (via `makeErrorResult`, as soon as one call in the batch
  // rejects) while a sibling call in the same batch is still executing.
  // `slowTool` deliberately never observes its own cancellation signal, so
  // it stays "in flight" until the test releases it — matching an
  // uncooperative real-world tool, not merely a timing coincidence.
  it('does not resolve completed while a sibling tool call in a failFast batch is still in flight, and resolves once it drains', async () => {
    let releaseSlowTool: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlowTool = resolve;
    });
    const slowTool = createTool({
      name: 'slow_tool',
      description: 'Stays in flight until the test releases it',
      input: z.object({}),
      execute: async () => {
        await slowGate;
        return { done: true };
      },
    });
    const failingTool = createTool({
      name: 'failing_tool',
      description: 'Rejects immediately',
      input: z.object({}),
      execute: async () => {
        throw new Error('boom');
      },
    });

    const generate = createMockGenerate([
      toolCallResponse([
        { name: 'slow_tool', arguments: {} },
        { name: 'failing_tool', arguments: {} },
      ]),
    ]);
    const toolbox = createTestToolbox([slowTool, failingTool]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      executeOptions: { errorMode: 'failFast' },
    });

    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('error');

    let settledFlag = false;
    void closedAcknowledgement.then(() => {
      settledFlag = true;
    });
    // `awaitToolDrain()` genuinely never settles until `slow_tool`'s own
    // `settled` event arrives (its promise is only ever resolved from
    // `onSettled`, never on a timer) — so this isn't a fixed-tick race
    // against the fix: without the fix `resolveOutcome` reaches `completed`
    // in a handful of microtask hops regardless, while with the fix it
    // stays pending no matter how many turns the queue is flushed. Flush
    // generously to make that contrast unambiguous either way.
    for (let tick = 0; tick < 25; tick++) {
      await Promise.resolve();
    }
    expect(settledFlag).toBe(false);

    releaseSlowTool?.();

    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    expect(settledFlag).toBe(true);
  });

  // Regression: a code-review finding on the AB-204 pull request
  // (PRRT_kwDORvupsc6erisq) — a caller can supply the SAME `Toolbox`
  // instance to more than one concurrent run (`create-agent.ts` explicitly
  // preserves the supplied toolbox across `.run()` calls). Without scoping
  // `inFlightTools` to calls this run itself dispatched, run A's `closed()`
  // would also wait on run B's unrelated, still-executing tool call.
  it('does not wait on another run sharing the same toolbox', async () => {
    let releaseOtherRunTool: (() => void) | undefined;
    const otherRunGate = new Promise<void>((resolve) => {
      releaseOtherRunTool = resolve;
    });
    const sharedTool = createTool({
      name: 'shared_tool',
      description: 'Used by two concurrent runs on the same toolbox',
      input: z.object({}),
      execute: async () => {
        await otherRunGate;
        return { done: true };
      },
    });
    const toolbox = createTestToolbox([sharedTool]);

    // Run B: starts a call on the shared toolbox and never lets it settle
    // for the duration of this test.
    createActiveRun({
      generate: createMockGenerate([toolCallResponse([{ name: 'shared_tool', arguments: {} }])]),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // Run A: completes cleanly with no tool calls of its own, on the SAME
    // toolbox instance run B is still using.
    const generate = createMockGenerate([textResponse('done')]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');

    // Run A owns no in-flight tool calls, so its own closed() must settle
    // promptly even though run B's `shared_tool` call is still executing on
    // the same toolbox.
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });

    releaseOtherRunTool?.();
  });

  // AB-290 acceptance test: armorer mints an `executionId` per execution
  // and echoes an optional caller-supplied `ownerId` on every event for
  // that execution; operative stamps its own run id as `ownerId` on every
  // `Toolbox.execute()` call and filters both in-flight accounting AND the
  // curated `tool.*` bubble events by it. This is the case
  // `ownedToolCallIds`/`ToolCall.id` tracking could never handle: the
  // PROVIDER issues the exact same `ToolCall.id` to two concurrent runs
  // sharing one toolbox — a real possibility since providers assign ids
  // independently per conversation, with no cross-run coordination.
  it('scopes accounting and tool.* bubble events to the owning run when two concurrent runs share one toolbox and the provider issues them the SAME ToolCall.id', async () => {
    const gates = new Map<'a' | 'b', { promise: Promise<void>; release: () => void }>();
    for (const owner of ['a', 'b'] as const) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(owner, { promise, release });
    }
    const sharedTool = createTool({
      name: 'shared_tool',
      description: 'Used by two concurrent runs on one shared toolbox',
      input: z.object({ owner: z.enum(['a', 'b']) }),
      execute: async ({ owner }) => {
        await gates.get(owner)!.promise;
        return { owner };
      },
    });
    const toolbox = createTestToolbox([sharedTool]);
    const sharedCallId = 'provider-issued-call-id';

    const runA = createActiveRun({
      runId: 'run-a',
      generate: createMockGenerate([
        toolCallResponse([{ id: sharedCallId, name: 'shared_tool', arguments: { owner: 'a' } }]),
        textResponse('done'),
      ]),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });
    const runB = createActiveRun({
      runId: 'run-b',
      generate: createMockGenerate([
        toolCallResponse([{ id: sharedCallId, name: 'shared_tool', arguments: { owner: 'b' } }]),
        textResponse('done'),
      ]),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const startedByRun: Record<'a' | 'b', string[]> = { a: [], b: [] };
    const settledByRun: Record<'a' | 'b', string[]> = { a: [], b: [] };
    runA.addEventListener('tool.started', (event) => startedByRun.a.push(event.toolCallId));
    runA.addEventListener('tool.settled', (event) => settledByRun.a.push(event.toolCallId));
    runB.addEventListener('tool.started', (event) => startedByRun.b.push(event.toolCallId));
    runB.addEventListener('tool.settled', (event) => settledByRun.b.push(event.toolCallId));

    // Let both calls reach the toolbox before either settles, so both are
    // genuinely in flight — concurrently, on the SAME toolbox, with the
    // SAME `ToolCall.id` — at the same time.
    for (let tick = 0; tick < 20; tick++) {
      await Promise.resolve();
    }

    // Each run sees exactly one `tool.started` for its own call, never the
    // other run's, despite the shared id.
    expect(startedByRun.a).toEqual([sharedCallId]);
    expect(startedByRun.b).toEqual([sharedCallId]);
    // Neither run's `closed()` waits on the OTHER run's still-executing
    // call — each owns only its own in-flight accounting.
    const closedA = runA.closed();
    let closedAResolved = false;
    void closedA.then(() => {
      closedAResolved = true;
    });
    for (let tick = 0; tick < 10; tick++) {
      await Promise.resolve();
    }
    expect(closedAResolved).toBe(false);

    gates.get('a')!.release();
    expect(await closedA).toEqual({ status: 'completed' });
    const resultA = await runA.result;
    expect(resultA.finishReason).toBe('stop-condition');

    // Run A's own settlement never leaked into run B's bubble stream.
    expect(settledByRun.a).toEqual([sharedCallId]);
    expect(settledByRun.b).toEqual([]);

    gates.get('b')!.release();
    const resultB = await runB.result;
    expect(resultB.finishReason).toBe('stop-condition');

    // Each run saw exactly its own settlement, never a duplicate and never
    // the other run's.
    expect(startedByRun.a).toEqual([sharedCallId]);
    expect(startedByRun.b).toEqual([sharedCallId]);
    expect(settledByRun.a).toEqual([sharedCallId]);
    expect(settledByRun.b).toEqual([sharedCallId]);
  });

  // Regression: a code-review finding on the AB-204 pull request
  // (PRRT_kwDORvupsc6erisn) — the toolbox's `execute-start`/`settled`
  // listeners used to be bound to `abortController.signal`, so `abort()`
  // stripped them immediately, synchronously, on the same tick — before an
  // uncooperative tool already in flight (one that doesn't observe its own
  // cancellation) could ever emit its `settled` event. `inFlightTools`
  // would then never reach zero and `awaitToolDrain()` would hang forever.
  // AB-289: armorer's `settled` toolbox event fires as soon as the
  // cancellation race against the execution signal settles — not once the
  // tool callback's own returned promise has genuinely settled. Before this
  // issue, `resolveOutcome` treated that early event as proof the callback
  // was done, so `closed()` could report `completed` while `stubborn_tool`'s
  // callback was still running and still touching run-owned resources. The
  // fix: `onSettled` defers `inFlightTools`'s decrement until the event's
  // `callbackCompletion` promise (armorer's `ExecutionHandle.whenSettled()`)
  // resolves, so `closed()` genuinely stays pending until the callback
  // returns — and, with a `signal`-bounded call, reports `unresolved` if the
  // caller's own deadline elapses first.
  it('does not report closed() completed until an abort-ignoring tool callback genuinely returns, and reports unresolved for a bounded caller whose deadline elapses first (AB-289)', async () => {
    // Armorer settles the cancellation race for an in-flight call promptly
    // once its execution signal aborts — it does not wait for the tool's
    // own promise — but that `settled` event still arrives on a LATER
    // microtask than the synchronous `abortController.abort()` call.
    // Binding this run's own `execute-start`/`settled` listeners to
    // `abortController.signal` (a shape this issue predates and does not
    // reintroduce) would tear them down on the exact same, earlier tick,
    // missing that later `settled` event entirely and hanging
    // `awaitToolDrain()`/`closed()` forever.
    let notifyToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      notifyToolStarted = resolve;
    });
    let releaseStubbornTool: ((value: { done: true }) => void) | undefined;
    const stubbornToolGate = new Promise<{ done: true }>((resolve) => {
      releaseStubbornTool = resolve;
    });
    const stubbornTool = createTool({
      name: 'stubborn_tool',
      description: 'Ignores cancellation; keeps running until the test releases it',
      input: z.object({}),
      execute: async () => {
        notifyToolStarted?.();
        return stubbornToolGate;
      },
    });
    const generate = createMockGenerate([
      toolCallResponse([{ name: 'stubborn_tool', arguments: {} }]),
    ]);
    const toolbox = createTestToolbox([stubbornTool]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // Wait until the tool's own execute() has actually started (not just a
    // fixed tick count) before aborting, so the run is genuinely aborted
    // while a real call is in flight rather than before it was dispatched.
    await toolStarted;

    activeRun.abort('stop');

    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('aborted');

    let settledFlag = false;
    void closedAcknowledgement.then(() => {
      settledFlag = true;
    });
    // `stubbornToolGate` is only ever resolved by `releaseStubbornTool()`,
    // so `resolveOutcome` genuinely cannot reach `completed` while it's
    // pending, at any tick count — this is the assertion that is red on the
    // pre-AB-289 baseline (armorer's cancellation-race `settled` event
    // alone used to be enough for `resolveOutcome` to call this drained).
    for (let tick = 0; tick < 25; tick++) {
      await Promise.resolve();
    }
    expect(settledFlag).toBe(false);

    // A caller with its own bounded wait must not hang either — it observes
    // `unresolved`/`timed-out` once its deadline elapses, driven by a
    // manual clock rather than a real sleep, while the callback keeps
    // running underneath and the concurrent signal-free call above stays
    // pending.
    const manualClock = createManualRuntimeServices();
    const deadlineController = new AbortController();
    manualClock.timers.setTimeout(() => deadlineController.abort(), 1_000);
    const boundedCall = activeRun.closed({ signal: deadlineController.signal });
    await manualClock.advance(1_000);
    expect(await boundedCall).toEqual({ status: 'unresolved', reason: 'timed-out' });
    expect(settledFlag).toBe(false);

    releaseStubbornTool?.({ done: true });

    // Once the callback genuinely returns, the real, signal-free `closed()`
    // call observes the true settlement.
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    expect(settledFlag).toBe(true);
  });

  // Regression: a code-review finding on the AB-204 pull request
  // (PRRT_kwDORvupsc6ekmeT) — `onRunComplete`/`onRunAbort`/`onRunError`/
  // `onLLMInput`/`onLLMOutput` all fire fire-and-forget via
  // `runHookSilently`, so `result` can settle while one is still running.
  it('does not resolve completed while an onRunComplete hook is still running, and resolves once it settles', async () => {
    let releaseHook: (() => void) | undefined;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onRunComplete', async () => {
      await hookGate;
    });

    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');

    let settledFlag = false;
    void closedAcknowledgement.then(() => {
      settledFlag = true;
    });
    // Same reasoning as the tool-drain regression above: `hookGate` is only
    // ever resolved by `releaseHook()`, so `resolveOutcome` genuinely
    // cannot reach `completed` while it's pending, at any tick count.
    for (let tick = 0; tick < 25; tick++) {
      await Promise.resolve();
    }
    expect(settledFlag).toBe(false);

    releaseHook?.();

    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    expect(settledFlag).toBe(true);
  });
});

/**
 * AB-211: `ActiveRun.closed()` awaits every registered child's own
 * `closed()` (AB-50's `ChildRunRegistry`, wired via `attachClosed` in
 * `child-run.ts`) before reporting `completed` — not merely the child's
 * terminal `result()`. Fake children are constructed directly against the
 * registry (`register`/`attachClosed`/`settle`), never through
 * `dispatchChildRun`, so each child's settlement is fully test-controlled
 * via manually resolved promises — no real sleeps, matching this issue's
 * testing plan.
 */
describe('ActiveRun.closed() awaits registered children (AB-211)', () => {
  function deferredAcknowledgement(): {
    promise: Promise<CleanupAcknowledgement>;
    resolve: (value: CleanupAcknowledgement) => void;
  } {
    let resolveAcknowledgement!: (value: CleanupAcknowledgement) => void;
    const promise = new Promise<CleanupAcknowledgement>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    return { promise, resolve: resolveAcknowledgement };
  }

  async function flushTicks(count = 25): Promise<void> {
    for (let tick = 0; tick < count; tick++) {
      await Promise.resolve();
    }
  }

  function registerFakeChild(
    registry: MutableChildRunRegistry,
    id: string,
    abort: (reason?: string) => void = () => undefined,
  ): { resolve: (value: CleanupAcknowledgement) => void } {
    registry.register({ id, parentId: 'parent', agentName: 'child', durable: false, abort });
    const child = deferredAcknowledgement();
    registry.attachClosed(id, () => child.promise);
    return { resolve: child.resolve };
  }

  it('does not resolve completed while two live children are both still cleanup-pending', async () => {
    const registry = createChildRunRegistry();
    const child1 = registerFakeChild(registry, 'child-1');
    const child2 = registerFakeChild(registry, 'child-2');

    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      childRegistry: registry,
    });

    await activeRun.result;
    const closedAcknowledgement = activeRun.closed();

    let settledFlag = false;
    void closedAcknowledgement.then(() => {
      settledFlag = true;
    });

    await flushTicks();
    expect(settledFlag).toBe(false);

    child1.resolve({ status: 'completed' });
    await flushTicks();
    expect(settledFlag).toBe(false);

    child2.resolve({ status: 'completed' });
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
    expect(settledFlag).toBe(true);
  });

  it('resolves only once a still-running child also settles, after a sibling aborts and settles quickly', async () => {
    const registry = createChildRunRegistry();
    const quickChild = registerFakeChild(registry, 'quick-child');
    const slowChild = registerFakeChild(registry, 'slow-child');

    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      childRegistry: registry,
    });

    await activeRun.result;
    const closedAcknowledgement = activeRun.closed();

    // The quick child aborts and settles immediately.
    quickChild.resolve({ status: 'completed' });

    let settledFlag = false;
    void closedAcknowledgement.then(() => {
      settledFlag = true;
    });
    await flushTicks();
    expect(settledFlag).toBe(false);

    slowChild.resolve({ status: 'completed' });
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });

  it('resolves not-required immediately for a zero-children run, identically to before this issue, even when a childRegistry is supplied but empty', async () => {
    const registry = createChildRunRegistry();

    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      childRegistry: registry,
    });

    await activeRun.result;
    await Promise.resolve();

    expect(await activeRun.closed()).toEqual({ status: 'not-required' });
  });

  it('still waits on a child whose own result() already settled but whose closed() is still pending', async () => {
    const registry = createChildRunRegistry();
    const child = registerFakeChild(registry, 'child-1');
    registry.settle('child-1', 'completed');
    expect(registry.children()[0]?.status).toBe('completed');

    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      childRegistry: registry,
    });

    await activeRun.result;
    const closedAcknowledgement = activeRun.closed();

    let settledFlag = false;
    void closedAcknowledgement.then(() => {
      settledFlag = true;
    });
    await flushTicks();
    expect(settledFlag).toBe(false);

    child.resolve({ status: 'completed' });
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });

  it('aborting one child via abortChild does not affect an untouched sibling settling on its own', async () => {
    const registry = createChildRunRegistry();
    let child1Aborted = false;
    let child2Aborted = false;
    const child1 = registerFakeChild(registry, 'child-1', () => {
      child1Aborted = true;
    });
    const child2 = registerFakeChild(registry, 'child-2', () => {
      child2Aborted = true;
    });

    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      childRegistry: registry,
    });

    await activeRun.result;
    const closedAcknowledgement = activeRun.closed();

    registry.abortChild('child-1', 'no longer needed');
    expect(child1Aborted).toBe(true);
    expect(child2Aborted).toBe(false);

    child1.resolve({ status: 'completed' });
    await flushTicks();

    let settledFlag = false;
    void closedAcknowledgement.then(() => {
      settledFlag = true;
    });
    await flushTicks();
    expect(settledFlag).toBe(false);
    expect(child2Aborted).toBe(false);

    child2.resolve({ status: 'completed' });
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });
});

// AB-214: the in-memory `createActiveRun` liveness wiring records a
// tool-progress pulse only for a tool call THIS run itself dispatched (the
// same `ownerId`-based guard `onExecuteStart`/`onSettled` use since
// AB-290 — see the comment on the `progress` listener in create-run.ts).
describe('AB-214: tool-progress pulses feed the liveness snapshot', () => {
  it('records a tool-progress evidence entry when an owned tool call reports progress', async () => {
    // The evidence has to be observed WHILE the call is in flight: `endToolCall`
    // tears the tool watchdog down (and with it, its evidence) the moment the
    // in-flight count returns to zero, so a snapshot taken after the tool
    // settles would never see the pulse.
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const reportingTool = createTool({
      name: 'reporting_tool',
      description: 'Reports progress mid-execution',
      input: z.object({}),
      execute: async () => {
        await toolGate;
        return { done: true };
      },
    });
    const toolbox = createTestToolbox([reportingTool]);

    const activeRun = createActiveRun({
      generate: createMockGenerate([
        toolCallResponse([{ id: 'call-1', name: 'reporting_tool', arguments: {} }]),
        textResponse('done'),
      ]),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // Let the call reach the toolbox before the progress event arrives.
    // Deterministic microtask draining (no real timer) — matches the
    // `closed()` regression tests above in this same file.
    for (let tick = 0; tick < 50; tick++) {
      await Promise.resolve();
    }
    toolbox.dispatchEvent(
      new ToolboxProgressEvent({
        tool: reportingTool,
        call: { id: 'call-1', name: 'reporting_tool', arguments: {} },
        percent: 50,
        message: 'halfway',
        // AB-290: matches this run's own id so `onToolProgress` recognizes
        // the event as owned — see the identical `onSettled`/`onExecuteStart`
        // guard.
        ownerId: activeRun.snapshot().id,
      }),
    );

    const inFlightEvidence = activeRun.snapshot().evidence;
    const toolProgressEntries = inFlightEvidence.filter(
      (entry) => entry.source === 'tool-progress',
    );
    expect(toolProgressEntries).toHaveLength(1);

    releaseTool?.();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
  });
});

// AB-214 review (PRRT_kwDORvupsc6es7pl): a snapshot labeled `projection:
// 'redacted'` must not carry the raw `RunResult` — its full conversation,
// tool arguments/results, and arbitrary errors — since every standalone
// run's projection is `'redacted'` permanently (AB-88) and nothing produces
// `'privileged'`. `toRedactedRunResultSummary` (types.test.ts) covers the
// redaction itself; this covers create-run.ts actually calling it.
describe('AB-214: settle() redacts the RunResult before it reaches the snapshot', () => {
  it('exposes only finishReason/hasError, never the conversation or tool content', async () => {
    const activeRun = createActiveRun({
      generate: createMockGenerate([textResponse('the secret is 42')]),
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('the secret is 42');

    const snapshot = activeRun.snapshot();
    expect(snapshot.projection).toBe('redacted');
    expect(snapshot.result).toEqual({ finishReason: 'stop-condition', hasError: false });
  });
});

describe('createActiveRun: AB-92/AB-252 RuntimeServices resolution', () => {
  it('resolves options.runtime ?? createDefaultRuntimeServices() exactly once and snapshots it into the run: a manual runtime pinned to a fixed origin produces tool-event timestamps derived from that origin, not the real clock', async () => {
    const runtime = createManualRuntimeServices({ origin: '2024-03-01T00:00:00.000Z' });
    await runtime.advance(5000);

    const events: ToolStartedBubbleEvent[] = [];
    const activeRun = createActiveRun({
      generate: createMockGenerate([toolCallResponse([weatherToolCall()]), textResponse('done')]),
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runtime,
    });
    activeRun.addEventListener('tool.started', (event) => events.push(event));

    await activeRun.result;

    expect(events).toHaveLength(1);
    // The pinned origin plus the 5-second advance, in epoch milliseconds —
    // never a value anywhere near the real `Date.now()` at test-run time.
    expect(events[0]?.startedAt).toBe(Date.parse('2024-03-01T00:00:05.000Z'));
  });

  it("rebinds the standalone-run identifier seam onto the resolved runtime's identifiers.next('run'), per AB-214's coordinator-ruling promise", async () => {
    const runtime = createManualRuntimeServices();

    const first = createActiveRun({
      generate: createMockGenerate([textResponse('one')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runtime,
    });
    await first.result;

    const second = createActiveRun({
      generate: createMockGenerate([textResponse('two')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runtime,
    });
    await second.result;

    expect(first.snapshot().id).toBe('run-1');
    expect(second.snapshot().id).toBe('run-2');
  });

  it('a caller-supplied runId is always used as-is and never consumes the runtime identifier seam', async () => {
    const runtime = createManualRuntimeServices();

    const activeRun = createActiveRun({
      generate: createMockGenerate([textResponse('done')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runtime,
      runId: 'caller-supplied-run-id',
    });
    await activeRun.result;

    expect(activeRun.snapshot().id).toBe('caller-supplied-run-id');
    // The `run` kind counter was never advanced — proves the identifier
    // seam was never reached for a caller-supplied id.
    expect(runtime.identifiers.next('run')).toBe('run-1');
  });

  it('every existing call site that omits runtime behaves exactly as it did on the baseline: it still resolves a working default instance', async () => {
    const activeRun = createActiveRun({
      generate: createMockGenerate([textResponse('done')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
    // A real, unconfigured `createDefaultRuntimeServices()`-minted id shape.
    expect(activeRun.snapshot().id).toMatch(/^run-\d+-[0-9a-f-]{36}$/);
  });

  it('two runs constructed with no runtime option each get an independent default instance (createDefaultRuntimeServices returns a fresh instance per call)', () => {
    const first = createDefaultRuntimeServices();
    const second = createDefaultRuntimeServices();
    expect(first.identifiers.next('run')).not.toBe(second.identifiers.next('run'));
  });
});
