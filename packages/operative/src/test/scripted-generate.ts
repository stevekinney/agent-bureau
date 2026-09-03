import type { Conversation } from 'conversationalist';

import type { Effort } from '../providers/types';
import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingHandle,
} from '../types';

// ---------------------------------------------------------------------------
// Barrier: a named, two-phase latch. "Arrived" resolves the moment a
// scripted double reaches the barrier (so a test can `await reached(name)`
// instead of sleeping); "released" resolves once the test calls
// `release(name)`, unblocking whichever double is waiting there. Both sides
// are latches — calling `release` before anything has arrived, or awaiting
// `reached` after the double already passed through, still resolves
// immediately, because both promises are created once per name and reused.
// No timer anywhere in this file: every wait is a Promise a caller resolves.
// ---------------------------------------------------------------------------

interface BarrierEntry {
  readonly arrivedPromise: Promise<void>;
  readonly resolveArrived: () => void;
  readonly releasedPromise: Promise<void>;
  readonly resolveReleased: () => void;
}

function createBarrierEntry(): BarrierEntry {
  let resolveArrived!: () => void;
  const arrivedPromise = new Promise<void>((resolve) => {
    resolveArrived = resolve;
  });
  let resolveReleased!: () => void;
  const releasedPromise = new Promise<void>((resolve) => {
    resolveReleased = resolve;
  });
  return { arrivedPromise, resolveArrived, releasedPromise, resolveReleased };
}

/**
 * Shared barrier coordination for the scripted doubles (`scripted-generate.ts`
 * and `scripted-tool.ts`). Exported (not re-exported from `index.ts`) so
 * `scripted-tool.ts` reuses this one implementation instead of a second copy.
 */
export class BarrierCoordinator {
  private readonly barriers = new Map<string, BarrierEntry>();

  // Explicit (even though empty): Bun's coverage instrumenter counts a
  // class's implicit default constructor as a function it can never mark
  // hit, which fails `bun run coverage:check`'s 100%-functions gate even
  // though `new BarrierCoordinator()` runs on every scripted double this
  // module creates. An explicit constructor is instrumented normally.
  constructor() {}

  private entry(name: string): BarrierEntry {
    let existing = this.barriers.get(name);
    if (!existing) {
      existing = createBarrierEntry();
      this.barriers.set(name, existing);
    }
    return existing;
  }

  /** Marks a barrier as arrived — called by the double when it reaches the block point. */
  arrive(name: string): void {
    this.entry(name).resolveArrived();
  }

  /** Resolves once the double has arrived at the named barrier. */
  reached(name: string): Promise<void> {
    return this.entry(name).arrivedPromise;
  }

  /** Unblocks whichever double is waiting at the named barrier. */
  release(name: string): void {
    this.entry(name).resolveReleased();
  }

  /** Resolves once the named barrier has been released. */
  awaitRelease(name: string): Promise<void> {
    return this.entry(name).releasedPromise;
  }
}

/** One step in a `ScriptedGenerate`'s script. */
export type ScriptedGenerateStep =
  | { readonly kind: 'respond'; readonly response: GenerateResponse }
  | { readonly kind: 'stream'; readonly chunks: readonly unknown[] }
  | { readonly kind: 'block'; readonly barrier: string }
  | { readonly kind: 'fail'; readonly error: unknown }
  | { readonly kind: 'ignore-abort'; readonly then: ScriptedGenerateStep };

/**
 * Every input AB-93's source specification requires a script to assert a
 * generate call received. `assertReceived` compares only the fields the
 * caller supplies (an omitted field is never checked, including one the
 * caller explicitly sets to `undefined` — see that method's own doc
 * comment), so a partial expectation never over-asserts.
 */
export interface ScriptedGenerateExpectation {
  readonly conversation: Conversation;
  readonly tools: readonly string[];
  readonly model?: string;
  readonly effort?: Effort;
  readonly signal?: AbortSignal;
  readonly traceContext?: unknown;
}

/** One recorded call: the raw context the generate call received, plus the ambient trace context captured at entry. */
export interface ScriptedGenerateCall {
  readonly context: GenerateContext;
  readonly traceContext: unknown;
}

export interface ScriptedGenerate extends GenerateFunction {
  readonly calls: readonly ScriptedGenerateCall[];
  readonly callCount: number;
  /**
   * Compares only the keys present on `expected` (via `Object.keys`, so a
   * key explicitly set to `undefined` is still checked) against the call at
   * `index`. `conversation` compares by reference identity — an
   * equal-but-different-instance conversation is a failure, matching how
   * the run layer threads a single instance through. `signal` compares by
   * the signal's `aborted` state rather than reference identity: the run
   * layer derives the signal a generate call actually receives
   * (`stepSignal` in `run-step.ts`) from `RunOptions.signal` rather than
   * forwarding that same instance, so no caller could ever observe
   * reference equality against the signal it constructed. Every other field
   * compares by `Bun.deepEquals`. Throws, naming both the actual and
   * expected value, on any mismatch or when `index` is out of range for
   * `calls`/`callCount`.
   */
  assertReceived(index: number, expected: Partial<ScriptedGenerateExpectation>): void;
  /** Resolves once the double has arrived at the named `block` barrier. */
  reached(barrier: string): Promise<void>;
  /** Unblocks whichever call is waiting at the named `block` barrier. */
  release(barrier: string): void;
  /**
   * Wraps `RunOptions.withTraceContext`. A test that wants `assertReceived`
   * to see `traceContext` wires this in as `RunOptions.withTraceContext` —
   * `GenerateContext` itself carries no `traceContext` field (the run layer
   * threads it around the generate call via `withTraceContext`, not through
   * the context object; see `trace-context.test.ts`), so this double
   * captures the ambient value synchronously, before any `await`, the
   * moment a wrapped call begins.
   */
  withTraceContext: <T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>;
}

function isAbortSignalLike(value: unknown): value is Pick<AbortSignal, 'aborted'> {
  return typeof value === 'object' && value !== null && 'aborted' in value;
}

function fieldsEqual(
  key: keyof ScriptedGenerateExpectation,
  actual: unknown,
  expected: unknown,
): boolean {
  if (key === 'conversation') return actual === expected;
  if (key === 'signal') {
    const actualAborted = isAbortSignalLike(actual) ? actual.aborted : undefined;
    const expectedAborted = isAbortSignalLike(expected) ? expected.aborted : undefined;
    return actualAborted === expectedAborted;
  }
  return Bun.deepEquals(actual, expected);
}

/**
 * A display-safe stringification for an assertion-failure message: some
 * expectation values (`Conversation`, `AbortSignal`) are cyclic and throw
 * out of `JSON.stringify`, so this falls back to the value's constructor
 * name rather than crashing the assertion it's trying to report.
 */
function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    if (value && typeof value === 'object') {
      return `<${value.constructor.name}>`;
    }
    return String(value);
  }
}

function resolveExpectedField(
  call: ScriptedGenerateCall,
  key: keyof ScriptedGenerateExpectation,
): unknown {
  switch (key) {
    case 'conversation':
      return call.context.conversation;
    case 'tools':
      return call.context.toolbox.tools().map((tool) => tool.name);
    case 'model':
      return call.context.steering?.model;
    case 'effort':
      return call.context.steering?.effort;
    case 'signal':
      return call.context.signal;
    case 'traceContext':
      return call.traceContext;
    default: {
      const exhaustive: never = key;
      throw new Error(`assertReceived: unknown expectation field ${String(exhaustive)}`);
    }
  }
}

/**
 * Creates a scripted `GenerateFunction` double: one `ScriptedGenerateStep`
 * is consumed per call, in order, except that a `'block'` step is
 * transparent to the caller — arriving at it signals `reached`, then the
 * call suspends until `release` is called for that barrier, after which the
 * SAME call consumes and resolves the next step in `script` (so
 * `[{ kind: 'block', barrier: 'b' }, { kind: 'respond', response }]`
 * describes one call that blocks at `b` and then resolves with `response`).
 */
export function createScriptedGenerate(script: readonly ScriptedGenerateStep[]): ScriptedGenerate {
  const coordinator = new BarrierCoordinator();
  const calls: ScriptedGenerateCall[] = [];
  let nextStepIndex = 0;
  let currentTraceContext: unknown;

  async function resolveStep(
    step: ScriptedGenerateStep,
    context: GenerateContext & { streaming?: StreamingHandle },
  ): Promise<GenerateResponse> {
    switch (step.kind) {
      case 'respond':
        return step.response;
      case 'fail':
        throw step.error;
      case 'ignore-abort':
        // Deliberately does not observe `context.signal` — resolves `then`
        // regardless of whether the signal has fired, proving cancellation
        // is enforced by the run layer's post-generate check, not by the
        // provider racing the signal.
        return resolveStep(step.then, context);
      case 'stream': {
        let content = '';
        for (const chunk of step.chunks) {
          content += typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
          context.streaming?.update(content);
        }
        return { content, toolCalls: [] };
      }
      case 'block': {
        coordinator.arrive(step.barrier);
        await coordinator.awaitRelease(step.barrier);
        const next = script[nextStepIndex];
        nextStepIndex++;
        if (!next) {
          throw new Error(
            `createScriptedGenerate: barrier "${step.barrier}" released but no step follows it`,
          );
        }
        return resolveStep(next, context);
      }
      default: {
        const exhaustive: never = step;
        throw new Error(`createScriptedGenerate: unknown step kind ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  const generate = async (
    context: GenerateContext & { streaming?: StreamingHandle },
  ): Promise<GenerateResponse> => {
    // Captured synchronously, before any `await`, so a `withTraceContext`
    // wrapper active at call time is the one attributed to this call even
    // though `withTraceContext` also wraps tool execution.
    calls.push({ context, traceContext: currentTraceContext });

    const step = script[nextStepIndex];
    nextStepIndex++;
    if (!step) {
      throw new Error(
        `createScriptedGenerate: no step at index ${nextStepIndex - 1} (${script.length} total)`,
      );
    }
    return resolveStep(step, context);
  };

  const assertReceived = (index: number, expected: Partial<ScriptedGenerateExpectation>): void => {
    const call = calls[index];
    if (!call) {
      throw new Error(`assertReceived: no call at index ${index} (callCount is ${calls.length})`);
    }
    for (const key of Object.keys(expected) as (keyof ScriptedGenerateExpectation)[]) {
      const actual = resolveExpectedField(call, key);
      const expectedValue = expected[key];
      if (!fieldsEqual(key, actual, expectedValue)) {
        throw new Error(
          `assertReceived: call ${index} field "${key}" mismatch — ` +
            `expected ${describeValue(expectedValue)}, actual ${describeValue(actual)}`,
        );
      }
    }
  };

  const scriptedGenerate = generate as ScriptedGenerate;
  Object.defineProperty(scriptedGenerate, 'calls', { get: () => calls });
  Object.defineProperty(scriptedGenerate, 'callCount', { get: () => calls.length });
  scriptedGenerate.assertReceived = assertReceived;
  scriptedGenerate.reached = (barrier: string) => coordinator.reached(barrier);
  scriptedGenerate.release = (barrier: string) => coordinator.release(barrier);
  scriptedGenerate.withTraceContext = async <T>(
    parentContext: unknown,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const previous = currentTraceContext;
    currentTraceContext = parentContext;
    try {
      return await fn();
    } finally {
      currentTraceContext = previous;
    }
  };

  return scriptedGenerate;
}
