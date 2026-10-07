/**
 * COR-851 — the view a goal workflow caches in its history.
 *
 * Bureau's `GoalState` is assignable to `GoalWorkflowRecord` and carries much
 * more at runtime (the objective, the conversation policy, the audit log), so
 * the view is built from an allowlist: a field the decision does not read must
 * never reach the workflow's history.
 */
import { describe, expect, it } from 'bun:test';

import type { ActivityContext } from '@lostgradient/weft';

import { createGoalWorkflowActivities, toGoalWorkflowView } from './goal-workflow-activities';
import type { GoalWorkflowPorts, GoalWorkflowRecord } from './goal-workflow-ports';

const record: GoalWorkflowRecord = {
  goalRunId: 'g1',
  status: 'running',
  transitionSeq: 3,
  validator: { name: 'check', version: '1' },
  validatorTimeoutMs: 1000,
  bounds: { maximumAttempts: 3, maximumTotalSteps: 10 },
  attempts: [
    {
      attemptId: 'a0',
      attemptIndex: 0,
      runId: 'goal-g1-a0',
      sessionId: 'goal-g1-s0',
      startedAt: '2026-10-02T12:00:00.000Z',
      status: 'failed',
      usage: { steps: 1, tokens: 5 },
      feedback: 'try again',
      validation: {
        identity: { name: 'check', version: '1' },
        startedAt: '2026-10-02T12:00:01.000Z',
        completedAt: '2026-10-02T12:00:02.000Z',
        outcome: { kind: 'fail', feedback: 'x'.repeat(100) } as never,
        decisionId: 'd0',
      },
    },
  ],
  usage: { attempts: 1, steps: 1, tokens: 5, durationMs: 10 },
  cancellation: { requestedAt: '2026-10-02T12:00:03.000Z' },
  createdAt: '2026-10-02T12:00:00.000Z',
};

describe('toGoalWorkflowView', () => {
  it('keeps the fields a decision reads and drops recorded validation outcomes', () => {
    const view = toGoalWorkflowView(record);

    expect(view).toEqual({
      ...record,
      attempts: [{ ...record.attempts[0]!, validation: undefined }].map(
        ({ validation: _validation, ...attempt }) => attempt,
      ),
    });
  });

  it('carries nothing a Bureau goal record holds beyond the workflow record', () => {
    const wide = {
      ...record,
      objective: { agentName: 'worker', prompt: 'p'.repeat(64_000) },
      conversationPolicy: { kind: 'continue' },
      auditLog: Array.from({ length: 50 }, (_, index) => ({ seq: index })),
      principal: 'alice',
      cancellation: { requestedAt: '2026-10-02T12:00:03.000Z', requestedBy: 'alice' },
      attempts: record.attempts.map((attempt) => ({ ...attempt, sessionMetadata: 'extra' })),
    } as GoalWorkflowRecord;

    const view = toGoalWorkflowView(wide);

    expect(Object.keys(view).toSorted()).toEqual(
      [
        'attempts',
        'bounds',
        'cancellation',
        'createdAt',
        'goalRunId',
        'status',
        'transitionSeq',
        'usage',
        'validator',
        'validatorTimeoutMs',
      ].toSorted(),
    );
    expect(view.cancellation).toEqual({ requestedAt: '2026-10-02T12:00:03.000Z' });
    expect(Object.keys(view.attempts[0]!)).not.toContain('sessionMetadata');
    expect(JSON.stringify(view)).not.toContain('pppp');
  });
});

describe('the activities the controller runs the host ports through', () => {
  it("hands the validator activity's own signal to the port, so a cancelled goal's validator can stop", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const activities = createGoalWorkflowActivities({
      runValidator: (_request: unknown, signal?: AbortSignal) => {
        seen.push(signal);
        return Promise.resolve({
          identity: { name: 'check', version: '1' },
          startedAt: '2026-10-02T12:00:00.000Z',
          completedAt: '2026-10-02T12:00:00.000Z',
          outcome: { kind: 'canceled' },
        });
      },
    } as unknown as GoalWorkflowPorts);
    const controller = new AbortController();

    await activities.runValidator(
      {
        goalRunId: 'g1',
        attemptId: 'a0',
        attemptIndex: 0,
        validator: { name: 'check', version: '1' },
        validatorTimeoutMs: undefined,
      },
      { signal: controller.signal } as ActivityContext,
    );

    expect(seen).toEqual([controller.signal]);
  });
});
