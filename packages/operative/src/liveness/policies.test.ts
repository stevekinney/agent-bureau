import { describe, expect, it } from 'bun:test';

import {
  AGENT_RUN_PROVIDER_TURN_POLICY,
  BACKGROUND_EVALUATION_POLICY,
  GATEWAY_CONNECTION_POLICY,
  LIVENESS_POLICY_VERSION,
  SCHEDULER_TASK_POLICY,
  sessionMonitorPolicy,
  TOOL_CALL_POLICY,
  toolCallPolicy,
  WEBHOOK_DELIVERY_POLICY,
  WEFT_ACTIVITY_POLICY,
  WEFT_STREAM_POLICY,
  WEFT_TASK_POLICY,
  WEFT_WORKER_POLICY,
} from './policies';
import type { StallPolicy } from './types';

const ALL_ROWS: readonly StallPolicy[] = [
  AGENT_RUN_PROVIDER_TURN_POLICY,
  TOOL_CALL_POLICY,
  sessionMonitorPolicy(10_000),
  SCHEDULER_TASK_POLICY,
  GATEWAY_CONNECTION_POLICY,
  BACKGROUND_EVALUATION_POLICY,
  WEBHOOK_DELIVERY_POLICY,
  WEFT_ACTIVITY_POLICY,
  WEFT_WORKER_POLICY,
  WEFT_TASK_POLICY,
  WEFT_STREAM_POLICY,
];

describe('LIVENESS_POLICY_VERSION', () => {
  it('is the constant fixed by AB-214 coordinator rulings', () => {
    expect(LIVENESS_POLICY_VERSION).toBe('ab-88/2026-09-01');
  });
});

describe('jitterMs — 10 percent of cadenceMs with a 50ms floor', () => {
  it('is 0 for a row with no cadenceMs', () => {
    expect(AGENT_RUN_PROVIDER_TURN_POLICY.cadenceMs).toBeUndefined();
    expect(AGENT_RUN_PROVIDER_TURN_POLICY.jitterMs).toBe(0);
  });

  it('is 3000 for the default 30000ms tool-call cadence', () => {
    expect(TOOL_CALL_POLICY.cadenceMs).toBe(30_000);
    expect(TOOL_CALL_POLICY.jitterMs).toBe(3000);
  });

  it('floors at 50ms for a small cadence override', () => {
    const policy = toolCallPolicy(100);
    expect(policy.jitterMs).toBe(50);
  });

  it('scales with a caller-supplied cadence override', () => {
    const policy = toolCallPolicy(5000);
    expect(policy.jitterMs).toBe(500);
  });

  it('is 800 for the 8000ms gateway-connection cadence', () => {
    expect(GATEWAY_CONNECTION_POLICY.cadenceMs).toBe(8000);
    expect(GATEWAY_CONNECTION_POLICY.jitterMs).toBe(800);
  });

  it('is 0 for session.monitor (no tolerance band, per AB-88)', () => {
    expect(sessionMonitorPolicy(10_000).jitterMs).toBe(0);
  });
});

describe('n/a cells are encoded as 0, never left undefined', () => {
  it.each(ALL_ROWS.map((row) => [row.operation, row] as const))(
    'graceMs and missedPulseThreshold are always defined numbers on %s',
    (_operation, row) => {
      expect(typeof row.graceMs).toBe('number');
      expect(typeof row.missedPulseThreshold).toBe('number');
    },
  );
});

describe('wall-clock-owner rows never run a competing local timer', () => {
  for (const row of [
    WEFT_ACTIVITY_POLICY,
    WEFT_WORKER_POLICY,
    WEFT_TASK_POLICY,
    WEFT_STREAM_POLICY,
  ]) {
    it(`${row.operation} is wall-clock-owner with suspensionBehavior not-applicable`, () => {
      expect(row.clockSource).toBe('wall-clock-owner');
      expect(row.suspensionBehavior).toBe('not-applicable');
      expect(row.recovery).toBe('requires-explicit-recovered-transition');
    });
  }
});

describe('every monotonic-observer row uses pause-on-suspected-suspension', () => {
  for (const row of [
    AGENT_RUN_PROVIDER_TURN_POLICY,
    TOOL_CALL_POLICY,
    sessionMonitorPolicy(1000),
    SCHEDULER_TASK_POLICY,
    GATEWAY_CONNECTION_POLICY,
    BACKGROUND_EVALUATION_POLICY,
    WEBHOOK_DELIVERY_POLICY,
  ]) {
    it(`${row.operation}`, () => {
      expect(row.clockSource).toBe('monotonic-observer');
      expect(row.suspensionBehavior).toBe('pause-on-suspected-suspension');
    });
  }
});

describe('row identity', () => {
  it('authors every operation name AB-88/AB-214 name', () => {
    const operations = new Set(ALL_ROWS.map((row) => row.operation));
    expect(operations).toEqual(
      new Set([
        'agent-run.provider-turn',
        'tool-call',
        'session.monitor',
        'scheduler-task',
        'gateway-connection',
        'background-evaluation',
        'webhook-delivery',
        'weft-activity',
        'weft-worker',
        'weft-task',
        'weft-stream',
      ]),
    );
  });

  it('scheduler-task requires an explicit recovered transition', () => {
    expect(SCHEDULER_TASK_POLICY.recovery).toBe('requires-explicit-recovered-transition');
  });

  it('tool-call and gateway-connection resume on the next pulse', () => {
    expect(TOOL_CALL_POLICY.recovery).toBe('resume-on-next-pulse');
    expect(GATEWAY_CONNECTION_POLICY.recovery).toBe('resume-on-next-pulse');
  });

  it('sessionMonitorPolicy threads the caller-supplied cadence through unchanged', () => {
    expect(sessionMonitorPolicy(42).cadenceMs).toBe(42);
  });
});
