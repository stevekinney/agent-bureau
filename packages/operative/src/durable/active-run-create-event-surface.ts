import type { AnyToolbox, ToolboxEventMap } from 'armorer';
import type { RuntimeServices } from 'lifecycle';

import type { OperativeEventEmitter } from '../events';
import {
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from '../events';
import type { ActiveRunLiveness } from '../liveness';
import { createToolboxEventForwarder } from '../toolbox-event-forwarding';

export function createDurableToolboxForwarder(args: {
  toolbox: AnyToolbox;
  emitter: OperativeEventEmitter;
  cleanups: Array<() => void>;
  runId: string;
  agentName: string;
  runtime: RuntimeServices;
  liveness: ActiveRunLiveness;
  isOwnEvent: (event: { ownerId?: string }) => boolean;
  onToolStarted: () => void;
  onToolSettled: () => void;
}) {
  const {
    toolbox,
    emitter,
    cleanups,
    runId,
    agentName,
    runtime,
    liveness,
    isOwnEvent,
    onToolStarted,
    onToolSettled,
  } = args;

  let currentStep = 0;

  const stepListener = (e: StepStartedEvent) => {
    currentStep = e.step;
  };
  emitter.addEventListener(StepStartedEvent.type, stepListener);
  cleanups.push(() => emitter.removeEventListener(StepStartedEvent.type, stepListener));

  const onExecuteStart = (e: ToolboxEventMap['execute-start']) => {
    // AB-290: only this run's own events — see `isOwnEvent` above and
    // the identical guard in `create-run.ts`'s `onExecuteStart`.
    if (!isOwnEvent(e)) return;
    onToolStarted();
    // AB-214 review (PRRT_kwDORvupsc6esZRy): the tool-call watchdog exists
    // only while a tool call is actually in flight — see the identical
    // reasoning in `create-run.ts`.
    liveness.beginToolCall();
    emitter.dispatchEvent(
      new ToolStartedBubbleEvent(
        { agentName, runId, step: currentStep },
        {
          toolName: e.call.name,
          toolCallId: e.call.id,
          params: e.params,
          startedAt: runtime.clock.now(),
        },
      ),
    );
  };

  const onSettled = (e: ToolboxEventMap['settled']) => {
    // AB-290: mirrors the `onExecuteStart` guard above.
    if (!isOwnEvent(e)) return;
    // Same reasoning as the identical call in create-run.ts's `onSettled`:
    // the tool-call watchdog tracks whether the run is still waiting on
    // this call, not whether the callback has physically returned, so
    // ending it here (when the cancellation race settles) rather than
    // waiting on a possibly-never-resolving abort-ignoring callback is
    // correct.
    liveness.endToolCall();
    // AB-289: armorer's `settled` event fires as soon as the
    // cancellation race against the execution signal settles, not once
    // the tool callback's own returned promise has genuinely settled —
    // see the identical deferral and reasoning in `create-run.ts`'s
    // `onSettled`. Deferring this decrement matters here for
    // `hasInFlightWork()`'s `not-required` fast-path gate below: without
    // it, that gate could read zero in-flight work while a local
    // abort-ignoring callback is still actually running, even though the
    // durable cancellation record this run's own `completed`
    // classification depends on (`resolveDurableOutcome`) is unaffected
    // by local tool tracking. A `settled` event with no
    // `callbackCompletion` (e.g. a hand-constructed test event) drains
    // synchronously, right here, matching the pre-AB-289 behavior exactly
    // rather than deferring by a spurious microtask.
    const release = () => {
      // Clamped: same reasoning as the identical counter in
      // create-run.ts — armorer can emit 'settled' with no preceding
      // 'execute-start' for a tool call cancelled before execution
      // begins.
      onToolSettled();
    };
    if (e.callbackCompletion) {
      void e.callbackCompletion.then(release, release);
    } else {
      release();
    }
    const hasError = e.error !== undefined;
    const status = e.status;
    emitter.dispatchEvent(
      new ToolSettledBubbleEvent(
        { agentName, runId, step: currentStep },
        {
          toolName: e.call.name,
          toolCallId: e.call.id,
          status,
          result: e.result,
          error: e.error,
        },
      ),
    );
    if (hasError) {
      emitter.dispatchEvent(
        new ToolErrorBubbleEvent(
          { agentName, runId, step: currentStep },
          {
            toolName: e.call.name,
            toolCallId: e.call.id,
            error: e.error,
          },
        ),
      );
    }
  };

  const onToolProgress = (e: ToolboxEventMap['progress']) => {
    // AB-290: mirrors the `onExecuteStart` guard above.
    if (!isOwnEvent(e)) return;
    emitter.dispatchEvent(
      new ToolProgressBubbleEvent(
        { agentName, runId, step: currentStep },
        {
          toolName: e.call.name,
          toolCallId: e.call.id,
          percent: e.percent,
          message: e.message,
        },
      ),
    );
    liveness.recordToolProgressPulse({
      toolCallId: e.call.id,
      toolName: e.call.name,
      percent: e.percent,
      message: e.message,
    });
  };

  const onPolicyDenied = (e: ToolboxEventMap['policy-denied']) => {
    emitter.dispatchEvent(
      new ToolPolicyDeniedBubbleEvent(
        { agentName, runId, step: currentStep },
        {
          toolName: e.call.name,
          toolCallId: e.call.id,
          reason: e.reason,
        },
      ),
    );
  };

  // Attach the curated listeners onto one toolbox instance (the base
  // toolbox, or a `selectTools`-swapped step toolbox — AB-294) and return a
  // function that detaches them again. Guards against mock/custom toolboxes
  // that omit `addEventListener`. Not bound to `abortController.signal` —
  // `toolboxForwarder.stop()` (via the `cleanups` entry below, which runs
  // on every termination path once `result` settles via `.finally(complete)`)
  // is the single removal path, so the same subscription lifecycle applies
  // whether the toolbox is the base instance or a swapped step toolbox.
  const attachToolboxCuratedListeners = (toolboxInstance: AnyToolbox): (() => void) => {
    const toolboxWithListener = toolboxInstance as unknown as {
      addEventListener?: <K extends keyof ToolboxEventMap>(
        type: K,
        listener: (e: ToolboxEventMap[K]) => void,
        options?: AddEventListenerOptions,
      ) => () => void;
    };
    if (!toolboxWithListener.addEventListener) return () => {};
    const addListener = toolboxWithListener.addEventListener.bind(toolboxWithListener);
    const toolboxCleanups = [
      addListener('execute-start', onExecuteStart),
      addListener('settled', onSettled),
      addListener('progress', onToolProgress),
      addListener('policy-denied', onPolicyDenied),
    ];
    return () => {
      for (const cleanup of toolboxCleanups) cleanup?.();
    };
  };

  // AB-239: the base subscription covers the whole run; `toolboxForwarder.onStepToolbox`
  // (threaded through `driveDurableRun` into `services.onStepToolbox`, then into
  // per-step `StepDeps` by `run-workflow.ts`) additionally covers any step whose
  // `selectTools` hook swaps in a different toolbox for that step — including,
  // since AB-294, the curated listeners defined above.
  const toolboxForwarder = createToolboxEventForwarder(
    toolbox,
    emitter,
    attachToolboxCuratedListeners,
  );
  return toolboxForwarder;
}
