import type { StallPolicy } from './types';

/**
 * Liveness policy schema version, copied verbatim onto every
 * `LivenessSnapshot.policyVersion` this package produces. Fixed by AB-214's
 * coordinator rulings (2026-09-02) — not AB-88's own placeholder text, which
 * left `policyVersion` unassigned.
 */
export const LIVENESS_POLICY_VERSION = 'ab-88/2026-09-01';

/**
 * 10 percent of `cadenceMs`, floored at 50ms, per AB-214's coordinator
 * ruling (2026-09-02). A row with no `cadenceMs` gets `jitterMs: 0` — there
 * is no cadence for jitter to buffer.
 */
function jitterFor(cadenceMs: number | undefined): number {
  if (cadenceMs === undefined) return 0;
  return Math.max(50, Math.round(cadenceMs * 0.1));
}

const TOOL_CALL_DEFAULT_CADENCE_MS = 30_000;

/**
 * `agent-run.provider-turn` — pulses on observed provider I/O only; no
 * cadence, so the caller's own per-request timeout is the only deadline.
 */
export const AGENT_RUN_PROVIDER_TURN_POLICY: StallPolicy = {
  operation: 'agent-run.provider-turn',
  graceMs: 0,
  jitterMs: 0,
  missedPulseThreshold: 0,
  clockSource: 'monotonic-observer',
  suspensionBehavior: 'pause-on-suspected-suspension',
  recovery: 'resume-on-next-pulse',
};

/**
 * `tool-call` (non-activity) — tool-declared cadence, defaulting to 30s.
 * Use {@link toolCallPolicy} to override the cadence for a tool that
 * declares its own.
 */
export const TOOL_CALL_POLICY: StallPolicy = {
  operation: 'tool-call',
  cadenceMs: TOOL_CALL_DEFAULT_CADENCE_MS,
  graceMs: 5000,
  jitterMs: jitterFor(TOOL_CALL_DEFAULT_CADENCE_MS),
  missedPulseThreshold: 3,
  clockSource: 'monotonic-observer',
  suspensionBehavior: 'pause-on-suspected-suspension',
  recovery: 'resume-on-next-pulse',
};

/**
 * Builds a `tool-call` `StallPolicy` row for a tool that declares its own
 * cadence (its `timeout` field), instead of the 30s default.
 */
export function toolCallPolicy(cadenceMs: number = TOOL_CALL_DEFAULT_CADENCE_MS): StallPolicy {
  return {
    ...TOOL_CALL_POLICY,
    cadenceMs,
    jitterMs: jitterFor(cadenceMs),
  };
}

/**
 * `session.monitor` — a monitor tick is either on time or the caller
 * stopped polling; no tolerance band. Cadence is caller-configured at
 * construction, so use {@link sessionMonitorPolicy} to build the row.
 */
export function sessionMonitorPolicy(cadenceMs: number): StallPolicy {
  return {
    operation: 'session.monitor',
    cadenceMs,
    graceMs: 0,
    jitterMs: 0,
    missedPulseThreshold: 1,
    clockSource: 'monotonic-observer',
    suspensionBehavior: 'pause-on-suspected-suspension',
    recovery: 'resume-on-next-pulse',
  };
}

/** `scheduler-task` — no per-task pulse exists today (AB-88, AB-92's testability matrix). */
export const SCHEDULER_TASK_POLICY: StallPolicy = {
  operation: 'scheduler-task',
  graceMs: 0,
  jitterMs: 0,
  missedPulseThreshold: 0,
  clockSource: 'monotonic-observer',
  suspensionBehavior: 'pause-on-suspected-suspension',
  recovery: 'requires-explicit-recovered-transition',
};

/** `gateway-connection` — the existing 8s SSE keepalive. */
export const GATEWAY_CONNECTION_POLICY: StallPolicy = {
  operation: 'gateway-connection',
  cadenceMs: 8000,
  graceMs: 4000,
  jitterMs: jitterFor(8000),
  missedPulseThreshold: 2,
  clockSource: 'monotonic-observer',
  suspensionBehavior: 'pause-on-suspected-suspension',
  recovery: 'resume-on-next-pulse',
};

/** `background-evaluation` — no per-item pulse exists today (AB-88). */
export const BACKGROUND_EVALUATION_POLICY: StallPolicy = {
  operation: 'background-evaluation',
  graceMs: 0,
  jitterMs: 0,
  missedPulseThreshold: 0,
  clockSource: 'monotonic-observer',
  suspensionBehavior: 'pause-on-suspected-suspension',
  recovery: 'requires-explicit-recovered-transition',
};

/** `webhook-delivery` — no per-item pulse exists today (AB-88). */
export const WEBHOOK_DELIVERY_POLICY: StallPolicy = {
  operation: 'webhook-delivery',
  graceMs: 0,
  jitterMs: 0,
  missedPulseThreshold: 0,
  clockSource: 'monotonic-observer',
  suspensionBehavior: 'pause-on-suspected-suspension',
  recovery: 'requires-explicit-recovered-transition',
};

/**
 * `weft-activity` — Weft owns cadence, grace, and retry policy; Bureau
 * never runs a competing local timer against a `wall-clock-owner` row
 * (AC12). Cadence and grace are left `undefined`/`0` here — the real values
 * live in Weft's own heartbeat interval and visibility grace, which obs-05
 * projects rather than duplicating.
 */
export const WEFT_ACTIVITY_POLICY: StallPolicy = {
  operation: 'weft-activity',
  graceMs: 0,
  jitterMs: 0,
  missedPulseThreshold: 0,
  clockSource: 'wall-clock-owner',
  suspensionBehavior: 'not-applicable',
  recovery: 'requires-explicit-recovered-transition',
};

/** `weft-worker` — Weft's `HeartbeatManager` interval; see {@link WEFT_ACTIVITY_POLICY}. */
export const WEFT_WORKER_POLICY: StallPolicy = {
  operation: 'weft-worker',
  graceMs: 0,
  jitterMs: 0,
  missedPulseThreshold: 0,
  clockSource: 'wall-clock-owner',
  suspensionBehavior: 'not-applicable',
  recovery: 'requires-explicit-recovered-transition',
};

/** `weft-task` — Weft-owned; see {@link WEFT_ACTIVITY_POLICY}. */
export const WEFT_TASK_POLICY: StallPolicy = {
  operation: 'weft-task',
  graceMs: 0,
  jitterMs: 0,
  missedPulseThreshold: 0,
  clockSource: 'wall-clock-owner',
  suspensionBehavior: 'not-applicable',
  recovery: 'requires-explicit-recovered-transition',
};

/** `weft-stream` — Weft-owned; see {@link WEFT_ACTIVITY_POLICY}. */
export const WEFT_STREAM_POLICY: StallPolicy = {
  operation: 'weft-stream',
  graceMs: 0,
  jitterMs: 0,
  missedPulseThreshold: 0,
  clockSource: 'wall-clock-owner',
  suspensionBehavior: 'not-applicable',
  recovery: 'requires-explicit-recovered-transition',
};
