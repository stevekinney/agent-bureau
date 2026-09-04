/**
 * Shared, mode-neutral helpers for the lifecycle-contract adapters (AB-268).
 * Nothing here reaches into a private map, a package-private import path, or
 * anything outside the owning package's `exports` map — see
 * `import-boundary.test.ts` in this directory, which pins that rule.
 */
import type {
  AnyToolbox,
  ChildRunHandle,
  DispatchChildRunOptions,
  GenerateFunction,
  GenerateResponse,
  MutableChildRunRegistry,
  RunEvent,
  RunnableAgent,
  RuntimeServices,
} from '@lostgradient/operative';
import { dispatchChildRun } from '@lostgradient/operative';
import type { AgentRunLivenessSnapshot } from '@lostgradient/operative/liveness';
import type {
  ClosableRun,
  EventRecorder,
  ReactiveSourceSubject,
  ResourceScope,
} from '@lostgradient/operative/test';
import {
  createEventRecorder,
  createManualRuntimeServices,
  createResourceScope,
} from '@lostgradient/operative/test';
import { createToolbox } from 'armorer';
import type { AgentDefinitions } from 'bureau';
import {
  type BureauTestHarness,
  createBureauTestHarness,
  createMemoryStorageFixture,
} from 'bureau/test';

import type { LifecycleCapability, UnsupportedCapabilityOutcome } from './runner';

/**
 * Builds an `unsupported(capability)` outcome factory scoped to one mode,
 * shared by every adapter so the "supports() and the returned outcome must
 * agree" bookkeeping lives in one place rather than four. Throws if asked
 * for a capability the adapter never declared an owning issue for — a
 * programmer error, not a real "unsupported" outcome.
 */
export function createUnsupportedOutcomeFactory(
  mode: string,
  owners: Readonly<Partial<Record<LifecycleCapability, string>>>,
): (capability: LifecycleCapability) => UnsupportedCapabilityOutcome {
  return (capability) => {
    const owningIssue = owners[capability];
    if (!owningIssue) {
      throw new Error(`${mode}: '${capability}' has no registered owningIssue`);
    }
    return { capability, mode, owningIssue };
  };
}

/**
 * Wraps an `AgentRun`/`ChildRunHandle`'s event stream to yield only the
 * named event types — `EventRecorder.attachIterable` (unlike `attach`) has
 * no `eventTypes` filter parameter of its own, so a sequential-path scenario
 * driven through an async-iterable handle filters here to get the same
 * exact, stable `assertSequence` target `attach`'s own filter gives the
 * direct-`ActiveRun` adapter. Still fully drains the source (never leaves
 * an event unconsumed), so `attachIterable`'s own deferred-tracked loop
 * still resolves once the source completes.
 */
export function filterRunEvents(
  source: AsyncIterable<RunEvent>,
  allowed: ReadonlySet<RunEvent['type']>,
): AsyncIterable<RunEvent> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<RunEvent>> {
          for (;;) {
            const result = await iterator.next();
            if (result.done) return result;
            if (allowed.has(result.value.type)) return result;
          }
        },
      };
    },
  };
}

/** A fresh `ResourceScope` with one `ClosableRun` already registered under `identifier`. */
export function scopeForRun(
  label: string,
  runtime: RuntimeServices,
  run: ClosableRun,
  identifier = 'r',
): ResourceScope {
  const scope = createResourceScope(label, runtime);
  scope.register({ kind: 'run', identifier, run });
  return scope;
}

/** The minimal `AgentRun`-shaped surface the two drivers below need — satisfied structurally by `AgentRun`, a session run, and a Bureau-owned run alike. */
export interface SequentialRun extends ClosableRun, AsyncIterable<RunEvent> {
  result(): Promise<{ readonly finishReason: string; readonly error?: unknown }>;
}

/**
 * Waits (bounded, no wall-clock sleep) past an eager-wrapper's bootstrap
 * window — a session-owned or Bureau-owned run's `snapshot().id` can
 * briefly reflect a placeholder (the owning session's id, or the catalog
 * agent's bare name) before its real, derived run id settles, since both
 * return their wrapper handle synchronously, before that id reservation
 * resolves — then returns the settled id. Every scenario that reads
 * `run.snapshot().id` to correlate a dispatched child, on a mode where this
 * applies, uses this instead of an immediate synchronous read.
 */
export async function stableRunId(run: { snapshot(): { readonly id: string } }): Promise<string> {
  const bootstrapId = run.snapshot().id;
  for (let attempt = 0; attempt < 50 && run.snapshot().id === bootstrapId; attempt++) {
    await Promise.resolve();
  }
  return run.snapshot().id;
}

/**
 * Creates a fresh `ManualRuntimeServices`, builds `run` over it, registers
 * `run` on a scope, runs `use`, then closes the scope — shared across every
 * adapter's single-resource scenarios so a mode only ever writes the part
 * that actually differs: how `run` gets built and what `use` asserts.
 */
export async function withRun<TRun extends ClosableRun, TResult>(
  label: string,
  build: (runtime: RuntimeServices) => TRun,
  use: (run: TRun, runtime: RuntimeServices) => Promise<TResult>,
): Promise<TResult> {
  const runtime = createManualRuntimeServices();
  const run = build(runtime);
  const scope = scopeForRun(label, runtime, run);
  const result = await use(run, runtime);
  await scope.close();
  return result;
}

/** The `run.started`/`run.completed` pair every terminal-success scenario filters its event trace to. Shared so `SUCCESS_EVENTS`/`ABORT_EVENTS` are defined once, not reconstructed identically in every adapter. */
export const SUCCESS_EVENTS: ReadonlySet<RunEvent['type']> = new Set([
  'run.started',
  'run.completed',
]);
/** The `run.started`/`run.aborted` pair every abort-path scenario filters its event trace to. */
export const ABORT_EVENTS: ReadonlySet<RunEvent['type']> = new Set(['run.started', 'run.aborted']);

/** The minimal surface `observeReadyAndRunning` needs from an already-built run: a synchronous `snapshot().status` read and a `subscribeSnapshot` push feed, alongside `SequentialRun`'s `result()`. */
export interface ObservableRun extends SequentialRun {
  snapshot(): { readonly status: string };
  subscribeSnapshot(observer: (snapshot: { readonly status: string }) => void): {
    unsubscribe(): void;
  };
}

/**
 * Shared `'ready-and-running-state'` driver: records `run`'s status before
 * release, polls (bounded, no wall-clock sleep) until it observes
 * `'running'`, releases the blocked generate, then awaits the terminal
 * status — the identical body every mode's `readyAndRunningState` scenario
 * ran inline before this extraction.
 */
export async function observeReadyAndRunning<TRun extends ObservableRun>(
  run: TRun,
  release: () => void,
): Promise<{ sawNonTerminalStatus: boolean; reachedTerminalStatus: boolean }> {
  const observed: string[] = [run.snapshot().status];
  const subscription = run.subscribeSnapshot((snapshot) => observed.push(snapshot.status));
  for (let attempt = 0; attempt < 50 && run.snapshot().status !== 'running'; attempt++) {
    await Promise.resolve();
  }
  observed.push(run.snapshot().status);
  release();
  await run.result();
  observed.push(run.snapshot().status);
  subscription.unsubscribe();
  return {
    sawNonTerminalStatus: observed.some((status) => status !== 'terminal'),
    reachedTerminalStatus: observed.at(-1) === 'terminal',
  };
}

/** The minimal surface a dispatched child needs for the two concurrent-pair drivers below: an abortable, awaitable, event-emitting handle — satisfied structurally by `ChildRunHandle` and by `SequentialRun` alike. */
export interface ConcurrentRunLeg extends AsyncIterable<RunEvent> {
  result(): Promise<{ readonly finishReason: string }>;
  abort(reason?: string): void;
}

/**
 * Shared `'root-subtree-abort'` driver: attaches `parentRun`'s trace
 * immediately (synchronously, per `attachLeg`'s contract), resolves
 * `parentRun`'s settled id through `getParentId`, dispatches the child
 * through `dispatchChild` and attaches its trace immediately too, then
 * fires `rootController.abort` against both. `dispatchChild` and
 * `getParentId` are the only per-mode seams — how a parent/child run gets
 * built and how its id settles differs by mode; the abort-and-measure
 * choreography does not.
 */
export async function driveRootSubtreeAbortPair(
  runtime: RuntimeServices,
  parentRun: SequentialRun,
  getParentId: () => string | Promise<string>,
  dispatchChild: (parentId: string, signal: AbortSignal) => ConcurrentRunLeg,
  rootController: AbortController,
) {
  const recorder = createEventRecorder(runtime);
  attachLeg(recorder, parentRun, 'root-parent', ABORT_EVENTS);
  const parentId = await getParentId();
  const childRun = dispatchChild(parentId, rootController.signal);
  attachLeg(recorder, childRun, 'root-child', ABORT_EVENTS);
  return driveConcurrentPair(
    runtime,
    parentRun,
    'rootSubtreeAbort',
    recorder,
    ['root-parent', 'run.aborted', parentRun.result()],
    ['root-child', 'run.aborted', childRun.result()],
    () => rootController.abort('lifecycle-contract: root subtree abort'),
  );
}

/**
 * Shared `'sibling-isolation'` driver: resolves `parentRun`'s settled id,
 * dispatches the aborted and surviving children (attaching each trace
 * immediately after its own dispatch), aborts only the first, then awaits
 * `parentRun` itself before returning — the identical choreography every
 * mode's `siblingIsolation` scenario ran inline before this extraction.
 */
export async function driveSiblingIsolationPair(
  runtime: RuntimeServices,
  parentRun: SequentialRun,
  getParentId: () => string | Promise<string>,
  dispatchAbortedChild: (parentId: string) => ConcurrentRunLeg,
  dispatchSurvivingChild: (parentId: string) => ConcurrentRunLeg,
) {
  const parentId = await getParentId();
  const abortedChild = dispatchAbortedChild(parentId);
  const recorder = createEventRecorder(runtime);
  attachLeg(recorder, abortedChild, 'sib-aborted', ABORT_EVENTS);
  const survivingChild = dispatchSurvivingChild(parentId);
  attachLeg(recorder, survivingChild, 'sib-surviving', SUCCESS_EVENTS);
  const outcome = await driveConcurrentPair(
    runtime,
    parentRun,
    'siblingIsolation',
    recorder,
    ['sib-aborted', 'run.aborted', abortedChild.result()],
    ['sib-surviving', 'run.completed', survivingChild.result()],
    () => abortedChild.abort('lifecycle-contract: sibling-targeted abort'),
  );
  await parentRun.result();
  return outcome;
}

/** Drives one root run to a terminal state (optionally aborting it while blocked) and captures its filtered event trace under `id`. */
export function driveSequential(
  build: (runtime: RuntimeServices) => SequentialRun,
  events: ReadonlySet<RunEvent['type']>,
  id: string,
  terminalEventType: RunEvent['type'],
  abort = false,
) {
  return withRun(id, build, async (run, runtime) => {
    const recorder = createEventRecorder(runtime);
    recorder.attachIterable(filterRunEvents(run, events), { kind: 'run', id });
    if (abort) run.abort('lifecycle-contract: targeted abort');
    const result = await run.result();
    return {
      finishReason: result.finishReason,
      hasError: result.error !== undefined,
      recorder,
      resourceKey: `run:${id}`,
      terminalEventType,
    };
  });
}

/**
 * Attaches `recorder` to `source` under `id`, filtered to `events`, and
 * returns the id back for convenience. MUST be called synchronously, right
 * after the run/child is created — `attachIterable` only sees events
 * emitted from the moment it subscribes onward, so any `await` between
 * creating a run and attaching to it can silently drop its `run.started`.
 * `driveConcurrentPair` cannot do this attaching itself whenever a caller
 * needs an `await` in between (e.g. session mode's real, settled run id) to
 * dispatch its child — see `session-run.ts`'s `stableRunId`.
 */
export function attachLeg(
  recorder: EventRecorder,
  source: AsyncIterable<RunEvent>,
  id: string,
  events: ReadonlySet<RunEvent['type']>,
): string {
  recorder.attachIterable(filterRunEvents(source, events), { kind: 'run', id });
  return id;
}

/** `[id, terminalEventType, result]` — one already-`attachLeg`'d resource's half of a two-resource scenario. */
export type ConcurrentLeg = readonly [
  id: string,
  terminalEventType: RunEvent['type'],
  result: Promise<{ readonly finishReason: string }>,
];

/** Shared two-resource driver for `rootSubtreeAbort`/`siblingIsolation`: fires `trigger` against two already-`attachLeg`'d resources, awaits both, and measures the entries-before/after-cleanup invariant. */
export async function driveConcurrentPair(
  runtime: RuntimeServices,
  scopeRun: ClosableRun,
  label: string,
  recorder: EventRecorder,
  parent: ConcurrentLeg,
  child: ConcurrentLeg,
  trigger: () => void,
) {
  const scope = scopeForRun(label, runtime, scopeRun);
  trigger();
  const [parentResult, childResult] = await Promise.all([parent[2], child[2]]);
  const entriesBeforeCleanup = recorder.normalize().length;
  await scope.close();
  const entriesAfterCleanup = recorder.normalize().length;
  return {
    recorder,
    parentResourceKey: `run:${parent[0]}`,
    childResourceKey: `run:${child[0]}`,
    parentTerminalEventType: parent[1],
    childTerminalEventType: child[1],
    parentFinishReason: parentResult.finishReason,
    childFinishReason: childResult.finishReason,
    entriesBeforeCleanup,
    entriesAfterCleanup,
  };
}

/**
 * A generate function that blocks until `release()` is called OR the run's
 * own `AbortSignal` fires — whichever comes first, exactly like
 * `createStepwiseBlockingGenerate`'s step-1 block (`operative/test`). Used
 * to park a run mid-flight (status `'running'`, not yet terminal) so the
 * `'ready-and-running-state'` scenario can observe both states before the
 * run reaches a terminal one, and so `'targeted-abort'`/`'root-subtree-abort'`/
 * `'sibling-isolation'` have something genuinely in flight to abort —
 * deterministic, no wall-clock sleep either way.
 */
export function createBlockingGenerate(): {
  generate: GenerateFunction;
  release: (response?: GenerateResponse) => void;
} {
  let releaseResolver: ((response: GenerateResponse) => void) | undefined;
  const pending = new Promise<GenerateResponse>((resolve) => {
    releaseResolver = resolve;
  });
  const generate: GenerateFunction = async (context) =>
    Promise.race([
      pending,
      new Promise<GenerateResponse>((resolve) => {
        context.signal?.addEventListener(
          'abort',
          () => resolve({ content: 'aborted', toolCalls: [] }),
          { once: true },
        );
      }),
    ]);
  return {
    generate,
    release: (response: GenerateResponse = { content: 'released', toolCalls: [] }) => {
      releaseResolver?.(response);
    },
  };
}

/** A generate function that resolves immediately with plain text content — no tool calls, one step. */
export function createInstantGenerate(content = 'done'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

/** A bare `RunnableAgent` with an empty toolbox — the standard child agent every adapter's `dispatchTestChild` runs. */
export function createTestAgent(
  createAgent: (options: {
    generate: GenerateFunction;
    name: string;
    toolbox: AnyToolbox;
    runtime: RuntimeServices;
  }) => RunnableAgent,
  runtime: RuntimeServices,
  name: string,
  generate: GenerateFunction = createInstantGenerate(),
): RunnableAgent {
  return createAgent({ generate, name, toolbox: createToolbox([]), runtime });
}

/** Dispatches one child agent under `parentId`, sharing `registry` and (when supplied) `signal` — the same public `dispatchChildRun` primitive every process-local adapter's `parentage`/`rootSubtreeAbort`/`siblingIsolation` scenarios use. */
export function dispatchTestChild(
  createAgent: Parameters<typeof createTestAgent>[0],
  runtime: RuntimeServices,
  registry: MutableChildRunRegistry,
  parentId: string,
  name: string,
  generate?: GenerateFunction,
  signal?: AbortSignal,
): ChildRunHandle {
  const options: DispatchChildRunOptions = {
    agentName: name,
    parentRunId: parentId,
    registry,
    runtime,
    ...(signal ? { signal } : {}),
  };
  return dispatchChildRun(createTestAgent(createAgent, runtime, name, generate), 'go', options);
}

/** A generate function that throws synchronously — drives a `finishReason: 'error'` terminal. */
export function createFailingGenerate(
  message = 'lifecycle-contract: deliberate generate failure',
): GenerateFunction {
  return async () => {
    throw new Error(message);
  };
}

/** Builds one fresh in-memory `Bureau` over the catalog `build` returns, runs `use` against it, then closes it — every call gets its own bureau, since `close()` shuts the whole thing down. */
export async function withHarness<D extends AgentDefinitions, TResult>(
  build: (runtime: RuntimeServices) => D,
  use: (harness: BureauTestHarness<D>) => Promise<TResult>,
): Promise<TResult> {
  const runtime = createManualRuntimeServices();
  const storage = createMemoryStorageFixture();
  // A top-level `generate`/`toolbox` is required for `bureau.ready` to settle
  // — see `harness.test.ts`'s own "composes the bureau over the injected
  // runtime" fixture, which supplies both even with an empty `agents: {}`.
  const harness = await createBureauTestHarness({
    agents: build(runtime),
    generate: createInstantGenerate(),
    toolbox: createToolbox([]),
    runtime,
    storage,
  });
  const result = await use(harness);
  await harness.close();
  return result;
}

/** Drives `harness.startRun('p', ...)` to a terminal state (optionally aborting it while blocked) and captures its filtered event trace under `id`. */
export async function driveBureauSequential(
  build: (runtime: RuntimeServices) => AgentDefinitions,
  events: ReadonlySet<RunEvent['type']>,
  id: string,
  terminalEventType: RunEvent['type'],
  abort = false,
) {
  return withHarness(build, async (harness) => {
    const run = harness.startRun('p', 'go');
    const recorder = createEventRecorder(harness.runtime);
    attachLeg(recorder, run, id, events);
    if (abort) run.abort('lifecycle-contract: targeted abort');
    const result = await run.result();
    return {
      finishReason: result.finishReason,
      hasError: result.error !== undefined,
      recorder,
      resourceKey: `run:${id}`,
      terminalEventType,
    };
  });
}

/**
 * Coordinator ruling on AB-268 (2026-09-03): adapts the real
 * `subscribeSnapshot(observer, options?) => Subscription` signature (AB-214)
 * to the `subscribeSnapshot(invalidate) => unsubscribe` shape
 * `ReactiveSourceSubject` (AB-258/tst-02g) expects, skipping the first
 * synchronous delivery (subscribing always delivers the current snapshot
 * once, synchronously, before returning) and forwarding only subsequent
 * deliveries as invalidations. `ReactiveSourceSubject` itself stays
 * unwidened — this lives here, not in `reactive-source-suite.ts`.
 */
export function toReactiveSourceSubject(run: {
  snapshot(): AgentRunLivenessSnapshot;
  subscribeSnapshot(
    observer: (snapshot: AgentRunLivenessSnapshot) => void,
    options?: { signal?: AbortSignal },
  ): { unsubscribe(): void };
}): ReactiveSourceSubject<AgentRunLivenessSnapshot> {
  return {
    getSnapshot: () => run.snapshot(),
    subscribeSnapshot: (invalidate: () => void) => {
      let sawInitialDelivery = false;
      const subscription = run.subscribeSnapshot(() => {
        if (!sawInitialDelivery) {
          sawInitialDelivery = true;
          return;
        }
        invalidate();
      });
      return () => subscription.unsubscribe();
    },
  };
}
