import { describe, expect, it } from 'bun:test';

import type { AuditRecord } from '../audit-trail';
import { encodeKey } from '../audit-trail';
import type { WebhookDeliveryRecord } from '../webhook-notifier';
import {
  type BureauFaultOperation,
  type BureauFaultPlan,
  type BureauFaultPlanEntry,
  BureauFaultSelectorResolutionError,
  selectAuditWriteFaultTarget,
  selectSchedulerTaskFaultTarget,
  selectWebhookDeliveryFaultTarget,
} from './fault-plan';

function delivery(overrides: Partial<WebhookDeliveryRecord> = {}): WebhookDeliveryRecord {
  return {
    id: 'run-1:0',
    triggerType: 'approval-pending',
    targetUrl: 'https://example.test/hook',
    runId: 'run-1',
    status: 'pending',
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function auditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    timestamp: new Date(0).toISOString(),
    timestampMs: 0,
    sequence: 1,
    runId: 'run-1',
    type: 'tool.started',
    detail: {},
    ...overrides,
  };
}

describe('BureauFaultOperation', () => {
  it('accepts every operative FaultOperation plus the three Bureau-scoped operations', () => {
    const operations: BureauFaultOperation[] = [
      'generate',
      'tool:example',
      'hook:before-model',
      'storage:get',
      'signal',
      'transport',
      'delivery',
      'webhook-delivery',
      'audit-write',
      'scheduler-task',
    ];

    expect(operations).toHaveLength(10);
  });

  it('builds a BureauFaultPlan entry for each Bureau-scoped operation', () => {
    const plan: BureauFaultPlan = [
      {
        id: 'webhook-fault',
        boundary: 'before-commit',
        operation: 'webhook-delivery',
        occurrence: { kind: 'nth', n: 1 },
        effect: 'throw',
      },
      {
        id: 'audit-fault',
        boundary: 'after-commit',
        operation: 'audit-write',
        occurrence: { kind: 'every' },
        effect: 'drop',
      },
      {
        id: 'scheduler-fault',
        boundary: 'before-work',
        operation: 'scheduler-task',
        occurrence: { kind: 'after-sequence', sequence: 2 },
        effect: 'delay',
      },
    ] satisfies BureauFaultPlanEntry[];

    expect(plan).toHaveLength(3);
  });
});

describe('selectWebhookDeliveryFaultTarget', () => {
  it('resolves a delivery id to exactly one WebhookDeliveryRecord', () => {
    const target = delivery({ id: 'run-1:1' });
    const deliveries = [delivery({ id: 'run-1:0' }), target];

    expect(selectWebhookDeliveryFaultTarget(deliveries, 'run-1:1')).toBe(target);
  });

  it('throws BureauFaultSelectorResolutionError when no delivery matches', () => {
    expect(() =>
      selectWebhookDeliveryFaultTarget([delivery({ id: 'run-1:0' })], 'missing'),
    ).toThrow(BureauFaultSelectorResolutionError);
  });

  it('throws BureauFaultSelectorResolutionError when more than one delivery matches', () => {
    const deliveries = [delivery({ id: 'dup' }), delivery({ id: 'dup' })];

    expect(() => selectWebhookDeliveryFaultTarget(deliveries, 'dup')).toThrow(
      BureauFaultSelectorResolutionError,
    );
  });
});

describe('selectAuditWriteFaultTarget', () => {
  it('resolves an audit entry key (encodeKey(timestampMs, sequence, runId)) to exactly one AuditRecord', () => {
    const target = auditRecord({ timestampMs: 100, sequence: 3, runId: 'run-7' });
    const records = [auditRecord({ timestampMs: 50, sequence: 1, runId: 'run-1' }), target];
    const key = encodeKey(100, 3, 'run-7');

    expect(selectAuditWriteFaultTarget(records, key)).toBe(target);
  });

  it('throws BureauFaultSelectorResolutionError when no record matches the key', () => {
    expect(() => selectAuditWriteFaultTarget([auditRecord()], 'audit:v1:not-a-real-key')).toThrow(
      BureauFaultSelectorResolutionError,
    );
  });
});

describe('selectSchedulerTaskFaultTarget', () => {
  it('resolves a taskId to exactly one SubmitSchedulerTaskResponse', () => {
    const target = { taskId: 'task-2', priority: 'immediate' as const, status: 'queued' as const };
    const tasks = [
      { taskId: 'task-1', priority: 'background' as const, status: 'queued' as const },
      target,
    ];

    expect(selectSchedulerTaskFaultTarget(tasks, 'task-2')).toBe(target);
  });

  it('throws BureauFaultSelectorResolutionError when more than one task matches', () => {
    const tasks = [
      { taskId: 'dup', priority: 'background' as const, status: 'queued' as const },
      { taskId: 'dup', priority: 'immediate' as const, status: 'queued' as const },
    ];

    expect(() => selectSchedulerTaskFaultTarget(tasks, 'dup')).toThrow(
      BureauFaultSelectorResolutionError,
    );
  });
});
