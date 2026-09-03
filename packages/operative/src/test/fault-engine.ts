import type { AnyToolbox, ToolboxExecuteOptions, ToolError } from 'armorer';
import type { HookRegistrationOptions, RuntimeServices } from 'lifecycle';
import { HookRegistry } from 'lifecycle';

import type { OperativeHookMap } from '../hooks';
import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  ToolCallInput,
  ToolExecutionResult,
} from '../types';
import type {
  FaultBoundary,
  FaultOperation,
  FaultPlan,
  FaultPlanEntry,
  FiredFault,
} from './fault-plan';
import type { ScriptedHookPhase } from './scripted-tool';

/**
 * The fault engine (AB-265, tst-04a): applies a {@link FaultPlan} — AB-92's
 * decision, AB-257's vocabulary — at the model, tool, hook, and storage
 * boundaries. `process-death` is AB-97's boundary; everything else is
 * addressable here through eleven concrete effects, each mapped onto
 * exactly one {@link FaultBoundary}.
 *
 * `before-work`/`before-commit` share one mechanism (never call the
 * wrapped function; throw) and `after-effect`/`after-commit` share another
 * (call the wrapped function to completion; throw afterward) — the
 * `FaultBoundary` distinguishes WHICH guarantee a plan entry is proving
 * (an operation that never ran vs. an operation whose underlying call
 * completed but whose durable write specifically is what's being asserted),
 * not a mechanically different code path. See {@link FAULT_BOUNDARY_EFFECT_KINDS}.
 */

/** One matching-call barrier: `release` resolves the moment a test wants the blocked call to proceed. */
export interface FaultBlockEffect {
  readonly kind: 'block';
  /** Resolves to unblock the call. The engine never resolves this itself. */
  readonly release: Promise<void>;
  /** Invoked synchronously the instant the call arrives at the barrier, before `release` is awaited. */
  readonly onReached?: () => void;
}

/** Suspends the call until `runtime.timers` fires the delay — never a real timer. */
export interface FaultDelayEffect {
  readonly kind: 'delay';
  readonly milliseconds: number;
}

/** `before-work`: the wrapped function is never invoked. */
export interface FaultRejectBeforeWorkEffect {
  readonly kind: 'reject-before-work';
  readonly error?: unknown;
}

/** `after-effect`: the wrapped function runs to completion; its result is discarded and the caller sees `error`. */
export interface FaultFailAfterEffect {
  readonly kind: 'fail-after-effect';
  readonly error?: unknown;
}

/** `before-commit`: the durable write this boundary targets never happens. */
export interface FaultFailBeforeCommitEffect {
  readonly kind: 'fail-before-commit';
  readonly error?: unknown;
}

/** `after-commit`: the durable write happens for real; the caller still sees `error`. */
export interface FaultFailAfterCommitEffect {
  readonly kind: 'fail-after-commit';
  readonly error?: unknown;
}

/** `stale-read`: `value` is returned in place of the current value — the wrapped function is never invoked. */
export interface FaultStaleReadEffect {
  readonly kind: 'stale-read';
  readonly value: unknown;
}

/** `corrupt-payload`: the real result is computed, then rewritten by `corrupt` before delivery. */
export interface FaultCorruptPayloadEffect {
  readonly kind: 'corrupt-payload';
  readonly corrupt: (value: unknown) => unknown;
}

/** `duplicate-delivery`: the wrapped function is invoked twice; the second settlement is delivered. */
export interface FaultDuplicateDeliveryEffect {
  readonly kind: 'duplicate-delivery';
}

/** `lost-acknowledgement`: the wrapped function runs for real; the caller's promise never settles. */
export interface FaultDropAcknowledgementEffect {
  readonly kind: 'drop-acknowledgement';
}

/** `ignored-abort`: the wrapped function receives a signal that can never observe the caller's abort. */
export interface FaultIgnoreAbortEffect {
  readonly kind: 'ignore-abort';
}

/** The closed effect vocabulary the engine interprets. `FaultPlanEntry.effect` is `unknown` at the type level (AB-257); this is what the engine requires it to actually be, checked at fire time. */
export type FaultEffect =
  | FaultBlockEffect
  | FaultDelayEffect
  | FaultRejectBeforeWorkEffect
  | FaultFailAfterEffect
  | FaultFailBeforeCommitEffect
  | FaultFailAfterCommitEffect
  | FaultStaleReadEffect
  | FaultCorruptPayloadEffect
  | FaultDuplicateDeliveryEffect
  | FaultDropAcknowledgementEffect
  | FaultIgnoreAbortEffect;

/**
 * The eleven actions AB-265 names, each mapped onto exactly one
 * `FaultBoundary`. A total mapped type over `FaultBoundary` — TypeScript
 * rejects a missing key — so this object IS the type-level proof that
 * every boundary has at least one engine binding; `process-death` maps to
 * an empty tuple because its binding is the constructor-time rejection
 * below, never a runtime effect. `fault-plan.test-d.ts` imports this and
 * checks it against `Record<FaultBoundary, readonly string[]>`.
 */
export const FAULT_BOUNDARY_EFFECT_KINDS: {
  readonly [Boundary in FaultBoundary]: readonly FaultEffect['kind'][];
} = {
  'before-work': ['block', 'delay', 'reject-before-work'],
  'after-effect': ['fail-after-effect'],
  'before-commit': ['fail-before-commit'],
  'after-commit': ['fail-after-commit'],
  'lost-acknowledgement': ['drop-acknowledgement'],
  'stale-read': ['stale-read'],
  'duplicate-delivery': ['duplicate-delivery'],
  'corrupt-payload': ['corrupt-payload'],
  'ignored-abort': ['ignore-abort'],
  'process-death': [],
};

/**
 * Thrown at plan construction when a `FaultPlanEntry` names the
 * `process-death` boundary — no in-process engine can simulate a real OS
 * process dying. That boundary belongs to AB-97's crash-recovery harness.
 */
export class UnsupportedFaultBoundaryError extends Error {
  constructor(entryId: string) {
    super(
      `FaultEngine: entry "${entryId}" names the "process-death" boundary, which no ` +
        'in-process engine can simulate. process-death is owned by AB-97 ' +
        '(the process-crash Bureau recovery harness) — script a real OS-process kill there.',
    );
    this.name = 'UnsupportedFaultBoundaryError';
  }
}

const HOOK_NAME_TO_PHASE: Record<string, ScriptedHookPhase> = {
  beforeGenerate: 'before-model',
  afterGenerate: 'after-model',
  beforeToolExecution: 'before-tool',
  afterToolExecution: 'after-tool',
};

/** The interface `createFaultEngine` returns (AB-265's own acceptance criteria). */
export interface FaultEngine {
  wrapGenerate(generate: GenerateFunction): GenerateFunction;
  wrapToolbox(toolbox: AnyToolbox): AnyToolbox;
  wrapHooks(hooks: HookRegistry<OperativeHookMap>): HookRegistry<OperativeHookMap>;
  wrapStorage<T>(store: T): T;
  /** Every fired fault, in fire order. */
  fired(): readonly FiredFault[];
  /** Throws, naming every plan entry that never fired, if any didn't. */
  assertAllFired(): void;
}

/**
 * Resolves what a firing `reject-before-work`/`fail-before-commit`/
 * `fail-after-effect`/`fail-after-commit` entry throws: the effect's own
 * `error` when the test supplied one, a default `Error` otherwise. Returns
 * `unknown` (matching `effect.error`'s own declared type, same as every
 * scripted double's `{ kind: 'fail'; error: unknown }`/`{ kind: 'reject';
 * error: unknown }` steps) rather than narrowing to `Error` — a test is
 * free to script throwing a non-`Error` value to prove a caller handles
 * that too.
 */
function resolveThrowValue(effectError: unknown, entry: FaultPlanEntry): unknown {
  return effectError ?? new Error(`FaultEngine: "${entry.id}" fired (${entry.boundary})`);
}

/**
 * Turns a synchronously-caught `unknown` value into a rejected `Promise`,
 * for the one caller below that must never let `pickFiring`'s synchronous
 * throw escape as one — `throw error` here (rather than `Promise.reject
 * (error)`) matches `scripted-generate.ts`'s own `throw step.error` pattern
 * for an `unknown`-typed value the caller controls.
 */
async function rejectedPromise<T>(error: unknown): Promise<T> {
  throw error;
}

/**
 * Converts a fault-injected failure into the same `outcome: 'error'` shape
 * a real `Toolbox.execute()` call under `errorMode: 'collect'` (the
 * default) resolves with, so a wrapped toolbox's `execute()` never rejects
 * on account of a fired fault — matching the public contract every other
 * caller of a real toolbox already relies on.
 */
function toolExecutionErrorResult(call: ToolCallInput, error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  const toolError: ToolError = {
    code: 'FAULT_INJECTED',
    category: 'internal',
    retryable: false,
    message,
  };
  return {
    callId: call.id ?? '',
    toolCallId: call.id ?? '',
    toolName: call.name,
    outcome: 'error',
    content: null,
    result: undefined,
    error: toolError,
  };
}

/** Reads `effect.kind` off an `unknown` value, or `undefined` when it isn't a `{ kind: string }` shape. */
function readEffectKind(effect: unknown): string | undefined {
  if (typeof effect !== 'object' || effect === null || !('kind' in effect)) return undefined;
  return typeof effect.kind === 'string' ? effect.kind : undefined;
}

/** Narrows `entry.effect` (`unknown`) to one of `kinds`, or throws. */
function expectEffect(entry: FaultPlanEntry, kinds: readonly FaultEffect['kind'][]): FaultEffect {
  const kind = readEffectKind(entry.effect);
  if (kind === undefined || !kinds.includes(kind as FaultEffect['kind'])) {
    throw new TypeError(
      `FaultEngine: entry "${entry.id}" (boundary "${entry.boundary}") requires ` +
        `effect.kind to be one of ${JSON.stringify(kinds)}, got ${JSON.stringify(kind)}`,
    );
  }
  // Justified: `kind === undefined || !kinds.includes(...)` above is the
  // runtime proof that `entry.effect` actually has one of `FaultEffect`'s
  // member shapes — TypeScript cannot itself narrow an `unknown` through an
  // `Array#includes` check against a separately-computed string, so this
  // cast restates what the check above already established.
  return entry.effect as FaultEffect;
}

interface EntryOccurrenceState {
  matchedCount: number;
  firedCount: number;
  everFired: boolean;
}

/**
 * Creates the fault engine bound to one `FaultPlan` and one `RuntimeServices`
 * instance. Every timing decision (`delay`, `after-sequence`) reads through
 * `runtime` — nothing here reads a real timer or a real clock.
 */
export function createFaultEngine(plan: FaultPlan, runtime: RuntimeServices): FaultEngine {
  const seenEntryIds = new Set<string>();
  for (const entry of plan) {
    if (entry.boundary === 'process-death') {
      throw new UnsupportedFaultBoundaryError(entry.id);
    }
    // A duplicate id would silently alias two entries' occurrence-tracking
    // state onto one map key below, corrupting `fired()`/`assertAllFired()`
    // for both. Fail loudly at construction instead.
    if (seenEntryIds.has(entry.id)) {
      throw new Error(
        `FaultEngine: duplicate FaultPlanEntry id "${entry.id}" — plan entry ids must be unique.`,
      );
    }
    seenEntryIds.add(entry.id);
  }

  const fired: FiredFault[] = [];
  const entryState = new Map<string, EntryOccurrenceState>(
    plan.map((entry) => [entry.id, { matchedCount: 0, firedCount: 0, everFired: false }]),
  );
  // Cumulative `RuntimeServices.deferred` settlements this engine has
  // observed, for `after-sequence`. Each `drain()` call reports only
  // settlements NEW since the previous call (the runtime deletes what it
  // reports), so the running total below is exact — but it is also
  // DESTRUCTIVE: a test that also calls `runtime.deferred.drain()` directly
  // races the engine for the same settlement reports. Compose one or the
  // other against a given `RuntimeServices` instance, not both.
  let cumulativeSettled = 0;

  function recordFired(entry: FaultPlanEntry, ordinal: number): void {
    const state = entryState.get(entry.id);
    if (state) {
      state.firedCount += 1;
      state.everFired = true;
    }
    fired.push({
      plan: entry.id,
      boundary: entry.boundary,
      occurrence: ordinal,
      firedAt: runtime.clock.nowISO(),
    });
  }

  interface FiringMatch {
    readonly entry: FaultPlanEntry;
    readonly ordinal: number;
    readonly effect: FaultEffect;
  }

  /**
   * Resolves `'every'`/`'nth'` synchronously; returns `undefined` for a
   * non-firing entry. Callers only invoke this once they've already excluded
   * `'after-sequence'` (see {@link pickFiring}/{@link pickFiringFromAfterSequence}),
   * so `'nth'` is the only branch checked explicitly — everything else this
   * function is ever called for is `'every'`.
   */
  function tryFireEveryOrNth(
    entry: FaultPlanEntry,
    state: EntryOccurrenceState,
  ): FiringMatch | undefined {
    if (entry.occurrence.kind === 'nth') {
      state.matchedCount += 1;
      if (state.everFired || state.matchedCount !== entry.occurrence.n) return undefined;
      return {
        entry,
        ordinal: entry.occurrence.n,
        effect: expectEffect(entry, FAULT_BOUNDARY_EFFECT_KINDS[entry.boundary]),
      };
    }
    state.matchedCount += 1;
    return {
      entry,
      ordinal: state.matchedCount,
      effect: expectEffect(entry, FAULT_BOUNDARY_EFFECT_KINDS[entry.boundary]),
    };
  }

  /**
   * Finds the plan entry (if any) that fires for this call to `operationKey`.
   * `'every'`/`'nth'` resolve synchronously — this returns a plain value, not
   * a `Promise`, for that common case, so `dispatch` below never incurs a
   * microtask hop before registering a `delay` timer or reaching a `block`
   * barrier. Only when the loop reaches an unfired `'after-sequence'` entry
   * does it hand off to {@link pickFiringFromAfterSequence}, which awaits
   * `runtime.deferred.drain()` to learn the current cumulative settlement
   * count, continuing the SAME plan-order scan from that point.
   */
  function pickFiring(
    operationKey: FaultOperation,
  ): FiringMatch | undefined | Promise<FiringMatch | undefined> {
    for (let index = 0; index < plan.length; index++) {
      const entry = plan[index]!;
      if (entry.operation !== operationKey) continue;
      const state = entryState.get(entry.id);
      if (!state) continue;

      if (entry.occurrence.kind !== 'after-sequence') {
        const match = tryFireEveryOrNth(entry, state);
        if (match) return match;
        continue;
      }
      if (state.everFired) continue;
      return pickFiringFromAfterSequence(operationKey, index);
    }
    return undefined;
  }

  /** Continues {@link pickFiring}'s plan-order scan from `fromIndex`, awaiting `runtime.deferred.drain()` for each `'after-sequence'` entry it meets. */
  async function pickFiringFromAfterSequence(
    operationKey: FaultOperation,
    fromIndex: number,
  ): Promise<FiringMatch | undefined> {
    for (let index = fromIndex; index < plan.length; index++) {
      const entry = plan[index]!;
      if (entry.operation !== operationKey) continue;
      const state = entryState.get(entry.id);
      if (!state) continue;

      if (entry.occurrence.kind !== 'after-sequence') {
        const match = tryFireEveryOrNth(entry, state);
        if (match) return match;
        continue;
      }
      if (state.everFired) continue;
      const report = await runtime.deferred.drain();
      cumulativeSettled += report.settled.length;
      if (cumulativeSettled < entry.occurrence.sequence) continue;
      return {
        entry,
        ordinal: 1,
        effect: expectEffect(entry, FAULT_BOUNDARY_EFFECT_KINDS[entry.boundary]),
      };
    }
    return undefined;
  }

  /**
   * The work of applying a resolved match (or none) to one call — split out
   * of `dispatch` so the no-match and synchronously-matched paths can call
   * straight into it with no intervening `await`, preserving exact call
   * timing for `delay` and `block` (see {@link pickFiring}'s doc comment).
   */
  async function applyMatch<T>(
    match: FiringMatch | undefined,
    callThrough: (signal: AbortSignal | undefined) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (!match) return callThrough(signal);
    const { entry, ordinal, effect } = match;

    switch (effect.kind) {
      case 'block': {
        effect.onReached?.();
        await effect.release;
        recordFired(entry, ordinal);
        return callThrough(signal);
      }
      case 'delay': {
        await new Promise<void>((resolve) => {
          runtime.timers.setTimeout(resolve, effect.milliseconds);
        });
        recordFired(entry, ordinal);
        return callThrough(signal);
      }
      case 'reject-before-work':
      case 'fail-before-commit': {
        recordFired(entry, ordinal);
        throw resolveThrowValue(effect.error, entry);
      }
      case 'fail-after-effect':
      case 'fail-after-commit': {
        await callThrough(signal);
        recordFired(entry, ordinal);
        throw resolveThrowValue(effect.error, entry);
      }
      case 'stale-read': {
        recordFired(entry, ordinal);
        return effect.value as T;
      }
      case 'corrupt-payload': {
        const real = await callThrough(signal);
        recordFired(entry, ordinal);
        return effect.corrupt(real) as T;
      }
      case 'duplicate-delivery': {
        await callThrough(signal);
        const second = await callThrough(signal);
        recordFired(entry, ordinal);
        return second;
      }
      case 'drop-acknowledgement': {
        const inFlight = callThrough(signal);
        // Never let the real (uncommitted-to-caller) settlement become an
        // unhandled rejection: the caller-facing promise below deliberately
        // never settles, so nothing else will ever observe this one.
        inFlight.catch(() => undefined);
        recordFired(entry, ordinal);
        return new Promise<T>(() => undefined);
      }
      case 'ignore-abort': {
        recordFired(entry, ordinal);
        return callThrough(new AbortController().signal);
      }
    }
  }

  /**
   * The single dispatcher every `wrap*` method routes a call through.
   * `callThrough` is the underlying operation; `signal` (when present) is
   * the caller's original `AbortSignal`, replaced with a never-aborting one
   * for `ignore-abort`. Calls straight into {@link applyMatch} with no
   * `await` in between for a synchronously-resolved (or absent) match —
   * only an `'after-sequence'` match is awaited first.
   */
  function dispatch<T>(
    operationKey: FaultOperation,
    callThrough: (signal: AbortSignal | undefined) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    // `pickFiring` can throw synchronously (an entry whose `effect` doesn't
    // match its boundary) — every `wrap*` method's contract is that it
    // returns a value of the SAME public type as its input (a function
    // returning a `Promise`, a toolbox whose `execute` returns a `Promise`),
    // so a synchronous throw here would be a contract violation. Converting
    // it to a rejection keeps that contract intact without affecting the
    // fast-path timing above: nothing here awaits before the conversion.
    let maybeMatch: FiringMatch | undefined | Promise<FiringMatch | undefined>;
    try {
      maybeMatch = pickFiring(operationKey);
    } catch (error) {
      return rejectedPromise<T>(error);
    }
    if (maybeMatch instanceof Promise) {
      return maybeMatch.then((match) => applyMatch(match, callThrough, signal));
    }
    return applyMatch(maybeMatch, callThrough, signal);
  }

  class FaultAwareHookRegistry extends HookRegistry<OperativeHookMap> {
    // Explicit (even though it only calls `super()`) — Bun's coverage
    // instrumenter counts a class's implicit default constructor as an
    // unhittable function otherwise; see `BarrierCoordinator`'s identical
    // comment in `scripted-generate.ts`.
    constructor() {
      super();
    }

    override on<K extends keyof OperativeHookMap & string>(
      hookName: K,
      handler: OperativeHookMap[K],
      options?: HookRegistrationOptions,
    ): () => void {
      const phase = HOOK_NAME_TO_PHASE[hookName];
      if (!phase) return super.on(hookName, handler, options);
      const operationKey: FaultOperation = `hook:${phase}`;
      const wrapped = ((...args: Parameters<OperativeHookMap[K]>) =>
        dispatch(operationKey, () =>
          (handler as (...handlerArgs: unknown[]) => Promise<unknown>)(...args),
        )) as OperativeHookMap[K];
      return super.on(hookName, wrapped, options);
    }
  }

  return {
    wrapGenerate(generate: GenerateFunction): GenerateFunction {
      return (context: GenerateContext): Promise<GenerateResponse> =>
        dispatch(
          'generate',
          (signal) => generate(signal ? { ...context, signal } : context),
          context.signal,
        );
    },

    wrapToolbox(toolbox: AnyToolbox): AnyToolbox {
      const wrappedExecute = async (
        callOrCalls: ToolCallInput | ToolCallInput[],
        options?: ToolboxExecuteOptions,
      ): Promise<ToolExecutionResult | ToolExecutionResult[]> => {
        const isBatch = Array.isArray(callOrCalls);
        const calls = isBatch ? callOrCalls : [callOrCalls];
        const results: ToolExecutionResult[] = [];
        for (const call of calls) {
          const operationKey: FaultOperation = `tool:${call.name}`;
          try {
            const result = await dispatch<ToolExecutionResult>(
              operationKey,
              (signal) => toolbox.execute(call, signal ? { ...options, signal } : options),
              options?.signal,
            );
            results.push(result);
          } catch (error) {
            // `Toolbox.execute()`'s established contract (create-toolbox.ts's
            // default `errorMode: 'collect'`) is to RESOLVE with an
            // `outcome: 'error'` result on a tool failure, never to reject —
            // a fault-injected failure must honor that same contract rather
            // than making an injected failure look like a toolbox-level
            // crash to a caller (e.g. run-step.ts's own catch path exists
            // for genuine crashes, not tool failures). A batch keeps
            // executing its remaining calls, matching 'collect' semantics.
            results.push(toolExecutionErrorResult(call, error));
          }
        }
        return isBatch ? results : results[0]!;
      };

      return {
        ...toolbox,
        execute: wrappedExecute as AnyToolbox['execute'],
      };
    },

    wrapHooks(hooks: HookRegistry<OperativeHookMap>): HookRegistry<OperativeHookMap> {
      const wrapped = new FaultAwareHookRegistry();
      for (const hookName of hooks.getHookNames()) {
        for (const entry of hooks.getHandlers(hookName)) {
          wrapped.on(hookName, entry.handler, entry.options);
        }
      }
      return wrapped;
    },

    wrapStorage<T>(store: T): T {
      const verbs = ['get', 'set', 'delete', 'query'] as const;
      if (typeof store !== 'object' || store === null) return store;
      const target = store;
      const handler: ProxyHandler<T & object> = {
        get(currentTarget, property, receiver: unknown) {
          const value: unknown = Reflect.get(currentTarget, property, receiver);
          const isVerbMethod =
            typeof property === 'string' &&
            (verbs as readonly string[]).includes(property) &&
            typeof value === 'function';
          if (!isVerbMethod) return typeof value === 'function' ? value.bind(currentTarget) : value;

          const verb = property as (typeof verbs)[number];
          const operationKey: FaultOperation = `storage:${verb}`;
          return (...args: unknown[]) =>
            dispatch(
              operationKey,
              () => Reflect.apply(value, currentTarget, args) as Promise<unknown>,
            );
        },
      };
      return new Proxy(target, handler);
    },

    fired(): readonly FiredFault[] {
      return fired;
    },

    assertAllFired(): void {
      const unfired = plan.filter((entry) => !(entryState.get(entry.id)?.everFired ?? false));
      if (unfired.length > 0) {
        throw new Error(
          `FaultEngine.assertAllFired: ${unfired.length} entr${unfired.length === 1 ? 'y' : 'ies'} ` +
            `never fired: ${unfired.map((entry) => entry.id).join(', ')}`,
        );
      }
    },
  };
}
