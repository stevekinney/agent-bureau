/**
 * COR-851 — the namespaces a durable goal owns, and the guarantee that every id
 * it derives lies inside them.
 */
import {
  GOAL_AUDIT_WORKFLOW_ID_PREFIX,
  GOAL_RESERVED_IDENTIFIER_PREFIXES,
  reservedGoalIdentifierPrefix,
  reservedIdentifierReason,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { encodeOwner } from './durable-event-history';
import { attemptSessionId, goalAttemptRunId, goalSessionId, goalWorkflowId } from './goal-state';

describe('the identifiers a goal derives', () => {
  const goalRunIds = ['g1', 'nightly:build', 'a-a0', 'x y'];

  it.each(goalRunIds)('all lie inside a reserved prefix for the goal id %s', (goalRunId) => {
    const derived = [
      goalWorkflowId(goalRunId),
      goalAttemptRunId(goalRunId, 0),
      goalAttemptRunId(goalRunId, 7),
      goalSessionId(goalRunId, 0),
      attemptSessionId(goalRunId, 'fork-from-baseline', 3),
      encodeOwner({ kind: 'goal', id: goalRunId }),
    ];

    for (const id of derived) {
      expect(reservedGoalIdentifierPrefix(id)).toBeDefined();
    }
  });

  it('keeps the audit workflow id apart from the controller workflow id', () => {
    expect(encodeOwner({ kind: 'goal', id: 'g1' }).startsWith(GOAL_AUDIT_WORKFLOW_ID_PREFIX)).toBe(
      true,
    );
    expect(encodeOwner({ kind: 'goal', id: 'g1' })).not.toBe(goalWorkflowId('g1'));
  });
});

describe('reservedIdentifierReason', () => {
  it.each(GOAL_RESERVED_IDENTIFIER_PREFIXES.map((prefix) => `${prefix}anything`))(
    'refuses %s',
    (id) => {
      expect(reservedIdentifierReason('session id', id)).toContain('reserved-identifier');
    },
  );

  it.each(['run-1', 'session-1', 'goalpost', 'my-goal', 'goals', 'child-run-1', ''])(
    'leaves %p free',
    (id) => {
      expect(reservedIdentifierReason('session id', id)).toBeUndefined();
    },
  );
});
