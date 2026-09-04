import type { Tool, ToolCall, ToolContext } from 'armorer';
import { createTool } from 'armorer';
import { z } from 'zod';

import type { AfterGenerateContext, BeforeGenerateContext } from '../hooks/types';
import type {
  GenerateContext,
  GenerateResponse,
  ToolExecutionHookContext,
  ToolExecutionResultContext,
} from '../types';
import type { BarrierRegistry } from './barriers';
import { BarrierCoordinator } from './scripted-generate';

/** One recorded settlement of a scripted tool or hook call. */
export interface ScriptedSettlement {
  readonly index: number;
  readonly outcome: 'resolved' | 'rejected';
  readonly value?: unknown;
  readonly error?: unknown;
}

/**
 * Tracks per-call settlement without letting an intentionally-rejected call
 * surface as an unhandled rejection: the tracking `.then` is attached
 * synchronously, in the same tick the call's promise is created, so Bun
 * never sees the original promise go unhandled even though the caller
 * (toolbox/hook registry) also awaits it and reacts to the rejection on its
 * own critical path.
 */
class SettlementTracker {
  private readonly tracked: Promise<ScriptedSettlement>[] = [];

  // Explicit (even though empty) — see the matching comment on
  // `BarrierCoordinator` in `scripted-generate.ts`: Bun's coverage
  // instrumenter counts a class's implicit default constructor as an
  // unhittable function, failing the 100%-functions gate.
  constructor() {}

  track<T>(index: number, promise: Promise<T>): void {
    this.tracked.push(
      promise.then(
        (value): ScriptedSettlement => ({ index, outcome: 'resolved', value }),
        (error): ScriptedSettlement => ({ index, outcome: 'rejected', error }),
      ),
    );
  }

  settled(): Promise<readonly ScriptedSettlement[]> {
    return Promise.all(this.tracked);
  }
}

// ---------------------------------------------------------------------------
// Scripted tool
// ---------------------------------------------------------------------------

/** One step in a `ScriptedTool`'s or `ScriptedHook`'s script. */
export type ScriptedToolStep =
  | { readonly kind: 'resolve'; readonly result: unknown }
  | { readonly kind: 'reject'; readonly error: unknown }
  | { readonly kind: 'block'; readonly barrier: string };

/** One recorded tool call. */
export interface ScriptedToolCall {
  readonly params: unknown;
  readonly context: ToolContext;
}

export interface ScriptedTool extends Tool {
  readonly calls: readonly ScriptedToolCall[];
  readonly callCount: number;
  reached(barrier: string): Promise<void>;
  release(barrier: string): void;
  /** The `BarrierRegistry` (AB-266) this double's `block` steps arrive at and release through; see `ScriptedGenerate.barriers`. */
  readonly barriers: BarrierRegistry;
  settled(): Promise<readonly ScriptedSettlement[]>;
}

async function resolveToolStep(
  step: ScriptedToolStep,
  script: readonly ScriptedToolStep[],
  cursor: { index: number },
  coordinator: BarrierCoordinator,
): Promise<unknown> {
  if (step.kind === 'resolve') return step.result;
  if (step.kind === 'reject') throw step.error;

  coordinator.arrive(step.barrier);
  // Reserved synchronously, before awaiting release — see the matching
  // comment in `scripted-generate.ts`'s `resolveStep`: `Toolbox.execute()`
  // runs its calls in parallel, so two calls against the same double could
  // otherwise race to advance `cursor.index` while each was blocked.
  const next = script[cursor.index];
  cursor.index++;
  await coordinator.awaitRelease(step.barrier);
  if (!next) {
    throw new Error(
      `createScriptedTool: barrier "${step.barrier}" released but no step follows it`,
    );
  }
  return resolveToolStep(next, script, cursor, coordinator);
}

/**
 * Creates a scripted tool double: one `ScriptedToolStep` is consumed per
 * call. A `block` step is transparent to the caller exactly as it is for
 * `createScriptedGenerate` — arriving signals `reached`, then the call
 * suspends until `release`, after which the same call consumes and settles
 * with the next script entry.
 */
export function createScriptedTool(
  name: string,
  script: readonly ScriptedToolStep[],
): ScriptedTool {
  const coordinator = new BarrierCoordinator();
  const tracker = new SettlementTracker();
  const calls: ScriptedToolCall[] = [];
  const cursor = { index: 0 };

  const tool = createTool({
    name,
    description: `Scripted test tool double for "${name}".`,
    // A Zod OBJECT schema is required (not `z.record`) — `catchall` accepts
    // any arbitrary key/value pair, which is what a script double needs
    // since it has no real parameter contract of its own.
    input: z.object({}).catchall(z.unknown()),
    execute: async (params: unknown, context: ToolContext): Promise<unknown> => {
      const callIndex = calls.length;
      calls.push({ params, context });

      const step = script[cursor.index];
      cursor.index++;
      if (!step) {
        throw new Error(
          `createScriptedTool: no step at index ${cursor.index - 1} (${script.length} total)`,
        );
      }
      const settlement = resolveToolStep(step, script, cursor, coordinator);
      tracker.track(callIndex, settlement);
      return settlement;
    },
  });

  const scriptedTool = tool as unknown as ScriptedTool;
  Object.defineProperty(scriptedTool, 'calls', { get: () => calls });
  Object.defineProperty(scriptedTool, 'callCount', { get: () => calls.length });
  scriptedTool.reached = (barrier: string) => coordinator.reached(barrier);
  scriptedTool.release = (barrier: string) => coordinator.release(barrier);
  Object.defineProperty(scriptedTool, 'barriers', { value: coordinator.registry });
  scriptedTool.settled = () => tracker.settled();

  return scriptedTool;
}

// ---------------------------------------------------------------------------
// Scripted hook
// ---------------------------------------------------------------------------

/** The four hook phases a `ScriptedHook` can script, named in the fault-plan vocabulary's `hook:${phase}` shape. */
export type ScriptedHookPhase = 'before-model' | 'after-model' | 'before-tool' | 'after-tool';

interface HookPhaseContext {
  'before-model': BeforeGenerateContext;
  'after-model': AfterGenerateContext;
  'before-tool': ToolExecutionHookContext;
  'after-tool': ToolExecutionResultContext;
}

interface HookPhaseResult {
  'before-model': GenerateContext | void;
  'after-model': GenerateResponse | void;
  'before-tool': ToolCall[];
  'after-tool': void;
}

/** The `OperativeHookMap` key each phase registers against. */
interface HookPhaseName {
  'before-model': 'beforeGenerate';
  'after-model': 'afterGenerate';
  'before-tool': 'beforeToolExecution';
  'after-tool': 'afterToolExecution';
}

const HOOK_NAME: { readonly [P in ScriptedHookPhase]: HookPhaseName[P] } = {
  'before-model': 'beforeGenerate',
  'after-model': 'afterGenerate',
  'before-tool': 'beforeToolExecution',
  'after-tool': 'afterToolExecution',
};

/** One resolve/reject/block step for a specific hook phase, typed to that phase's result shape. */
export type ScriptedHookStep<P extends ScriptedHookPhase> =
  | { readonly kind: 'resolve'; readonly value: HookPhaseResult[P] }
  | { readonly kind: 'reject'; readonly error: unknown }
  | { readonly kind: 'block'; readonly barrier: string };

/** One recorded hook call. */
export interface ScriptedHookCall<P extends ScriptedHookPhase> {
  readonly context: HookPhaseContext[P];
}

export interface ScriptedHook<P extends ScriptedHookPhase> {
  (context: HookPhaseContext[P]): Promise<HookPhaseResult[P]>;
  readonly phase: P;
  /** The `OperativeHookMap` key to register this double under: `hooks.on(hook.hookName, hook)`. */
  readonly hookName: HookPhaseName[P];
  readonly calls: readonly ScriptedHookCall<P>[];
  readonly callCount: number;
  reached(barrier: string): Promise<void>;
  release(barrier: string): void;
  /** The `BarrierRegistry` (AB-266) this double's `block` steps arrive at and release through; see `ScriptedGenerate.barriers`. */
  readonly barriers: BarrierRegistry;
  settled(): Promise<readonly ScriptedSettlement[]>;
}

async function resolveHookStep<P extends ScriptedHookPhase>(
  step: ScriptedHookStep<P>,
  script: readonly ScriptedHookStep<P>[],
  cursor: { index: number },
  coordinator: BarrierCoordinator,
): Promise<HookPhaseResult[P]> {
  if (step.kind === 'resolve') return step.value;
  if (step.kind === 'reject') throw step.error;

  coordinator.arrive(step.barrier);
  // Reserved synchronously, before awaiting release — see the matching
  // comment in `resolveToolStep`/`scripted-generate.ts`'s `resolveStep`: a
  // hook double invoked concurrently could otherwise race to advance
  // `cursor.index` while each call was blocked.
  const next = script[cursor.index];
  cursor.index++;
  await coordinator.awaitRelease(step.barrier);
  if (!next) {
    throw new Error(
      `createScriptedHook: barrier "${step.barrier}" released but no step follows it`,
    );
  }
  return resolveHookStep(next, script, cursor, coordinator);
}

/**
 * Creates a scripted hook double for one of the four phases the fault-plan
 * vocabulary's `hook:${phase}` operation names. One `ScriptedHookStep` is
 * consumed per call; `block` behaves exactly as it does for
 * `createScriptedTool`/`createScriptedGenerate`.
 */
export function createScriptedHook<P extends ScriptedHookPhase>(
  phase: P,
  script: readonly ScriptedHookStep<P>[],
): ScriptedHook<P> {
  const coordinator = new BarrierCoordinator();
  const tracker = new SettlementTracker();
  const calls: ScriptedHookCall<P>[] = [];
  const cursor = { index: 0 };

  const handler = async (context: HookPhaseContext[P]): Promise<HookPhaseResult[P]> => {
    const callIndex = calls.length;
    calls.push({ context });

    const step = script[cursor.index];
    cursor.index++;
    if (!step) {
      throw new Error(
        `createScriptedHook: no step at index ${cursor.index - 1} (${script.length} total)`,
      );
    }
    const settlement = resolveHookStep(step, script, cursor, coordinator);
    tracker.track(callIndex, settlement);
    return settlement;
  };

  Object.defineProperty(handler, 'phase', { value: phase, enumerable: true });
  Object.defineProperty(handler, 'hookName', { value: HOOK_NAME[phase], enumerable: true });
  Object.defineProperty(handler, 'calls', { get: () => calls });
  Object.defineProperty(handler, 'callCount', { get: () => calls.length });

  const scriptedHook = handler as ScriptedHook<P>;
  scriptedHook.reached = (barrier: string) => coordinator.reached(barrier);
  scriptedHook.release = (barrier: string) => coordinator.release(barrier);
  Object.defineProperty(scriptedHook, 'barriers', { value: coordinator.registry });
  scriptedHook.settled = () => tracker.settled();

  return scriptedHook;
}
