/**
 * The `FaultPlan` type vocabulary AB-92's Decision (2026-09-01) fixes (AC8),
 * ratified verbatim here per AB-257's acceptance criteria and ABP-18's q2
 * ruling: AB-93/this slice owns the vocabulary and the scripted doubles,
 * AB-95 owns the engine that applies a `FaultPlan` at a boundary. Nothing in
 * this file executes a plan — it only names the shape a future engine and a
 * present-day test author both compile against.
 */

/**
 * Where in a lifecycle boundary a fault fires, relative to the boundary's
 * own work and its commit. See AB-92 AC8.
 */
export type FaultBoundary =
  | 'before-work'
  | 'after-effect'
  | 'before-commit'
  | 'after-commit'
  | 'lost-acknowledgement'
  | 'stale-read'
  | 'duplicate-delivery'
  | 'corrupt-payload'
  | 'ignored-abort'
  | 'process-death';

/**
 * What kind of operation a fault targets. `tool:${string}` and
 * `hook:${phase}` are open and closed template literals respectively —
 * every tool name is a valid target, but a hook target is restricted to the
 * four phases the scripted hook double (AB-93/AB-257) and the future engine
 * (AB-95) both recognize.
 */
export type FaultOperation =
  | 'generate'
  | `tool:${string}`
  | `hook:${'before-model' | 'after-model' | 'before-tool' | 'after-tool'}`
  | `storage:${'get' | 'set' | 'delete' | 'query'}`
  | 'signal'
  | 'transport'
  | 'delivery';

/**
 * When, across repeated invocations of the same operation, a fault fires.
 */
export type FaultOccurrence =
  | { readonly kind: 'nth'; readonly n: number }
  | { readonly kind: 'every' }
  | { readonly kind: 'after-sequence'; readonly sequence: number };

/**
 * One entry in a `FaultPlan`. `effect` is deliberately `unknown` — AB-92's
 * sketch leaves the effect vocabulary (throw, delay, corrupt, drop) to the
 * engine that interprets it (AB-95); this slice fixes only the entry's
 * addressing shape.
 */
export interface FaultPlanEntry {
  readonly id: string;
  readonly boundary: FaultBoundary;
  readonly operation: FaultOperation;
  readonly occurrence: FaultOccurrence;
  readonly effect: unknown;
}

/** An ordered, immutable set of fault-plan entries. */
export type FaultPlan = readonly FaultPlanEntry[];

/**
 * Evidence that a plan entry fired, for a reproduction artifact's
 * `firedFaults` (AB-92 AC8). The canonical definition — `event-recorder.ts`'s
 * `CausalTraceEntry.faultEvidence` imports this rather than redeclaring it,
 * now that this slice supplies the real `FaultBoundary` union it was
 * standing in for.
 */
export interface FiredFault {
  readonly plan: string;
  readonly boundary: FaultBoundary;
  readonly occurrence: number;
  readonly firedAt: string;
}
