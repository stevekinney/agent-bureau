// Type-level contract for AB-92's fault-plan vocabulary (AB-257 ships it).
// This file is checked by `tsc --noEmit`; it is not a runtime Bun test. It
// pins every union member of `FaultBoundary`, `FaultOperation`, and
// `FaultOccurrence` so a future engine (AB-95) cannot silently drop one —
// removing a member here is a `@ts-expect-error` mismatch, and adding one to
// the real type without adding it here leaves a case unassignable below.

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
