/**
 * AB-99 — wires an `ActiveRun`'s curated event stream into the versioned
 * `RunFrame` sequence (AB-96), replicating `run-agent.mjs`'s NDJSON
 * `{ type: 'event', event }` / `{ type: 'result', result }` line protocol:
 * each frame this collects is one NDJSON line the runner would write to
 * stdout, using operative's own frame constructors — the same primitives
 * `bureau`'s (internal, unexported) `createRunFrameForwarder` is built on.
 *
 * This intentionally covers the subset `run-agent.mjs` actually emits
 * (session_start / tool_pre-equivalent / stop / error / result) rather than
 * bureau's full curated set (budget/context/elicitation notifications) —
 * the conformance target is the runner's wire protocol, not bureau's.
 */
import type {
  ActiveRun,
  BuildRunReportInput,
  CombinedOperativeEventMap,
  CombinedOperativeEventType,
  RunFrame,
  RunReport,
} from '@lostgradient/operative';
import {
  buildRunReport,
  createNotificationFrame,
  createRunFinishedFrame,
  createRunStartedFrame,
  createStepFrame,
  createToolPostFrame,
  createToolPreFrame,
  mapFinishReasonToStatus,
} from '@lostgradient/operative';

type BuildTribunalRunReportOptionalKeys =
  | 'costEstimate'
  | 'structuredOutput'
  | 'effectiveModel'
  | 'effectiveEffort';

/**
 * Thin wrapper over `buildRunReport` that omits its optional fields entirely
 * when undefined, rather than passing the key through explicitly —
 * `BuildRunReportInput`'s optional fields don't accept an explicit `undefined`
 * under this package's `exactOptionalPropertyTypes: true`, but callers here
 * routinely derive these from `RunResult`/`GenerateResponse.metadata` fields
 * that are themselves `T | undefined`.
 */
export function buildTribunalRunReport(
  input: Omit<BuildRunReportInput, BuildTribunalRunReportOptionalKeys> & {
    costEstimate?: BuildRunReportInput['costEstimate'] | undefined;
    structuredOutput?: unknown;
    effectiveModel?: string | undefined;
    effectiveEffort?: string | undefined;
  },
): RunReport {
  const { costEstimate, structuredOutput, effectiveModel, effectiveEffort, ...rest } = input;
  return buildRunReport({
    ...rest,
    ...(costEstimate !== undefined ? { costEstimate } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(effectiveModel !== undefined ? { effectiveModel } : {}),
    ...(effectiveEffort !== undefined ? { effectiveEffort } : {}),
  });
}

/** One NDJSON line — a JSON-serialized `RunFrame`. */
export type NdjsonLine = string;

export interface RunEnvelopeCapture {
  /** Every frame emitted, in order — the parsed form of the NDJSON stream. */
  frames: RunFrame[];
  /** The same frames, JSON-stringified — one NDJSON line per frame. */
  lines: NdjsonLine[];
  /** Detaches every listener this wiring registered. */
  dispose: () => void;
}

/**
 * Subscribes to `activeRun`'s curated tool/step events and appends one
 * `RunFrame` (and its NDJSON-serialized line) per event, mirroring
 * `run-agent.mjs`'s `emitEvent()` call sites: `session_start` -> `run-started`,
 * `tool_pre` -> `tool-pre`, a policy denial or settled call -> `tool-post`,
 * `stop`/`error` -> `notification`.
 */
export function captureRunEnvelope(runId: string, activeRun: ActiveRun): RunEnvelopeCapture {
  const frames: RunFrame[] = [];
  const lines: NdjsonLine[] = [];
  const disposers: Array<() => void> = [];
  let currentStep = 0;

  function emit(frame: RunFrame): void {
    frames.push(frame);
    lines.push(JSON.stringify(frame));
  }

  function on<K extends CombinedOperativeEventType>(
    type: K,
    listener: (event: CombinedOperativeEventMap[K]) => void,
  ): void {
    activeRun.addEventListener(type, listener);
    disposers.push(() => activeRun.removeEventListener(type, listener));
  }

  emit(createRunStartedFrame({ runId }));

  on('step.started', (event) => {
    currentStep = event.step;
    emit(createStepFrame({ runId, step: event.step, phase: 'started' }));
  });

  on('step.completed', (event) => {
    currentStep = event.step;
    emit(
      createStepFrame({
        runId,
        step: event.step,
        phase: 'completed',
        ...(event.usage ? { usage: event.usage } : {}),
      }),
    );
  });

  const deniedToolCallIds = new Set<string>();

  on('tool.started', (event) => {
    emit(
      createToolPreFrame({
        runId,
        step: event.step,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        params: event.params,
      }),
    );
  });

  on('tool.policy-denied', (event) => {
    deniedToolCallIds.add(event.toolCallId);
    emit(
      createToolPostFrame({
        runId,
        step: event.step,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: 'denied',
        error: event.reason,
      }),
    );
  });

  on('tool.settled', (event) => {
    if (deniedToolCallIds.delete(event.toolCallId)) return;
    emit(
      createToolPostFrame({
        runId,
        step: event.step,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: event.status,
        result: event.result,
        error: event.error,
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      }),
    );
  });

  on('budget.exceeded', (event) => {
    emit(
      createNotificationFrame({
        runId,
        step: currentStep,
        level: 'error',
        code: 'budget.exceeded',
        message: `Cost budget exceeded (${event.currentCost} of ${event.budget})`,
      }),
    );
  });

  return {
    frames,
    lines,
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

/**
 * Appends the terminal `run-finished` frame carrying the AB-96 `RunReport`
 * built via `buildRunReport` — the same helper the SIGTERM partial-report
 * path uses, just fed a terminal (not partial) input here.
 */
export function finishRunEnvelope(
  capture: RunEnvelopeCapture,
  runId: string,
  report: RunReport,
): void {
  const frame = createRunFinishedFrame({ runId, report });
  capture.frames.push(frame);
  capture.lines.push(JSON.stringify(frame));
}

export { buildRunReport, mapFinishReasonToStatus };
