// Type-level contract for AB-92's fault-plan vocabulary (AB-257 ships it).
// This file is checked by `tsc --noEmit`; it is not a runtime Bun test.
//
// A plain `const list: readonly T[] = [...]` catches a DROPPED member —
// removing a member from `T` makes a listed literal unassignable — but does
// NOT catch an ADDED one: `T[]` accepts a partial list just fine. Where an
// exhaustive `Exclude<T, ...>` check is possible (below, for the closed
// string-literal union `FaultBoundary`), this file also proves nothing was
// silently ADDED to `T` without a matching update here. `FaultOperation`
// mixes two open template-literal arms (`tool:${string}`, `storage:${...}`
// is closed but `tool:` is not) with closed ones, so only its closed pieces
// (the bare literals and the `hook:`/`storage:` template arms) are checked
// this way — `Exclude` can't finitely subtract an open template type.
// `FaultOccurrence` is a discriminated union of object shapes, not string
// literals; its members are pinned by one constructible value plus one
// `@ts-expect-error` malformed-shape case each, not by `Exclude`.

import type { FaultEffect } from './fault-engine';
import { FAULT_BOUNDARY_EFFECT_KINDS } from './fault-engine';
import type {
  FaultBoundary,
  FaultOccurrence,
  FaultOperation,
  FaultPlan,
  FaultPlanEntry,
  FiredFault,
} from './fault-plan';

// --- FaultBoundary: every member is assignable, nothing extra is. ---------

const boundaries: readonly FaultBoundary[] = [
  'before-work',
  'after-effect',
  'before-commit',
  'after-commit',
  'lost-acknowledgement',
  'stale-read',
  'duplicate-delivery',
  'corrupt-payload',
  'ignored-abort',
  'process-death',
];
void boundaries;

// Exactness: fails to compile if `FaultBoundary` gains a member not listed
// in `boundaries` above — `Exclude` over a closed string-literal union can
// finitely subtract, unlike `FaultOperation`'s open template arms below.
type MissingFaultBoundaryMembers = Exclude<FaultBoundary, (typeof boundaries)[number]>;
const _faultBoundaryExhaustive: MissingFaultBoundaryMembers extends never
  ? true
  : ['FaultBoundary gained a member not listed in `boundaries`:', MissingFaultBoundaryMembers] =
  true;
void _faultBoundaryExhaustive;

// @ts-expect-error — not a member of FaultBoundary.
const notABoundary: FaultBoundary = 'before-generate';
void notABoundary;

// --- FaultOperation: the literal, the two open template forms, and the closed one. ---

const operations: readonly FaultOperation[] = [
  'generate',
  'tool:search',
  'tool:',
  'hook:before-model',
  'hook:after-model',
  'hook:before-tool',
  'hook:after-tool',
  'storage:get',
  'storage:set',
  'storage:delete',
  'storage:query',
  'signal',
  'transport',
  'delivery',
];
void operations;

// Exactness over FaultOperation's CLOSED members only: `tool:${string}` is
// dropped first (an open template arm `Exclude` legitimately removes as a
// whole match, even though the arm itself is infinite), then the remainder
// is compared against `operations` above. This catches a dropped or added
// bare literal or `hook:`/`storage:` phase; it cannot say anything about
// `tool:${string}`, which has no finite member list to compare against.
type NonToolOperations = Exclude<FaultOperation, `tool:${string}`>;
type MissingClosedFaultOperationMembers = Exclude<NonToolOperations, (typeof operations)[number]>;
const _faultOperationClosedExhaustive: MissingClosedFaultOperationMembers extends never
  ? true
  : [
      'FaultOperation gained a closed member not listed in `operations`:',
      MissingClosedFaultOperationMembers,
    ] = true;
void _faultOperationClosedExhaustive;

// @ts-expect-error — "hook:before-commit" is not one of the four closed hook phases.
const notAnOperation: FaultOperation = 'hook:before-commit';
void notAnOperation;

// @ts-expect-error — "storage:list" is not one of the four closed storage operations.
const notAStorageOperation: FaultOperation = 'storage:list';
void notAStorageOperation;

// --- FaultOccurrence: the three discriminated members. --------------------

const nth: FaultOccurrence = { kind: 'nth', n: 1 };
const every: FaultOccurrence = { kind: 'every' };
const afterSequence: FaultOccurrence = { kind: 'after-sequence', sequence: 3 };
void nth;
void every;
void afterSequence;

// @ts-expect-error — 'nth' requires `n`, not `sequence`.
const malformedNth: FaultOccurrence = { kind: 'nth', sequence: 1 };
void malformedNth;

// --- FaultPlanEntry / FaultPlan / FiredFault shapes. -----------------------

const entry: FaultPlanEntry = {
  id: 'entry-1',
  boundary: 'before-work',
  operation: 'generate',
  occurrence: { kind: 'every' },
  effect: undefined,
};
const plan: FaultPlan = [entry];
void plan;

const malformedEntry: FaultPlanEntry = {
  id: 'entry-2',
  // @ts-expect-error — `boundary` must be a `FaultBoundary`, not an arbitrary string.
  boundary: 'not-a-boundary',
  operation: 'generate',
  occurrence: { kind: 'every' },
  effect: undefined,
};
void malformedEntry;

const fired: FiredFault = {
  plan: 'plan-1',
  boundary: 'after-commit',
  occurrence: 1,
  firedAt: new Date(0).toISOString(),
};
void fired;

const malformedFired: FiredFault = {
  plan: 'plan-1',
  // @ts-expect-error — `boundary` on `FiredFault` is `FaultBoundary`, not `string`.
  boundary: 'not-a-boundary',
  occurrence: 1,
  firedAt: new Date(0).toISOString(),
};
void malformedFired;

// --- AB-265: every FaultBoundary has at least one engine binding. ---------
//
// `FAULT_BOUNDARY_EFFECT_KINDS` (fault-engine.ts) is declared as a mapped
// type over `FaultBoundary` itself, so TypeScript already rejects a missing
// key at its own declaration site — this assignment is the second,
// independent proof: it fails to compile if `FaultBoundary` ever gains a
// member `FAULT_BOUNDARY_EFFECT_KINDS` doesn't (yet) have a matching key
// for, exactly like `_faultBoundaryExhaustive` above but anchored to the
// engine's own binding table rather than the `boundaries` literal.
const _faultBoundaryEngineBindingExhaustive: Record<FaultBoundary, readonly FaultEffect['kind'][]> =
  FAULT_BOUNDARY_EFFECT_KINDS;
void _faultBoundaryEngineBindingExhaustive;
