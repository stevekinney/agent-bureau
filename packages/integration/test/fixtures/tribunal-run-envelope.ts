/**
 * AB-99 — wires an `AgentRun`'s curated event stream into the versioned
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
  AgentRun,
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
  RUN_ENVELOPE_SCHEMA_VERSION,
  runFrameSchema,
} from '@lostgradient/operative';

type BuildTribunalRunReportOptionalKeys =
  'costEstimate' | 'output' | 'effectiveModel' | 'effectiveEffort';

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
    output?: unknown;
    effectiveModel?: string | undefined;
    effectiveEffort?: string | undefined;
  },
): RunReport {
  const { costEstimate, output, effectiveModel, effectiveEffort, ...rest } = input;
  return buildRunReport({
    ...rest,
    ...(costEstimate !== undefined ? { costEstimate } : {}),
    ...(output !== undefined ? { output } : {}),
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
  /**
   * Resolves once the run's event stream has been fully pumped. `AgentRun`
   * delivers events through one single-consumer `AsyncIterable` rather than
   * push-based listeners, so — unlike the old `ActiveRun`-based wiring —
   * delivery is asynchronous relative to `result()`: `result()` can settle
   * before the final `step.completed` event has been pumped into a frame.
   * Callers MUST `await` this after `await run.result()` before asserting
   * on `frames`/`lines`.
   */
  drained: Promise<void>;
}

/**
 * Subscribes to `agentRun`'s curated tool/step events (via its single
 * `AsyncIterable<RunEvent>` stream — the public `AgentRun` handle, AB-15)
 * and appends one `RunFrame` (and its NDJSON-serialized line) per event,
 * mirroring `run-agent.mjs`'s `emitEvent()` call sites: `session_start` ->
 * `run-started`, `tool_pre` -> `tool-pre`, a policy denial or settled call
 * -> `tool-post`, `stop`/`error` -> `notification`. Every frame is validated
 * against `runFrameSchema` and asserted to carry the current
 * `RUN_ENVELOPE_SCHEMA_VERSION` as it's emitted.
 */
export function captureRunEnvelope<O, H extends boolean>(
  runId: string,
  agentRun: AgentRun<O, H>,
): RunEnvelopeCapture {
  const frames: RunFrame[] = [];
  const lines: NdjsonLine[] = [];
  let currentStep = 0;

  function emit(frame: RunFrame): void {
    const parsed = runFrameSchema.parse(frame);
    if (parsed.schemaVersion !== RUN_ENVELOPE_SCHEMA_VERSION) {
      throw new Error(
        `Frame schemaVersion ${parsed.schemaVersion} does not match RUN_ENVELOPE_SCHEMA_VERSION ${RUN_ENVELOPE_SCHEMA_VERSION}`,
      );
    }
    frames.push(parsed);
    lines.push(JSON.stringify(parsed));
  }

  const listeners = new Map<
    CombinedOperativeEventType,
    (event: CombinedOperativeEventMap[CombinedOperativeEventType]) => void
  >();

  function on<K extends CombinedOperativeEventType>(
    type: K,
    listener: (event: CombinedOperativeEventMap[K]) => void,
  ): void {
    listeners.set(
      type,
      listener as (event: CombinedOperativeEventMap[CombinedOperativeEventType]) => void,
    );
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

  const drained = (async () => {
    try {
      for await (const event of agentRun) {
        const listener = listeners.get(event.type);
        listener?.(event);
      }
    } catch {
      // The iterator throws on an aborted/errored run — the run's own
      // `result()` promise (awaited by the caller) is the source of truth
      // for that outcome. `drained` only guarantees "no more frames will
      // arrive," so it always settles rather than rejecting.
    }
  })();

  return { frames, lines, drained };
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
  const frame = runFrameSchema.parse(createRunFinishedFrame({ runId, report }));
  if (frame.schemaVersion !== RUN_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(
      `Frame schemaVersion ${frame.schemaVersion} does not match RUN_ENVELOPE_SCHEMA_VERSION ${RUN_ENVELOPE_SCHEMA_VERSION}`,
    );
  }
  capture.frames.push(frame);
  capture.lines.push(JSON.stringify(frame));
}

export { buildRunReport, mapFinishReasonToStatus };
