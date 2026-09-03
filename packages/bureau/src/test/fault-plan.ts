/**
 * The Bureau-scoped extension of `@lostgradient/operative`'s fault-plan
 * vocabulary (AB-263 / AB-94's tst-03d child).
 *
 * `packages/operative/src/test/fault-plan.ts` (AB-257) fixes `FaultBoundary`,
 * `FaultOperation`, `FaultOccurrence`, `FaultPlanEntry`, `FaultPlan`, and
 * `FiredFault` for boundaries operative itself can see. Three boundaries
 * AB-92's Decision (2026-09-01) names are Bureau-owned resources invisible
 * from operative — webhook delivery, audit write, and scheduler task — so
 * this file widens `FaultOperation` into `BureauFaultOperation` and mirrors
 * `FaultPlanEntry`/`FaultPlan` with that widened operation, re-exporting
 * every operative fault type verbatim rather than redeclaring one, so there
 * is exactly one `FaultBoundary` union in the repository.
 *
 * Every plan entry still only NAMES a target — no engine exists yet to
 * execute a `BureauFaultPlan` at a boundary (AB-95/tst-04a is that engine).
 * What this file adds beyond the type vocabulary is the three selector
 * functions a future engine (and, today, a test asserting a plan entry's
 * addressing) uses to resolve a Bureau-scoped target to exactly one
 * concrete resource: a webhook delivery by its `WebhookDeliveryRecord.id`
 * (from `WebhookNotifier.listDeliveries()`), an audit write by its audit
 * entry key (`audit-trail.ts`'s own `encodeKey` encoding, reused here —
 * never reimplemented), and a scheduler task by its
 * `SubmitSchedulerTaskResponse.taskId`.
 */
import type {
  FaultBoundary,
  FaultOccurrence,
  FaultOperation,
  FaultPlan,
  FaultPlanEntry,
  FiredFault,
} from '@lostgradient/operative/test';

import type { AuditRecord } from '../audit-trail';
import { encodeKey } from '../audit-trail';
import type { SubmitSchedulerTaskResponse } from '../types';
import type { WebhookDeliveryRecord } from '../webhook-notifier';

// Re-exported verbatim (never redeclared) — see this file's module doc.
export type {
  FaultBoundary,
  FaultOccurrence,
  FaultOperation,
  FaultPlan,
  FaultPlanEntry,
  FiredFault,
};

/**
 * `FaultOperation` widened with the three Bureau-owned boundaries AB-92
 * names that operative cannot see: webhook delivery, audit write, and
 * scheduler task.
 */
export type BureauFaultOperation =
  FaultOperation | 'webhook-delivery' | 'audit-write' | 'scheduler-task';

/** Mirrors operative's `FaultPlanEntry` with the widened {@link BureauFaultOperation}. */
export interface BureauFaultPlanEntry {
  readonly id: string;
  readonly boundary: FaultBoundary;
  readonly operation: BureauFaultOperation;
  readonly occurrence: FaultOccurrence;
  readonly effect: unknown;
}

/** An ordered, immutable set of Bureau-scoped fault-plan entries. */
export type BureauFaultPlan = readonly BureauFaultPlanEntry[];

/** Raised by a selector when a target identifier resolves to zero or more than one candidate. */
export class BureauFaultSelectorResolutionError extends Error {
  readonly operation: 'webhook-delivery' | 'audit-write' | 'scheduler-task';
  readonly matchCount: number;

  constructor(
    operation: 'webhook-delivery' | 'audit-write' | 'scheduler-task',
    targetDescription: string,
    matchCount: number,
  ) {
    super(
      `Bureau fault selector for "${operation}" must resolve to exactly one resource for ` +
        `${targetDescription}, found ${matchCount}.`,
    );
    this.name = 'BureauFaultSelectorResolutionError';
    this.operation = operation;
    this.matchCount = matchCount;
  }
}

/**
 * Resolves a webhook-delivery fault target to exactly one
 * {@link WebhookDeliveryRecord} by its `id` (as listed by
 * `WebhookNotifier.listDeliveries()`). Throws
 * {@link BureauFaultSelectorResolutionError} when `deliveries` contains zero
 * or more than one record with that id.
 */
export function selectWebhookDeliveryFaultTarget(
  deliveries: readonly WebhookDeliveryRecord[],
  deliveryId: string,
): WebhookDeliveryRecord {
  const matches = deliveries.filter((delivery) => delivery.id === deliveryId);
  const [match] = matches;
  if (matches.length !== 1 || !match) {
    throw new BureauFaultSelectorResolutionError(
      'webhook-delivery',
      `delivery id "${deliveryId}"`,
      matches.length,
    );
  }
  return match;
}

/**
 * Resolves an audit-write fault target to exactly one {@link AuditRecord} by
 * its audit entry key — `audit-trail.ts`'s own `encodeKey(timestampMs,
 * sequence, runId)` encoding, reconstructed here from each candidate
 * record's own public fields rather than reimplemented. Throws
 * {@link BureauFaultSelectorResolutionError} when `records` contains zero or
 * more than one record whose key matches.
 */
export function selectAuditWriteFaultTarget(
  records: readonly AuditRecord[],
  auditEntryKey: string,
): AuditRecord {
  const matches = records.filter(
    (record) => encodeKey(record.timestampMs, record.sequence, record.runId) === auditEntryKey,
  );
  const [match] = matches;
  if (matches.length !== 1 || !match) {
    throw new BureauFaultSelectorResolutionError(
      'audit-write',
      `audit entry key "${auditEntryKey}"`,
      matches.length,
    );
  }
  return match;
}

/**
 * Resolves a scheduler-task fault target to exactly one
 * {@link SubmitSchedulerTaskResponse} by its `taskId`. Throws
 * {@link BureauFaultSelectorResolutionError} when `tasks` contains zero or
 * more than one response with that id.
 */
export function selectSchedulerTaskFaultTarget(
  tasks: readonly SubmitSchedulerTaskResponse[],
  taskId: string,
): SubmitSchedulerTaskResponse {
  const matches = tasks.filter((task) => task.taskId === taskId);
  const [match] = matches;
  if (matches.length !== 1 || !match) {
    throw new BureauFaultSelectorResolutionError(
      'scheduler-task',
      `task id "${taskId}"`,
      matches.length,
    );
  }
  return match;
}
