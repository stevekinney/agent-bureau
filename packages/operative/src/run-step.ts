import type { AnyToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import type { RuntimeServices } from 'lifecycle';
import type { ZodType } from 'zod';

import type { AgentRunErrorKind } from './errors';
import {
  GenerateCompletedEvent,
  ResponseValidatedEvent,
  RunErrorEvent,
  StepAbortedEvent,
} from './events';
import { finalizeStep } from './run-step-finalization';
import { executeGeneration } from './run-step-generation';
import { prepareStep } from './run-step-preparation';
import { accumulateUsage } from './run-step-support';
import { executeTools } from './run-step-tools';
import { explicitAbortReason } from './run-step-utilities';
import type { SelectionGate } from './selection-gate';
import type { ToolChoice } from './structured-output/types';
import type {
  AfterToolExecutionHook,
  BeforeToolExecutionHook,
  ContextManagementOptions,
  GenerateContext,
  OnElicitation,
  OnStepHook,
  PrepareStepHook,
  RetryOptions,
  RunOptions,
  SelectToolsHook,
  SteeringGate,
  StepResult,
  StopCondition,
  TokenUsage,
  ValidateResponseHook,
  ValidateToolResultHook,
} from './types';

export { awaitResumeOrAbort, normalizeToArray, runHookSilently } from './run-step-utilities';

/**
 * Minimal structural type for an event emitter. The loop and step never depend
 * on the concrete `CompletableEventTarget`; they only dispatch.
 */
export type EventDispatcher = {
  dispatch(event: Event): boolean;
};

/**
 * The default safety bound on step count when {@link RunOptions.maximumSteps} is
 * not set. Shared by every driver — the in-memory `executeLoop`, the run-level
 * lifecycle, and the durable `agentRun` workflow — so the in-memory and durable
 * paths can never silently disagree on how many steps an unbounded run takes.
 */
export const DEFAULT_MAXIMUM_STEPS = 25;

/**
 * The loop-invariant dependencies of a run. Every field is derived once from
 * {@link RunOptions} before the step loop begins and never mutated. Splitting
 * the run's ~20 locals into this immutable bag plus the mutable {@link RunState}
 * is what lets a single step be a self-contained, relocatable unit — and what
 * lets the durable driver checkpoint only the small, cloneable {@link RunState}.
 */
export interface StepDeps {
  readonly generate: RunOptions['generate'];
  readonly toolbox: AnyToolbox;
  readonly executeOptions: RunOptions['executeOptions'];
  readonly signal: AbortSignal | undefined;
  readonly collectAsync: boolean;
  readonly retry: RetryOptions | undefined;
  readonly backpressure: RunOptions['backpressure'];
  readonly onElicitation: OnElicitation | undefined;
  readonly hooks: RunOptions['hooks'];
  readonly contextManagement: ContextManagementOptions | undefined;
  readonly output: ZodType<unknown> | undefined;
  readonly responseFormat: GenerateContext['responseFormat'];
  /** Per-request output token cap passed through to every GenerateContext. */
  readonly maximumTokens: number | undefined;
  readonly schemaRetries: number;
  readonly schemaRetryMessage: RunOptions['schemaRetryMessage'];
  readonly parentContext: unknown;
  readonly withTraceContext: RunOptions['withTraceContext'];
  readonly runId: string | undefined;
  /**
   * AB-233 — this run's own child registry, passed to every tool call as
   * `ToolContext.executionContext.childRegistry` (see the toolbox execute
   * call site below), not captured once at tool-construction time.
   */
  readonly childRegistry: RunOptions['childRegistry'];
  /**
   * AB-300 — this run's own already-attenuated delegated-authority grant,
   * passed to every tool call as
   * `ToolContext.executionContext.delegatedAuthority` (see the toolbox
   * execute call site below), matching `childRegistry`'s own AB-233
   * pattern.
   */
  readonly delegatedAuthority: RunOptions['delegatedAuthority'];
  readonly durableOperationKeys: boolean;
  readonly defaultToolChoice: ToolChoice | undefined;
  /**
   * The AB-67 runtime steering gate, threaded from `RunOptions.steering`.
   * `undefined` when the run has no steering dependency configured — the
   * boundary read below is skipped entirely and behavior is unchanged.
   */
  readonly steering: SteeringGate | undefined;
  /**
   * The AB-64/AB-250 selection-revalidation gate, threaded from
   * `RunOptions.selection`. `undefined` when the run has no selection
   * dependency configured — the boundary read below is skipped entirely
   * and behavior is unchanged.
   */
  readonly selection: SelectionGate | undefined;
  readonly stopConditions: StopCondition[];
  readonly prepareStepHooks: PrepareStepHook[];
  readonly beforeToolExecutionHooks: BeforeToolExecutionHook[];
  readonly afterToolExecutionHooks: AfterToolExecutionHook[];
  readonly onStepHooks: OnStepHook[];
  readonly selectToolsHooks: SelectToolsHook[];
  readonly validateResponseHooks: ValidateResponseHook[];
  readonly validateToolResultHooks: ValidateToolResultHook[];
  /** Maximum number of retries the onError hook can request per step. */
  readonly maxErrorRetries: number;
  /**
   * AB-92/AB-252 — the run's resolved `RuntimeServices` instance. Every
   * wall-clock, monotonic-duration, timer, and randomness read inside this
   * step goes through it, never a real global directly.
   */
  readonly runtime: RuntimeServices;
  readonly agentName: string | undefined;
  /**
   * AB-204: when supplied, every run-owned hook's fire-and-forget promise
   * (`onLLMInput`/`onLLMOutput` here; `onRunComplete`/`onRunAbort`/
   * `onRunError` in `run-lifecycle.ts`) is handed to this callback so
   * `closed()` can await genuine hook completion instead of acknowledging
   * cleanup while a hook is still running. `undefined` for a caller that
   * doesn't need the acknowledgement (e.g. a bare `executeLoop` caller that
   * never calls `closed()`) — hooks still run exactly the same either way.
   */
  readonly hookTracker?: (promise: Promise<unknown>) => void;
  /**
   * AB-239 — invoked by `runStep` itself ONCE, at step start, with that
   * step's resolved toolbox (`deps.toolbox`, or a `selectTools`
   * replacement), immediately after resolution. The driver (`loop.ts`'s
   * `executeLoop` / `run-workflow.ts`) invokes the SAME callback a second
   * time, at step end (after `runStep` returns) with `deps.toolbox` — so
   * across one step this fires twice: swapped-or-base at start, base at end.
   * Lets the driver (`create-run.ts` / `active-run-adapter.ts`) keep
   * `toolbox.*` event forwarding attached to whichever toolbox instance this
   * step actually executes tools against, for exactly that step's duration.
   * `undefined` for a driver that builds no run emitter (e.g.
   * `startDurableRunResult`'s headless scheduler runs) — see
   * `ToolboxEventForwarder`.
   */
  readonly onStepToolbox?: (toolbox: AnyToolbox) => void;
}

/**
 * The mutable, run-level accumulators carried across steps. Every field is
 * plain and cloneable so the durable driver can checkpoint it directly. The
 * `Conversation` is the one non-plain piece; it is carried alongside (a live
 * instance in `executeLoop`, rehydrated from a snapshot per step in the durable
 * driver) and never embedded in `RunState`.
 */
export interface RunState {
  steps: StepResult[];
  totalUsage: TokenUsage;
  lastContent: string;
  /** Run-scoped count of structured-output schema retries already consumed. */
  schemaAttempts: number;
  /**
   * The `configVersion` `SteeringAppliedEvent` last fired for, on this run.
   * AB-221: `steering.applied` fires once per accepted command — once per
   * distinct `configVersion` this run observes at the boundary — never once
   * per step. `0` (the default, un-steered `SteeringDesiredState.configVersion`)
   * never fires: it means no command has ever been accepted.
   */
  lastAppliedConfigVersion: number;
}

/**
 * The discriminated result of a single {@link runStep} call. The driver
 * switches on `kind` to reproduce the original loop's control flow:
 *
 * - `next`: the step completed; advance to the next step.
 * - `continue`: re-enter the loop without advancing the run-level result —
 *   used for skipped steps, per-step aborts, and schema-retry re-prompts (the
 *   user message is already appended and `schemaAttempts` already bumped).
 * - `stop`: a stop condition fired; the run finishes successfully.
 * - `abort`: the run-level signal aborted; the driver builds the abort result.
 * - `error`: an error escaped recovery; the driver builds the error result.
 */
export type StepOutcome =
  | { kind: 'next' }
  | { kind: 'continue' }
  | {
      kind: 'stop';
      // A step only ever stops the run by a stop condition firing; `maximum-steps`
      // is decided by the driver's loop bound, not a step.
      finishReason: 'stop-condition';
      schemaValidation?: { success: boolean; error?: unknown };
      /** The validated structured output — set only on a successful `schemaValidation`. */
      output?: unknown;
    }
  | { kind: 'abort'; reason?: string }
  | { kind: 'error'; error: unknown; errorKind?: AgentRunErrorKind };

/**
 * Executes exactly one iteration of the agent loop against a live
 * {@link Conversation}, mutating it in place and pushing any completed step
 * into `runState.steps`. This is the entire per-step body extracted verbatim
 * from the original `executeLoop` `for` body — generate (with retry, hooks,
 * and the `prepareStep`/`beforeGenerate`/`afterGenerate` waterfall), the
 * `onError` recovery do/while, response validation, tool execution and its
 * `onError` recovery, tool-result validation, the `afterToolExecution` hooks,
 * stop-condition evaluation, and the structured-output schema-retry decision.
 *
 * The single behavioral change versus the inline body is mechanical: where the
 * inline body did `return makeAbortResult(...)`, `return makeErrorResult(...)`,
 * `continue`, or `return runResult`, this returns a discriminated
 * {@link StepOutcome} and lets the driver reproduce that control flow. The
 * schema-retry `continue` (originally `loop.ts:1014`) is an end-of-step
 * decision — the correction user message is appended and `runState.schemaAttempts`
 * is bumped before returning `{ kind: 'continue' }` — so it is a clean step
 * boundary, not mid-step re-entry. That is what makes the durable driver able
 * to call this same function once per `yield*`-delimited step.
 */
export async function runStep(
  deps: StepDeps,
  runState: RunState,
  conversation: Conversation,
  step: number,
  emitter: EventDispatcher | undefined,
): Promise<StepOutcome> {
  const { signal, hooks } = deps;
  if (signal?.aborted) {
    return { kind: 'abort', reason: explicitAbortReason(signal) };
  }

  // AB-67 steering boundary: read the session's desired steering state
  // exactly once per step, at this shared entry point (both the in-memory
  // `executeLoop` `for` loop and the durable `run-workflow.ts` per-step
  // `ctx.memo` reach this once per step, never mid-generate, mid-tool-
  // execution, or on a same-step retry). `deps.steering` is undefined for a
  // run with no steering dependency configured — that is a complete no-op,
  // matching today's non-steerable behavior exactly.
  //
  // Each read is copied (`{ ...state }`), never the gate's own returned
  // reference: a real gate is free to keep one mutable desired-state object
  // it updates in place as commands are admitted, and forwarding that live
  // reference into `GenerateContext.steering` would let a later mutation
  // become visible to this step's already-captured context — the exact
  // same-step leak the mid-step-admission acceptance criterion forbids.
  //
  // AB-221: dispatch `steering.applied` for a desired state this boundary
  // just read, deduplicated by `configVersion` — extracted so it can run
  // after EVERY boundary read below, not only after the pause-wait loop
  // exits. This matters for pause/resume specifically: AB-67's pause row
  // fixes the application boundary as "entry of runStep" and its terminal
  // behavior as "applied at the boundary" — the read itself is what applies
  // a pause, independent of whether the driver then blocks waiting for a
  // resume. Firing only once, after the loop, would silently skip the
  // `applied` event for every `configVersion` that was paused-and-read but
  // then superseded by a later command before the loop exited — under-
  // counting exactly the command class this boundary exists to gate.
  //
  // Fires at most once per distinct `configVersion` this run observes:
  // `configVersion` increments by exactly one per accepted command (AB-67),
  // so "once per accepted command" is exactly "once per distinct
  // `configVersion` observed here" — `RunState.lastAppliedConfigVersion` is
  // the dedupe key, carried across steps for both drivers (in-memory: the
  // same `RunState` instance persists across the loop; durable: threaded
  // through `RunCursor.lastAppliedConfigVersion` like `schemaAttempts`).
  // `configVersion === 0` is the un-steered default (no command ever
  // accepted) and never fires.
  //
  // `deps.runId` is required to stamp `SteeringEffectiveState.appliedAtRunId`
  // (a required field — there is no honest way to leave it unset). AB-236
  // closes this at the type level: `RunOptions` makes `runId` required
  // whenever `steering` is set (see `types.ts`'s `RunOptions` doc comment),
  // so a real caller can no longer construct a steering-enabled `RunOptions`
  // with no `runId` — `buildStepDeps`/`executeLoop`/`createActiveRun` always
  // thread one through. This `deps.runId !== undefined` check stays as
  // defense in depth against `StepDeps` built by hand (bypassing
  // `RunOptions` entirely, as `run-step.test.ts`'s
  // "never fires when the run has no runId" test does) rather than a
  // reachable gap in any real driver.
  //
  // NOT solved here, same root cause for both: `SteeringDesiredState` is an
  // AGGREGATE — one `configVersion` covering every steerable field at once,
  // with no per-target or applied-history information (AB-67's ratified
  // shape) — so this boundary cannot distinguish "this bump changed a field
  // that applies now" from "this bump changed a field that applies later"
  // or "from a field this run already consumed."
  //
  // - A session whose `configVersion` a PRIOR run already applied.
  //   `RunState.lastAppliedConfigVersion` is per-run, so a new run starting
  //   fresh re-observes and re-fires for a `configVersion` an earlier run
  //   on the same session already applied.
  // - `agentName` (an `agent-identity` command): AB-67 fixes its effective
  //   boundary as the FIRST STEP OF THE SESSION'S NEXT RUN, not the current
  //   run's next boundary read — "agent-identity commands stay `accepted`
  //   and carry forward to the next run's boundary." This boundary has no
  //   way to know a `configVersion` bump was identity-only (or identity
  //   bundled with an in-run field like `route`) versus purely an in-run
  //   field, so it currently reports EVERY bump as applied to the current
  //   run, including one that should not take effect until the next run.
  //   Diffing the previous and current `SteeringDesiredState` snapshots
  //   in-place to detect "only `agentName` changed" would still be wrong
  //   for the bundled case — the stamped `SteeringEffectiveState.agentName`
  //   would claim effect for a run whose already-resolved agent, toolbox,
  //   generator, and hooks never actually changed.
  //
  // Both need the `SteeringGate` itself — read-only from this boundary's
  // side (`getDesiredState()`/`awaitResume()`) — to carry target- and
  // history-aware write-side state: which fields are due now versus at the
  // next run boundary, and what a prior run already consumed. That is
  // AB-199's `SteeringGate` implementation's responsibility, not this
  // boundary's; AB-221's own scope excludes reopening AB-67's
  // `SteeringDesiredState`/`RunOptions` shapes to add it.
  const preparation = await prepareStep({ deps, runState, conversation, step, emitter });
  if ('kind' in preparation) return preparation;
  const {
    steeringDesiredState,
    stepAbortController,
    stepSignal,
    abortStep,
    elicit,
    stepToolbox,
    stepToolChoice,
  } = preparation;

  const generation = await executeGeneration({
    deps,
    conversation,
    step,
    emitter,
    stepSignal,
    abortStep,
    elicit,
    steeringDesiredState,
    stepToolbox,
    stepToolChoice,
  });
  if ('kind' in generation) return generation;
  const { stepSkipped, generateDurationMilliseconds } = generation;
  let { response } = generation;

  // If the step was skipped via onError recovery, move to the next step
  if (stepSkipped) return { kind: 'continue' };

  // Validate response guardrail
  if (deps.validateResponseHooks.length > 0) {
    try {
      for (const hook of deps.validateResponseHooks) {
        const originalResponse = { ...response };
        const validated = await hook(response, {
          conversation,
          step,
          signal: stepSignal,
          abortStep,
          elicit,
        });
        if (validated) {
          emitter?.dispatch(new ResponseValidatedEvent(step, originalResponse, validated));
          response = validated;
        }
      }
    } catch (error) {
      // The provider call already completed (and may have been metered)
      // before this hook ran — e.g. the default output-guardrail tripwire
      // throws GuardrailTripwireError here. Accumulate the response's usage
      // before returning the error result so a tripwire-halted run still
      // reports the cost of the generate call that triggered it.
      accumulateUsage(runState, emitter, step, response.usage);
      emitter?.dispatch(new RunErrorEvent(step, error, 'output'));
      return { kind: 'error', error, errorKind: 'output' };
    }
  }
  if (hooks?.has('validateResponse')) {
    try {
      const originalResponse = { ...response };
      const validated = await hooks.run('validateResponse', response, {
        conversation,
        step,
        signal: stepSignal,
        abortStep,
        elicit,
      });
      if (validated !== undefined && validated !== response) {
        emitter?.dispatch(new ResponseValidatedEvent(step, originalResponse, validated));
        response = validated;
      }
    } catch (error) {
      // See the comment on the validateResponseHooks catch above — the
      // response has already been billed by the provider.
      accumulateUsage(runState, emitter, step, response.usage);
      emitter?.dispatch(new RunErrorEvent(step, error, 'output'));
      return { kind: 'error', error, errorKind: 'output' };
    }
  }

  // AB-302: dispatch `generate.completed` here, after BOTH output-guardrail
  // validation blocks above (`deps.validateResponseHooks` — e.g. the
  // `createGuardrails().validateResponse` hook bureau wires into that array
  // for its default and caller-supplied guardrail presets — and the
  // `validateResponse` hook registry), rather than immediately after the
  // raw provider response comes back. A guardrail configured with
  // `action: 'redact'` (or `'block'`) replaces `response.content` in those
  // blocks; consumers of this live event frame (SSE/WebSocket subscribers,
  // OTel spans, any `generate.completed` listener) must see that
  // substituted content, never the pre-guardrail original, so the event
  // frame carries the same content the run's final result carries. Only
  // fires when an actual generate call happened this step —
  // `generateDurationMilliseconds` stays `undefined` when a `prepareStep`
  // hook short-circuited generation entirely (see its declaration above),
  // matching this function's prior behavior of never emitting
  // `generate.completed` for a prepareStep-short-circuited step.
  //
  // Streaming deltas (`stream:text-delta`, emitted by
  // `withEnhancedStreaming`/`composeConfiguredGenerate` while the provider
  // call above is still in flight) are a separate, already-decided surface:
  // bureau's `runtime-composition.ts` (AB-40) forces buffered, non-streaming
  // generation whenever its auto-wired default guardrail preset is active,
  // specifically so no delta reaches a client before this post-guardrail
  // point. A caller who explicitly supplies a custom `guardrails` config (as
  // opposed to leaving it `undefined`) has opted into managing that
  // tradeoff themselves per that same file's comment, and streaming deltas
  // for such a run remain pre-guardrail by design.
  if (generateDurationMilliseconds !== undefined) {
    emitter?.dispatch(new GenerateCompletedEvent(step, response, generateDurationMilliseconds));
  }

  if (signal?.aborted) {
    return { kind: 'abort', reason: explicitAbortReason(signal) };
  }

  if (stepSignal.aborted && !signal?.aborted) {
    emitter?.dispatch(new StepAbortedEvent(step, explicitAbortReason(stepAbortController.signal)));
    return { kind: 'continue' };
  }

  const { content, usage, metadata } = response;
  runState.lastContent = content;
  accumulateUsage(runState, emitter, step, usage);

  if (content && !response.messageAppended) {
    conversation.appendAssistantMessage(content, metadata);
  }

  const toolExecution = await executeTools({
    deps,
    conversation,
    step,
    emitter,
    signal,
    stepSignal,
    abortStep,
    elicit,
    stepToolbox,
    toolCallInputs: response.toolCalls,
    emittedSettledCallIds: new Set<string>(),
    stepAbortController,
  });
  if ('kind' in toolExecution) return toolExecution;
  const { materializedToolCalls, results } = toolExecution;

  return finalizeStep({
    deps,
    runState,
    conversation,
    step,
    emitter,
    response,
    materializedToolCalls,
    results,
  });
}
