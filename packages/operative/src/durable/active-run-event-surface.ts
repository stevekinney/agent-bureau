import type { AnyToolbox, ToolboxEventMap } from 'armorer';
import { CompletableEventTarget, createDefaultRuntimeServices } from 'lifecycle';

import type { CombinedOperativeEventMap, OperativeEventEmitter } from '../events';
import {
  HumanWaitParkedEvent,
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from '../events';
import type { ActiveRunLiveness } from '../liveness';
import { createToolboxEventForwarder } from '../toolbox-event-forwarding';
import type { DurableRunDeps } from './types';

export function wireHumanWaitLiveness(
  emitter: OperativeEventEmitter,
  liveness: ActiveRunLiveness,
): () => void {
  const onHumanWaitParked = (event: HumanWaitParkedEvent) => {
    // AB-88: 'review' and 'signal' are distinct DeclaredWaitReasons even
    // though both surface through `human-wait.parked` today — a supplied
    // `prompt` (requestHumanInput's reviewer-facing text) distinguishes a
    // human review from a bare external signal. Matches
    // `session-handle.ts`'s identical derivation for `SessionHandle`'s own
    // liveness (`documentation/operative-type-safe-api.md`'s "Session
    // liveness" section) — the same event, the same rule, at a different
    // observation layer.
    liveness.beginWait({
      reason: event.prompt !== undefined ? 'review' : 'signal',
      dependency: event.signalName,
      wakeCondition: `signal:${event.signalName}`,
    });
  };
  const onStepStartedEndWait = () => liveness.endWait();
  emitter.addEventListener(HumanWaitParkedEvent.type, onHumanWaitParked);
  emitter.addEventListener(StepStartedEvent.type, onStepStartedEndWait);
  return () => {
    emitter.removeEventListener(HumanWaitParkedEvent.type, onHumanWaitParked);
    emitter.removeEventListener(StepStartedEvent.type, onStepStartedEndWait);
  };
}
/**
 * The minimal recovered-handle surface {@link reattachDurableActiveRun} needs: a
 * pinned id (== runId) and the settling `result()`. `engine.recoverAll()` returns
 * full `WorkflowHandle`s; this narrow shape avoids depending on Weft's invariant
 * `WorkflowHandle` generics (matching the `RegistryAgnosticEngine` widening convention).
 */
export interface RecoveredRunHandle {
  readonly id: string;
  result(): Promise<unknown>;
}

export interface RecoveredRunEventSurface {
  emitter: OperativeEventEmitter;
  abort: (reason?: string) => void;
  stopToolboxForward: () => void;
}

/**
 * Build the live event surface for a recovered run during Weft's
 * `onRecoveredWorkflow` hook, before the recovered generator advances.
 */
export function createRecoveredRunEventSurface(
  services: DurableRunDeps,
  runId: string,
  agentName: string,
): RecoveredRunEventSurface {
  // AB-92/AB-252/AB-253: resolved exactly once, here — omitted, falls back
  // to the real globals, matching `createDurableActiveRun`'s own default.
  const runtime = services.options.runtime ?? createDefaultRuntimeServices();
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const abortController = new AbortController();
  services.options = {
    ...services.options,
    signal: services.options.signal
      ? AbortSignal.any([services.options.signal, abortController.signal])
      : abortController.signal,
  };
  services.emitter = emitter;
  const cleanups: Array<(() => void) | undefined> = [];

  let currentStep = 0;
  const stepListener = (event: StepStartedEvent) => {
    currentStep = event.step;
  };
  emitter.addEventListener(StepStartedEvent.type, stepListener);
  cleanups.push(() => emitter.removeEventListener(StepStartedEvent.type, stepListener));

  // AB-294: the curated tool.* bubble listeners move onto the same per-step
  // subscription `toolboxForwarder` uses for the low-level `toolbox.*`
  // forward (AB-239) — `attachToolboxCuratedListeners` below is passed to
  // `createToolboxEventForwarder` as its `attachCurated` argument.
  //
  // AB-290: mirrors `createDurableActiveRun`'s identically-named helper —
  // see its comment.
  const isOwnEvent = (event: { ownerId?: string }): boolean => event.ownerId === runId;
  const attachToolboxCuratedListeners = (toolboxInstance: AnyToolbox): (() => void) => {
    const toolboxWithListener = toolboxInstance as unknown as {
      addEventListener?: <K extends keyof ToolboxEventMap>(
        type: K,
        listener: (event: ToolboxEventMap[K]) => void,
        options?: AddEventListenerOptions,
      ) => () => void;
    };
    if (!toolboxWithListener.addEventListener) return () => {};
    const addListener = toolboxWithListener.addEventListener.bind(toolboxWithListener);
    const toolboxCleanups = [
      addListener('execute-start', (event) => {
        if (!isOwnEvent(event)) return;
        emitter.dispatchEvent(
          new ToolStartedBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              params: event.params,
              startedAt: runtime.clock.now(),
            },
          ),
        );
      }),
      addListener('settled', (event) => {
        if (!isOwnEvent(event)) return;
        const hasError = event.error !== undefined;
        emitter.dispatchEvent(
          new ToolSettledBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              status: event.status,
              result: event.result,
              error: event.error,
            },
          ),
        );
        if (hasError) {
          emitter.dispatchEvent(
            new ToolErrorBubbleEvent(
              { agentName, runId, step: currentStep },
              {
                toolName: event.call.name,
                toolCallId: event.call.id,
                error: event.error,
              },
            ),
          );
        }
      }),
      addListener('progress', (event) => {
        if (!isOwnEvent(event)) return;
        emitter.dispatchEvent(
          new ToolProgressBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              percent: event.percent,
              message: event.message,
            },
          ),
        );
      }),
      addListener('policy-denied', (event) => {
        emitter.dispatchEvent(
          new ToolPolicyDeniedBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              reason: event.reason,
            },
          ),
        );
      }),
    ];
    return () => {
      for (const cleanup of toolboxCleanups) cleanup?.();
    };
  };

  // AB-239: same base-plus-per-step forwarding as the fresh-start path
  // (`createDurableActiveRun` → `driveDurableRun`), wired directly onto the
  // recovered `services` object rather than threaded through a `drive()` call —
  // the recovered generator reads `services.onStepToolbox` via `ctx.services`
  // on its very next step. Chains any `onStepToolbox` the resolver already
  // installed on `services` rather than clobbering it, so this forwarder can
  // never silently drop another caller's per-step toolbox instrumentation.
  // Since AB-294, `attachToolboxCuratedListeners` above rides the same
  // base-plus-swap bracket as the low-level `toolbox.*` forward.
  const priorOnStepToolbox = services.onStepToolbox;
  const toolboxForwarder = createToolboxEventForwarder(
    services.toolbox,
    emitter,
    attachToolboxCuratedListeners,
  );
  services.onStepToolbox = (toolbox) => {
    priorOnStepToolbox?.(toolbox);
    toolboxForwarder.onStepToolbox(toolbox);
  };
  cleanups.push(() => toolboxForwarder.stop());

  return {
    emitter,
    stopToolboxForward: () => {
      for (const cleanup of cleanups) cleanup?.();
    },
    abort: (reason?: string) => abortController.abort(reason),
  };
}
