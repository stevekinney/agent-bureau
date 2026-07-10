import type { TypedEventTarget } from 'lifecycle';
import {
  type ActiveRun,
  buildRunReport,
  type BuildRunReportInput,
  type CombinedOperativeEventMap,
  type CombinedOperativeEventType,
  createAssistantChunkFrame,
  createAssistantFinalFrame,
  createNotificationFrame,
  createStepFrame,
  createToolPostFrame,
  createToolPreFrame,
  mapFinishReasonToStatus,
  type NotificationLevel,
  type RunFrame,
  type RunReport,
  type StreamEventMap,
  type SummarizeOptions,
  type ToolFrameStatus,
} from 'operative';
import type { RunState } from 'operative/store';

import { serializeUnknownError } from './serialization';

/**
 * AB-96 — bureau-side wiring of operative's versioned run envelope
 * (`operative/run-envelope`). Extends `websocket-frames.ts`'s
 * `streamEventToFrame` concept with the fuller, documented lifecycle frame
 * set (run-started, step, assistant-chunk/final, tool-pre/post,
 * notification, run-finished), and builds the terminal `RunReport` for every
 * exit path — normal completion, error, abort, and abrupt process shutdown.
 */

export interface RunFrameForwarderOptions {
  /** Enhanced-streaming event target, when the runtime has streaming enabled. */
  streamEventTarget?: TypedEventTarget<StreamEventMap>;
  /** Redaction/truncation limits applied to tool-pre/tool-post summaries. */
  summarizeOptions?: SummarizeOptions;
  /** Injectable clock for deterministic frame timestamps in tests. */
  clock?: () => number;
}

/**
 * Wires an `ActiveRun` (and, when present, its enhanced-streaming event
 * target) into the versioned `RunFrame` stream. Returns a disposer that
 * removes every listener it registered — call it once the run settles (the
 * same pattern `disposeRegisteredStreamListeners` already uses for the
 * legacy WebSocket frame listeners).
 */
export function createRunFrameForwarder(
  runId: string,
  activeRun: ActiveRun,
  emit: (frame: RunFrame) => void,
  options: RunFrameForwarderOptions = {},
): () => void {
  const { streamEventTarget, summarizeOptions, clock } = options;
  const disposers: Array<() => void> = [];
  let currentStep = 0;

  function on<K extends CombinedOperativeEventType>(
    type: K,
    listener: (event: CombinedOperativeEventMap[K]) => void,
  ): void {
    activeRun.addEventListener(type, listener);
    disposers.push(() => activeRun.removeEventListener(type, listener));
  }

  on('step.started', (event) => {
    currentStep = event.step;
    emit(createStepFrame({ runId, step: event.step, phase: 'started' }, clock));
  });

  on('step.completed', (event) => {
    currentStep = event.step;
    emit(
      createStepFrame({ runId, step: event.step, phase: 'completed', usage: event.usage }, clock),
    );
    if (event.content) {
      emit(createAssistantFinalFrame({ runId, step: event.step, content: event.content }, clock));
    }
  });

  on('tool.started', (event) => {
    emit(
      createToolPreFrame(
        {
          runId,
          step: event.step,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          params: event.params,
          summarizeOptions,
        },
        clock,
      ),
    );
  });

  // A policy-denied tool call fires THREE armorer events in order —
  // 'policy-denied', 'execute-error', 'settled' (see `create-tool.ts`) — and
  // operative bubbles the first as `tool.policy-denied` and the last as
  // `tool.settled` (with `status: 'error'`, losing the denial-specific
  // reason). `deniedToolCallIds` lets the `tool.settled` handler recognize
  // "I already reported this one, with better information" and skip it,
  // rather than emitting two `tool-post` frames for the same call — the same
  // class of bug as `tool.error`/`tool.settled` below, just on the denial
  // path.
  const deniedToolCallIds = new Set<string>();

  on('tool.policy-denied', (event) => {
    deniedToolCallIds.add(event.toolCallId);
    emit(
      createToolPostFrame(
        {
          runId,
          step: event.step,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'denied' satisfies ToolFrameStatus,
          error: event.reason,
          summarizeOptions,
        },
        clock,
      ),
    );
  });

  on('tool.settled', (event) => {
    if (deniedToolCallIds.delete(event.toolCallId)) return;
    emit(
      createToolPostFrame(
        {
          runId,
          step: event.step,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: event.status,
          durationMs: event.durationMs,
          result: event.result,
          error: event.error,
          summarizeOptions,
        },
        clock,
      ),
    );
  });

  // `tool.error` is intentionally NOT wired here — `create-run.ts` always
  // fires `tool.settled` first (with `status: 'error'` and the same `error`
  // payload) and then ALSO fires `tool.error` for the same failed call.
  // Listening to both would emit two `tool-post` frames for one tool call;
  // `tool.settled`'s error branch already carries everything `tool.error`
  // does.

  on('budget.threshold', (event) => {
    emit(
      createNotificationFrame(
        {
          runId,
          step: currentStep,
          level: 'warning' satisfies NotificationLevel,
          code: 'budget.threshold',
          message: `Cost budget at ${Math.round(event.threshold * 100)}% (${event.currentCost} of ${event.budget})`,
        },
        clock,
      ),
    );
  });

  on('budget.exceeded', (event) => {
    emit(
      createNotificationFrame(
        {
          runId,
          step: currentStep,
          level: 'error' satisfies NotificationLevel,
          code: 'budget.exceeded',
          message: `Cost budget exceeded (${event.currentCost} of ${event.budget})`,
        },
        clock,
      ),
    );
  });

  on('context.budget-warning', (event) => {
    emit(
      createNotificationFrame(
        {
          runId,
          step: event.step,
          level: 'warning' satisfies NotificationLevel,
          code: 'context.budget-warning',
          message: `Context budget: ${event.remaining} of ${event.maxTokens} tokens remaining`,
        },
        clock,
      ),
    );
  });

  on('elicitation.requested', (event) => {
    emit(
      createNotificationFrame(
        {
          runId,
          step: event.step,
          level: 'info' satisfies NotificationLevel,
          code: 'elicitation.requested',
          message: event.message,
        },
        clock,
      ),
    );
  });

  // `workflow.version-mismatch` is intentionally NOT wired here — per its
  // doc comment in `events.ts`, it is dispatched via the plain
  // `CreateRunEngineOptions.onWorkflowVersionMismatch` callback (a recovered
  // run's per-run emitter doesn't exist yet when the check runs), never
  // through `activeRun`'s event stream. An embedder that wants it as a
  // notification wires that callback directly.

  if (streamEventTarget) {
    const listener = (event: StreamEventMap['stream:text-delta']) => {
      emit(
        createAssistantChunkFrame(
          {
            runId,
            step: currentStep,
            delta: event.detail.content,
            accumulated: event.detail.accumulated,
          },
          clock,
        ),
      );
    };
    streamEventTarget.addEventListener('stream:text-delta', listener);
    disposers.push(() => streamEventTarget.removeEventListener('stream:text-delta', listener));
  }

  return () => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  };
}

/** Extracts `effectiveModel`/`effectiveEffort` from the last step's `GenerateResponse.metadata`. */
function extractEffectiveModelAndEffort(steps: RunState['steps']): {
  effectiveModel?: string;
  effectiveEffort?: string;
} {
  const lastStep = steps[steps.length - 1];
  const metadata = lastStep?.metadata;
  return {
    effectiveModel:
      typeof metadata?.['effectiveModel'] === 'string' ? metadata['effectiveModel'] : undefined,
    effectiveEffort:
      typeof metadata?.['effectiveEffort'] === 'string' ? metadata['effectiveEffort'] : undefined,
  };
}

/**
 * Builds the terminal {@link RunReport} for a `run.completed` exit (covers
 * `stop-condition`, `maximum-steps`, `error`, `elicitation-denied`, and
 * `budget-exceeded` — every non-abort finish reason resolves through
 * `run.completed`, see `run-lifecycle.ts`'s `makeErrorResult`).
 */
export function buildTerminalReportFromCompletedEvent(
  runId: string,
  event: {
    finishReason: NonNullable<BuildRunReportInput['finishReason']>;
    usage: BuildRunReportInput['usage'];
    costEstimate?: BuildRunReportInput['costEstimate'];
    structuredOutput?: unknown;
    error?: unknown;
    steps: RunState['steps'];
    conversation: { current: BuildRunReportInput['transcript'] };
  },
): RunReport {
  const { effectiveModel, effectiveEffort } = extractEffectiveModelAndEffort(event.steps);
  return buildRunReport({
    runId,
    status: mapFinishReasonToStatus(event.finishReason),
    finishReason: event.finishReason,
    usage: event.usage,
    costEstimate: event.costEstimate,
    effectiveModel,
    effectiveEffort,
    structuredOutput: event.structuredOutput,
    error: event.error,
    transcript: event.conversation.current,
  });
}

/** Builds the terminal {@link RunReport} for a `run.aborted` exit. */
export function buildTerminalReportFromAbortedEvent(
  runId: string,
  event: {
    usage?: BuildRunReportInput['usage'];
    costEstimate?: BuildRunReportInput['costEstimate'];
    reason?: string;
    steps: RunState['steps'];
    conversation: { current: BuildRunReportInput['transcript'] };
  },
): RunReport {
  const { effectiveModel, effectiveEffort } = extractEffectiveModelAndEffort(event.steps);
  return buildRunReport({
    runId,
    status: 'aborted',
    finishReason: 'aborted',
    usage: event.usage ?? { prompt: 0, completion: 0, total: 0 },
    costEstimate: event.costEstimate,
    effectiveModel,
    effectiveEffort,
    error: event.reason,
    transcript: event.conversation.current,
  });
}

/**
 * Synchronously builds a **partial** {@link RunReport} from a live
 * {@link RunState} — the graceful-shutdown path (AB-96). `store.getRun(id)`
 * is a plain in-memory read (no I/O, no promise), so this is safe to call
 * from a `SIGTERM` handler or an `abort()` call site right before process
 * exit: the accumulated `usage` and the transcript through the last
 * checkpointed step (including any tool calls/results that step already
 * collected) both survive, even though the run never reached a terminal
 * lifecycle event.
 */
export function buildPartialRunReport(
  runId: string,
  runState: RunState,
  reason?: string,
): RunReport {
  const { effectiveModel, effectiveEffort } = extractEffectiveModelAndEffort(runState.steps);
  const lastStep = runState.steps[runState.steps.length - 1];
  return buildRunReport({
    runId,
    status: 'aborted',
    finishReason: 'aborted',
    usage: runState.usage,
    effectiveModel,
    effectiveEffort,
    error:
      reason ?? serializeUnknownError(runState.error ?? 'process shutdown before run completion'),
    transcript: lastStep?.conversation.current,
  });
}
