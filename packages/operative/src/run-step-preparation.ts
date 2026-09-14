import type { AnyToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import type { SteeringDesiredState } from './durable/types';
import { SelectionRevalidationError } from './errors';
import {
  BackpressureAppliedEvent,
  BackpressureReleasedEvent,
  ContextBudgetWarningEvent,
  ContextCompactedEvent,
  RunErrorEvent,
  SteeringAppliedEvent,
  StepStartedEvent,
} from './events';
import type { EventDispatcher, RunState, StepDeps, StepOutcome } from './run-step';
import { createElicit } from './run-step-support';
import { awaitResumeOrAbort, explicitAbortReason } from './run-step-utilities';
import type { ToolChoice } from './structured-output/types';

export interface StepPreparationDependencies {
  deps: StepDeps;
  runState: RunState;
  conversation: Conversation;
  step: number;
  emitter: EventDispatcher | undefined;
}
export interface StepPreparationResult {
  steeringDesiredState: SteeringDesiredState | undefined;
  stepAbortController: AbortController;
  stepSignal: AbortSignal;
  abortStep: (reason?: string) => void;
  elicit: ReturnType<typeof createElicit> | undefined;
  stepToolbox: AnyToolbox;
  stepToolChoice: ToolChoice | undefined;
}

export async function prepareStep(
  input: StepPreparationDependencies,
): Promise<StepPreparationResult | StepOutcome> {
  const { deps, runState, conversation, step, emitter } = input;
  const { signal, backpressure, hooks } = deps;
  const steeringGate = deps.steering;
  const maybeDispatchSteeringApplied = (state: SteeringDesiredState) => {
    if (
      steeringGate &&
      state.configVersion > 0 &&
      // Strictly greater, not merely unequal (review finding, PR #430 —
      // Codex P2, "Do not seed a run above its visible steering version"):
      // `RunState.lastAppliedConfigVersion` is seeded from the gate's
      // SESSION-WIDE `getAppliedFloor()` (`executeLoop`/`run-workflow.ts`'s
      // `initialCursor`), which can already exceed a brand-new run's own
      // VISIBLE `configVersion` when a differently-scoped command (a pause
      // bound to a different, earlier run) advanced the floor past this
      // run's own identity-only baseline. An unequal-only comparison would
      // then re-fire `steering.applied` for that lower, already-applied
      // version the moment this run's boundary observes it — the cursor
      // must only ever advance, never treat a state genuinely BELOW its
      // current seed as new.
      state.configVersion > runState.lastAppliedConfigVersion &&
      deps.runId !== undefined &&
      // Advancing the dedupe cursor must be conditioned on an emitter
      // actually being present to dispatch to, exactly like `deps.runId`
      // above. `emitter?.dispatch(...)` alone would silently "consume" a
      // `configVersion` with no emitter (a real, if narrow, caller shape —
      // `executeLoop`'s `emitter` parameter is optional) — the event never
      // fires anywhere, yet the cursor reports it applied, so nothing ever
      // gets a chance to observe it, this run or a later one sharing the
      // same durable cursor.
      emitter !== undefined
    ) {
      runState.lastAppliedConfigVersion = state.configVersion;
      emitter.dispatch(
        new SteeringAppliedEvent(steeringGate.sessionId, {
          ...state,
          appliedAtStep: step,
          appliedAtRunId: deps.runId,
          appliedAt: deps.runtime.clock.nowISO(),
        }),
      );
    }
  };

  // The pause check is a loop, not a single `if`: a `resume` releasing
  // `awaitResume()` does not guarantee the freshly re-read state is
  // unpaused — a new `pause` can be admitted in the same turn a command
  // handler resolves the previous one's waiters. Keep waiting while the
  // state we just read is still `paused: true`, so the most recently
  // desired pause always wins.
  let steeringDesiredState = steeringGate ? { ...steeringGate.getDesiredState() } : undefined;
  if (steeringDesiredState) maybeDispatchSteeringApplied(steeringDesiredState);
  while (steeringDesiredState?.paused && steeringGate) {
    const { aborted } = await awaitResumeOrAbort(steeringGate, signal);
    if (aborted) {
      return { kind: 'abort', reason: explicitAbortReason(signal) };
    }
    steeringDesiredState = { ...steeringGate.getDesiredState() };
    maybeDispatchSteeringApplied(steeringDesiredState);
  }

  // AB-64/AB-250 selection boundary: revalidate a previously planned
  // backend selection against the CURRENT catalog/policy/availability
  // snapshot, at the same shared entry point as the steering boundary above
  // — after the pause-wait loop (a paused run must not revalidate until
  // resumed) and before backpressure. `deps.selection` is undefined for a
  // run with no selection dependency configured — that is a complete
  // no-op, matching today's non-selecting behavior exactly.
  //
  // `revalidate()` is synchronous and pure (see `SelectionGate`'s doc
  // comment): it performs no input or output and never awaits a provider.
  // A plan that no longer reaches `outcome: 'selected'` fails the step
  // outright with a typed `SelectionRevalidationError` carrying both the
  // failed replacement plan and the superseded plan it replaces — never
  // silently falling back to the superseded plan's model. Applying a
  // replacement plan to this step's own generate call is out of scope
  // (ABP-11 non-goal): a replacement plan is recorded and, on success,
  // simply supersedes the run's prior plan for the NEXT boundary to read.
  const selectionGate = deps.selection;
  if (selectionGate) {
    const supersededPlan = selectionGate.getPlan();
    const revalidatedPlan = selectionGate.revalidate();
    if (revalidatedPlan.outcome !== 'selected') {
      const error = new SelectionRevalidationError(revalidatedPlan, supersededPlan);
      emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
      return { kind: 'error', error, errorKind: 'policy' };
    }
  }

  // Backpressure: wait before proceeding if the strategy requires it
  if (backpressure) {
    const { delay: backpressureDelay } = backpressure.beforeStep();
    if (backpressureDelay > 0) {
      emitter?.dispatch(new BackpressureAppliedEvent(step, backpressureDelay));
      if (signal?.aborted) {
        return { kind: 'abort', reason: explicitAbortReason(signal) };
      }
      await new Promise<void>((resolve) => {
        const timer = deps.runtime.timers.setTimeout(resolve, backpressureDelay);
        if (signal) {
          const onAbort = () => {
            deps.runtime.timers.clearTimeout(timer);
            resolve();
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      if (signal?.aborted) {
        return { kind: 'abort', reason: explicitAbortReason(signal) };
      }
      emitter?.dispatch(new BackpressureReleasedEvent(step));
    }
  }

  const stepAbortController = new AbortController();
  const stepSignal = signal
    ? AbortSignal.any([signal, stepAbortController.signal])
    : stepAbortController.signal;

  const abortStep = stepAbortController.abort.bind(stepAbortController) as (
    reason?: string,
  ) => void;

  const elicit = deps.onElicitation
    ? createElicit(step, deps.onElicitation, conversation, stepSignal, deps.runtime, emitter)
    : undefined;

  // Context management: compact if over token threshold
  if (deps.contextManagement) {
    const contextManagement = deps.contextManagement;
    const tokensBefore = contextManagement.tokenEstimator
      ? contextManagement.tokenEstimator(conversation)
      : conversation.estimateTokens();

    // Emit budget warning when remaining tokens fall below warningThreshold
    const warningThreshold =
      contextManagement.warningThreshold ?? Math.floor(contextManagement.maxTokens * 0.2);
    const remaining = contextManagement.maxTokens - tokensBefore;
    if (remaining <= warningThreshold) {
      emitter?.dispatch(
        new ContextBudgetWarningEvent(step, tokensBefore, remaining, contextManagement.maxTokens),
      );
    }

    // Determine compaction threshold (new field or legacy maxTokens)
    const compactionThreshold =
      contextManagement.compactionThreshold ?? contextManagement.maxTokens;
    if (tokensBefore > compactionThreshold) {
      // Run beforeCompaction hook if registered
      let shouldCompact = true;
      if (hooks?.has('beforeCompaction')) {
        try {
          const hookResult = await hooks.run('beforeCompaction', {
            conversation,
            step,
            budget: {
              maxTokens: contextManagement.maxTokens,
              minimumResponseTokens: contextManagement.minimumResponseTokens ?? 1500,
              warningThreshold,
              compactionThreshold,
              used: tokensBefore,
              remaining,
              exceeds: true,
              warning: remaining <= warningThreshold,
              update() {},
              allocate() {
                return 0;
              },
              estimate(text: string) {
                return Math.ceil(text.length / 4);
              },
            },
          });
          if (hookResult === false) {
            shouldCompact = false;
          }
        } catch (error) {
          emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
          return { kind: 'error', error, errorKind: 'policy' };
        }
      }

      if (shouldCompact) {
        try {
          const messagesBefore = conversation.getMessages().length;
          await contextManagement.onCompact(conversation, {
            conversation,
            step,
            signal: stepSignal,
            abortStep,
            elicit,
          });
          const tokensAfter = contextManagement.tokenEstimator
            ? contextManagement.tokenEstimator(conversation)
            : conversation.estimateTokens();
          const messagesAfter = conversation.getMessages().length;
          emitter?.dispatch(new ContextCompactedEvent(step, tokensBefore, tokensAfter));

          // Run afterCompaction hook if registered
          if (hooks?.has('afterCompaction')) {
            try {
              await hooks.run('afterCompaction', {
                conversation,
                step,
                messagesRemoved: messagesBefore - messagesAfter,
                tokensFreed: tokensBefore - tokensAfter,
              });
            } catch (error) {
              emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
              return { kind: 'error', error, errorKind: 'policy' };
            }
          }
        } catch (error) {
          emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
          return { kind: 'error', error, errorKind: 'policy' };
        }
      }
    }
  }

  emitter?.dispatch(new StepStartedEvent(conversation, step));

  // Resolve per-step toolbox
  let stepToolbox: AnyToolbox = deps.toolbox;
  for (const hook of deps.selectToolsHooks) {
    stepToolbox = await hook({ conversation, step, signal: stepSignal, abortStep, elicit });
  }
  if (hooks?.has('selectTools')) {
    const selectContext = { conversation, step, signal: stepSignal, abortStep, elicit };
    const registryToolbox = await hooks.run('selectTools', selectContext);
    if (registryToolbox !== undefined) {
      stepToolbox = registryToolbox;
    }
  }
  deps.onStepToolbox?.(stepToolbox);

  // Resolve per-step tool choice: hook override → RunOptions default → undefined
  let stepToolChoice: ToolChoice | undefined = deps.defaultToolChoice;
  if (hooks?.has('selectToolChoice')) {
    const selectToolChoiceContext = { conversation, step, signal: stepSignal, abortStep, elicit };
    const hookResult = await hooks.run('selectToolChoice', selectToolChoiceContext);
    if (hookResult !== undefined) {
      stepToolChoice = hookResult;
    }
  }

  return {
    steeringDesiredState,
    stepAbortController,
    stepSignal,
    abortStep,
    elicit,
    stepToolbox,
    stepToolChoice,
  };
}
