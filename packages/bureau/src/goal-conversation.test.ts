/**
 * COR-851 — a session is the goal's only when every run in it is one of the
 * goal's own attempts, by the exact id the goal derives for that attempt.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgentSession } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { foreignSessionReason, goalSessionMetadata } from './goal-conversation';
import { createGoalState, goalAttemptRunId } from './goal-state';

const runtime = createDefaultRuntimeServices();
const MAXIMUM_ATTEMPTS = 3;

const record = createGoalState({
  goalRunId: 'g1',
  identity: { name: 'goal', version: '1' },
  objective: { agentName: 'worker', prompt: 'work' },
  validator: { name: 'check', version: '1' },
  conversationPolicy: { kind: 'continue' },
  bounds: { maximumAttempts: MAXIMUM_ATTEMPTS, maximumTotalSteps: 10 },
  now: '2026-10-02T12:00:00.000Z',
});

const sessionWithRuns = (runIds: readonly string[], agentName = 'worker') =>
  createAgentSession({
    agentName,
    conversationHistory: createConversationHistory(undefined, { runtime }),
    id: 'goal-g1-s0',
    metadata: goalSessionMetadata(record),
    runs: runIds.map((runId, sequence) => ({
      runId,
      sequence,
      status: 'completed' as const,
      startedAt: record.createdAt,
      agentName: 'worker',
    })),
    runtime,
  });

describe('foreignSessionReason and the runs a session holds', () => {
  it("refuses a session that belongs to a different agent than the goal's", () => {
    const reason = foreignSessionReason(record, sessionWithRuns([], 'other-agent'));
    expect(reason).toContain('belongs to a different agent');
  });

  it("refuses a session holding a run that was started by a different agent than the goal's", () => {
    const session = sessionWithRuns([goalAttemptRunId('g1', 0)]);
    const foreign = {
      ...session,
      runs: session.runs.map((ref) => ({ ...ref, agentName: 'other-agent' })),
    };
    expect(foreignSessionReason(record, foreign)).toContain('different agent');
  });

  it("accepts a session holding exactly the goal's own attempt run ids", () => {
    const session = sessionWithRuns([goalAttemptRunId('g1', 0), goalAttemptRunId('g1', 2)]);
    expect(foreignSessionReason(record, session)).toBeUndefined();
  });

  it.each([
    ['a zero-padded index', 'goal-g1-a00'],
    ['an index at the attempt limit', `goal-g1-a${MAXIMUM_ATTEMPTS}`],
    ['an index far past the attempt limit', 'goal-g1-a9999'],
    ['an index with a sign', 'goal-g1-a+1'],
    ['another goal whose id extends this one', 'goal-g1-a0-a0'],
  ])('refuses a session holding %s', (_label, runId) => {
    const reason = foreignSessionReason(record, sessionWithRuns([runId]));
    expect(reason).toContain("not one of this goal's attempts");
  });
});
