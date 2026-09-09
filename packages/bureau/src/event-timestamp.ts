/**
 * AB-388 (Codex review, PR #597, "Reuse event timestamps for dedicated
 * lifecycle listeners"): `audit-trail.ts` and `durable-event-history.ts`
 * each register their OWN listener for `schedule.created`/`paused`/
 * `resumed`/`cancelled` and `session.deleted` — these events never
 * traverse the `'action'` stream (the one place a shared `Action.timestamp`
 * already exists), so absent this module each listener independently
 * called `runtime.clock.now()`. Two back-to-back reads of a real wall
 * clock can straddle a millisecond boundary, and the durable-event
 * listener's reading could then land AFTER the audit listener's — the
 * fleet feed's retention floor (derived from durable-event timestamps)
 * could then exceed the corresponding audit record's own `timestampMs`,
 * letting a prune pass delete audit evidence for a durable event that is
 * still retained.
 *
 * A single resolver instance, shared by both subsystems via `create-bureau.ts`,
 * closes this regardless of which of the two listeners for a given event
 * happens to run first: the first caller to resolve a given event instance
 * stamps it with one clock reading; every subsequent caller for that SAME
 * event instance reuses it. Keyed on the event object itself (a `WeakMap`,
 * so no explicit cleanup is needed) rather than on any field of the event —
 * this works uniformly for every dispatch site (`create-bureau.ts`'s own
 * `pauseSchedule`/`resumeSchedule`/`cancelSchedule`/`deleteSession`, and
 * operative's own `AgentScheduleHandle`/`DurableHeartbeat` pause/resume/
 * cancel paths), none of which need to change to benefit.
 */
import type { RuntimeServices } from 'lifecycle';

/** Resolves one shared `emittedAtMs` reading per event instance. */
export type EventTimestampResolver = (event: object) => number;

/**
 * Create a resolver backed by `runtime.clock`. Call it once per bureau and
 * share the single instance between `createAuditTrail` and
 * `createDurableEventProducer` (both accept it as an options field).
 */
export function createEventTimestampResolver(runtime: RuntimeServices): EventTimestampResolver {
  const stamped = new WeakMap<object, number>();
  return (event: object): number => {
    const existing = stamped.get(event);
    if (existing !== undefined) return existing;
    const now = runtime.clock.now();
    stamped.set(event, now);
    return now;
  };
}
