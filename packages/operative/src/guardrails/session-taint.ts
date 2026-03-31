import type {
  InputDetector,
  OutputValidator,
  SessionTaintedEvent,
  SessionTaintOptions,
  SessionTaintTracker,
} from './types';

/**
 * Creates a session taint tracker that manages escalation state.
 *
 * When a high-confidence detection occurs (>= `taintThreshold`, default 0.9), the
 * caller marks the session as tainted. Once tainted, the tracker adds `escalatedDetectors`
 * and `escalatedValidators` to the active set, enabling stricter inspection for the
 * remainder of the session.
 *
 * Taint is sticky: once set, it cannot be unset. The `onTainted` callback fires only
 * on the first taint event.
 */
export function createSessionTaintTracker(options: SessionTaintOptions = {}): SessionTaintTracker {
  const { escalatedDetectors = [], escalatedValidators = [], onTainted } = options;

  let tainted = false;

  return {
    isTainted(): boolean {
      return tainted;
    },

    taint(event: SessionTaintedEvent): void {
      if (tainted) return;
      tainted = true;
      onTainted?.(event);
    },

    /** Returns escalated detectors when tainted, empty array otherwise. */
    getDetectors(): InputDetector[] {
      if (!tainted) return [];
      return [...escalatedDetectors];
    },

    /** Returns escalated validators when tainted, empty array otherwise. */
    getValidators(): OutputValidator[] {
      if (!tainted) return [];
      return [...escalatedValidators];
    },
  };
}
