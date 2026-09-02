import { createTool, ToolboxSettledEvent } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import type { OperativeHookMap } from './hooks';
import { createMockGenerate } from './test/index';
import type { GenerateResponse } from './types';

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

  // Regression: a code-review finding on the AB-204 pull request
  // (PRRT_kwDORvupsc6erisn) — the toolbox's `execute-start`/`settled`
  // listeners used to be bound to `abortController.signal`, so `abort()`
  // stripped them immediately, synchronously, on the same tick — before an
  // uncooperative tool already in flight (one that doesn't observe its own
  // cancellation) could ever emit its `settled` event. `inFlightTools`
  // would then never reach zero and `awaitToolDrain()` would hang forever.
  it('does not hang closed() forever after abort() while a tool call is in flight (armorer settles the cancelled call asynchronously)', async () => {
    // Armorer settles an in-flight call promptly once its execution signal
    // aborts — it does not wait for the tool's own promise — but that
    // `settled` event still arrives on a LATER microtask than the
    // synchronous `abortController.abort()` call. Binding this run's own
    // `execute-start`/`settled` listeners to `abortController.signal` (the
    // pre-fix shape) tore them down on the exact same, earlier tick,
    // missing that later `settled` event entirely and hanging
    // `awaitToolDrain()`/`closed()` forever — verified by temporarily
    // reintroducing the signal binding, which makes this same test time out.
    let notifyToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      notifyToolStarted = resolve;
    });
    const neverSettlesOnItsOwn = new Promise<never>(() => {});
    const stubbornTool = createTool({
      name: 'stubborn_tool',
      description: 'Ignores cancellation; only armorer settles this call',
      input: z.object({}),
      execute: async () => {
        notifyToolStarted?.();
        await neverSettlesOnItsOwn;
        return { done: true };
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

    // Armorer's own asynchronous cancellation-settlement of the in-flight
    // call is what drains `inFlightTools` here (the tool's own promise
    // never resolves) — `closed()` must observe it rather than hang.
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
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
