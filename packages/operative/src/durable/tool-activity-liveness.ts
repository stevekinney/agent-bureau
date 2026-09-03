import type { ActivityContext } from '@lostgradient/weft';

import { toolCallPolicy, WEFT_ACTIVITY_POLICY } from '../liveness/policies';
import type { LivenessClockSource, StallPolicy } from '../liveness/types';
import {
  createStallWatchdog,
  type StallWatchdog,
  type StallWatchdogClock,
} from '../liveness/watchdog';

/**
 * The tool-call activity-liveness composition point (AB-218/obs-05).
 *
 * `packages/operative/src/durable/create-run-engine.ts` documents today's
 * dispatch behavior in this repository: "Tool execution is NOT an
 * activity — it runs in-process inside `runStep`, the same code path the
 * in-memory loop uses." This module is the selector and forwarder a
 * tool-call dispatch site uses once a call DOES carry a Weft
 * `ActivityContext` (a durable dispatch that runs the tool's `execute` as an
 * activity, e.g. through `ctx.run`); it makes no assumption that every, or
 * any, tool call is activity-backed today, and both branches are exercised
 * and covered regardless.
 */

export interface ToolCallProgressUpdate {
  readonly percent?: number;
  readonly message?: string;
  readonly checkpoint?: unknown;
}

/**
 * AC1's once-per-invocation selection: `'wall-clock-owner'` iff the current
 * tool-call dispatch carries a Weft {@link ActivityContext} with a DEFINED
 * `activityAttemptToken`; `'monotonic-observer'` otherwise. The signature
 * accepts only the `ActivityContext` — there is no tool-name or
 * configuration parameter, so the selection cannot be guessed from either
 * (AB-218's own no-guessing rule).
 */
export function selectToolCallClockSource(
  activityContext: ActivityContext | undefined,
): LivenessClockSource {
  return activityContext?.activityAttemptToken !== undefined
    ? 'wall-clock-owner'
    : 'monotonic-observer';
}

/**
 * The `StallPolicy` a tool call's liveness is classified against, chosen
 * once per invocation via {@link selectToolCallClockSource}.
 *
 * The activity branch reuses `WEFT_ACTIVITY_POLICY` verbatim — it already
 * carries the exact `clockSource: 'wall-clock-owner'` /
 * `recovery: 'requires-explicit-recovered-transition'` /
 * `suspensionBehavior: 'not-applicable'` values AB-218's acceptance criteria
 * name for an activity-backed tool call, and it has no `cadenceMs` (Weft
 * owns cadence for a `wall-clock-owner` row; a caller-supplied cadence
 * override is ignored in this branch for the same reason). Reusing this row
 * verbatim, rather than adding a distinct named row to `policies.ts`, keeps
 * this issue inside AB-214's coordinator ruling (2026-09-02): "This issue
 * authors every `StallPolicy` row AB-88 names ... obs-05, obs-06, and obs-07
 * consume those rows and add none."
 *
 * The non-activity branch is `toolCallPolicy`, exactly as today
 * (`packages/operative/src/liveness/active-run-liveness.ts`'s own tool
 * watchdog), optionally overridden by a tool's declared cadence.
 */
export function selectToolCallStallPolicy(
  activityContext: ActivityContext | undefined,
  cadenceMs?: number,
): StallPolicy {
  return selectToolCallClockSource(activityContext) === 'wall-clock-owner'
    ? WEFT_ACTIVITY_POLICY
    : toolCallPolicy(cadenceMs);
}

export interface ToolCallLivenessWatchdog {
  readonly watchdog: StallWatchdog;
  readonly clockSource: LivenessClockSource;
  readonly policy: StallPolicy;
}

/**
 * Builds the tool-call watchdog for one dispatch, selecting the policy once
 * from the actual `ActivityContext` presence (AC1).
 *
 * `WEFT_ACTIVITY_POLICY` has no `cadenceMs` and a `missedPulseThreshold` of
 * `0`, so `createStallWatchdog` never treats it as cadence-gated — its
 * `!cadenceGated` branch never schedules a local timer and reports
 * `reachable`/`progressing` purely from the presence of a real pulse. This
 * is the concrete mechanism behind AB-88's AC12/wall-clock-owner rule that
 * "wall-clock-owner rows never run a competing local timer": reusing
 * `createStallWatchdog` here (rather than a second, bespoke evidence
 * tracker) makes that guarantee structural, not a second implementation to
 * keep in sync (this repository's No Duplicated Code rule).
 */
export function createToolCallLivenessWatchdog(
  activityContext: ActivityContext | undefined,
  clock: StallWatchdogClock,
  options?: { cadenceMs?: number; onAssessmentChange?: () => void },
): ToolCallLivenessWatchdog {
  const policy = selectToolCallStallPolicy(activityContext, options?.cadenceMs);
  const watchdog = createStallWatchdog(policy, clock, {
    onAssessmentChange: options?.onAssessmentChange,
  });
  return { watchdog, clockSource: policy.clockSource, policy };
}

/**
 * Forwards a tool's `progress({ checkpoint })` call to the activity's own
 * heartbeat when this tool call executes as a Weft activity (AC2 — the
 * concrete "map it to a durable Weft activity only when the tool actually
 * executes as an activity" mapping), and records the SAME forwarded value
 * into the local watchdog as `'task-attempt-heartbeat'` evidence — never a
 * second, independently-timed pulse — so the tool call's derived
 * reachability/progress reflect exactly the heartbeat Weft recorded, never
 * a value Bureau/operative re-infers on its own (AB-88's AC12 discipline).
 *
 * `details` is the reported `checkpoint` when present, or the whole
 * `{ percent, message, checkpoint }` update when `checkpoint` is absent, per
 * AC2. A non-activity tool call's `progress()` calls are never forwarded to
 * Weft — they are recorded as `'tool-progress'` evidence, matching today's
 * behavior (`active-run-liveness.ts`'s `recordToolProgressPulse`).
 */
export function recordToolCallProgress(
  activityContext: ActivityContext | undefined,
  watchdog: StallWatchdog,
  attempt: number,
  update: ToolCallProgressUpdate,
): void {
  if (activityContext?.activityAttemptToken !== undefined) {
    const details: unknown = update.checkpoint !== undefined ? update.checkpoint : update;
    activityContext.heartbeat(details);
    watchdog.recordPulse('task-attempt-heartbeat', attempt, details);
    return;
  }
  watchdog.recordPulse('tool-progress', attempt, update);
}
