import type { WorkflowLogRecord } from '@lostgradient/weft';

import { HumanWaitParkedEvent } from '../events';
import type { EventDispatcher } from '../run-step';

/**
 * The `ctx.log` message of the replay-aware park marker (COR-121). The workflow
 * emits it immediately before `ctx.waitForSignal`; weft suppresses `ctx.log`
 * whenever the current position is already cached, so it fires only for a wait
 * that is still pending. The engine's wrapper sink turns it into a
 * `HumanWaitParkedEvent` and never forwards it to the user `onLog` or console.
 */
export const HUMAN_WAIT_PARKED_LOG_MARKER = 'operative.durable.human-wait.parked';

function isDispatcher(value: unknown): value is EventDispatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { dispatch?: unknown }).dispatch === 'function'
  );
}

/**
 * Wrap the host `onLog`: marker records dispatch a `HumanWaitParkedEvent` onto
 * the run's emitter (carried by reference in the record's `emitter` attribute,
 * inline mode) and are withheld; every other record goes to `onLog`, or to
 * `console[level]` when none was given (weft's own default).
 */
export function createHumanWaitMarkerSink(
  onLog: ((record: WorkflowLogRecord) => void) | undefined,
): (record: WorkflowLogRecord) => void {
  return (record) => {
    if (record.message === HUMAN_WAIT_PARKED_LOG_MARKER) {
      const { runId, signalName, prompt, emitter } = record.attributes ?? {};
      if (
        typeof runId === 'string' &&
        typeof signalName === 'string' &&
        (prompt === undefined || typeof prompt === 'string') &&
        isDispatcher(emitter)
      ) {
        emitter.dispatch(new HumanWaitParkedEvent(signalName, runId, prompt));
      }
      return;
    }
    if (onLog) {
      onLog(record);
      return;
    }
    console[record.level](record);
  };
}
