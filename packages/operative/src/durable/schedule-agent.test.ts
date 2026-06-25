import type {
  ScheduleFilter,
  ScheduleOptions,
  ScheduleSpec,
  ScheduleSummary,
} from '@lostgradient/weft';
import { ScheduleHandle } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { AnyRunEngine } from './create-run-engine';
import type { ScheduledAgentRunInput, SchedulingEngine } from './schedule-agent';
import { createAgentSchedule, createAgentScheduler } from './schedule-agent';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const mockSummary: ScheduleSummary = {
  id: 'test-sched-1',
  workflowType: 'agentRun',
  status: 'active',
  overlap: 'skip',
  backfill: false,
  createdAt: 0,
  updatedAt: 0,
  missedFireCount: 0,
  nextFireAt: null,
  queuedRuns: 0,
};

interface ScheduleCall {
  type: string;
  input: unknown;
  spec: string | ScheduleSpec;
  options?: ScheduleOptions;
}

/**
 * Create a fake ScheduleHandle for testing. We need to construct it with the
 * ScheduleHandle class, but only the id matters for the tests here; the other
 * methods are stubs.
 */
function makeFakeHandle(id: string): ScheduleHandle {
  // ScheduleHandle is a class that needs a ScheduleHandleEngine — we stub it.
  const stubEngine = {
    pauseSchedule: async () => {},
    resumeSchedule: async () => {},
    cancelSchedule: async () => {},
    updateSchedule: async () => {},
    getSchedule: async () => mockSummary,
  };
  return new ScheduleHandle(id, stubEngine);
}

function makeSchedulingEngine(options?: {
  scheduleId?: string;
  summaries?: ScheduleSummary[];
}): SchedulingEngine & { calls: ScheduleCall[] } {
  const scheduleId = options?.scheduleId ?? 'test-sched-1';
  const summaries = options?.summaries ?? [mockSummary];
  const calls: ScheduleCall[] = [];

  return {
    calls,
    async schedule(
      type: string,
      input: unknown,
      spec: string | ScheduleSpec,
      opts?: ScheduleOptions,
    ): Promise<ScheduleHandle> {
      calls.push({ type, input, spec, options: opts });
      return makeFakeHandle(scheduleId);
    },
    async getSchedule(): Promise<ScheduleSummary | null> {
      return summaries[0] ?? null;
    },
    async listSchedules(): Promise<{
      items: ScheduleSummary[];
      total: number;
      offset: number;
      limit: number;
    }> {
      return { items: summaries, total: summaries.length, offset: 0, limit: 100 };
    },
    async pauseSchedule(): Promise<void> {},
    async resumeSchedule(): Promise<void> {},
    async cancelSchedule(): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// createAgentSchedule
// ---------------------------------------------------------------------------

describe('createAgentSchedule', () => {
  it('calls engine.schedule with the agentRun workflow type', async () => {
    const engine = makeSchedulingEngine();
    await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { cron: '0 9 * * *' },
      input: 'Summarize overnight activity',
    });

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.type).toBe('agentRun');
  });

  it('accepts a custom workflowType override', async () => {
    const engine = makeSchedulingEngine();
    await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      workflowType: 'customRun',
      agentName: 'researcher',
      spec: { cron: '0 9 * * *' },
      input: 'hello',
    });

    expect(engine.calls[0]?.type).toBe('customRun');
  });

  it('passes agentName and input in the workflow input', async () => {
    const engine = makeSchedulingEngine();
    await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { every: '6h' },
      input: 'Daily summary',
    });

    const input = engine.calls[0]?.input as ScheduledAgentRunInput;
    expect(input.agentName).toBe('researcher');
    expect(input.input).toBe('Daily summary');
  });

  it('passes sessionId when session is provided', async () => {
    const engine = makeSchedulingEngine();
    await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { cron: '0 9 * * *' },
      input: 'hello',
      session: 'daily-digest',
    });

    const input = engine.calls[0]?.input as ScheduledAgentRunInput;
    expect(input.sessionId).toBe('daily-digest');
  });

  it('does not include sessionId when session is absent', async () => {
    const engine = makeSchedulingEngine();
    await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { cron: '0 9 * * *' },
      input: 'hello',
    });

    const input = engine.calls[0]?.input as ScheduledAgentRunInput;
    expect(input.sessionId).toBeUndefined();
  });

  it("defaults overlap to 'skip'", async () => {
    const engine = makeSchedulingEngine();
    await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { every: '6h' },
      input: 'hello',
    });

    expect(engine.calls[0]?.options?.overlap).toBe('skip');
  });

  it('passes a custom overlap policy', async () => {
    const engine = makeSchedulingEngine();
    await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { every: '6h' },
      input: 'hello',
      overlap: 'queue',
    });

    expect(engine.calls[0]?.options?.overlap).toBe('queue');
  });

  it('passes a stable schedule id when provided', async () => {
    const engine = makeSchedulingEngine({ scheduleId: 'daily-digest-sched' });
    await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { cron: '0 9 * * *' },
      input: 'hello',
      id: 'daily-digest-sched',
    });

    expect(engine.calls[0]?.options?.id).toBe('daily-digest-sched');
  });

  it('returns a handle with the schedule id from the engine', async () => {
    const engine = makeSchedulingEngine({ scheduleId: 'my-schedule' });
    const handle = await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
    });

    expect(handle.id).toBe('my-schedule');
  });

  it('returns a handle with pause/resume/cancel/describe methods', async () => {
    const engine = makeSchedulingEngine();
    const handle = await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
    });

    expect(typeof handle.pause).toBe('function');
    expect(typeof handle.resume).toBe('function');
    expect(typeof handle.cancel).toBe('function');
    expect(typeof handle.describe).toBe('function');
  });

  it('passing the spec through to the engine', async () => {
    const engine = makeSchedulingEngine();
    await createAgentSchedule({
      engine: engine as unknown as AnyRunEngine,
      agentName: 'researcher',
      spec: { cron: '0 9 * * *' },
      input: 'hello',
    });

    expect(engine.calls[0]?.spec).toEqual({ cron: '0 9 * * *' });
  });
});

// ---------------------------------------------------------------------------
// createAgentScheduler
// ---------------------------------------------------------------------------

describe('createAgentScheduler', () => {
  it('schedule() calls engine.schedule with the agentRun type', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine });

    await scheduler.schedule('researcher', {
      spec: { every: '6h' },
      input: 'Nightly report',
    });

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.type).toBe('agentRun');
  });

  it('schedule() passes agentName in the workflow input', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine });

    await scheduler.schedule('writer', { spec: { every: '1h' }, input: 'hello' });

    const input = engine.calls[0]?.input as ScheduledAgentRunInput;
    expect(input.agentName).toBe('writer');
  });

  it('schedule() returns an AgentScheduleHandle', async () => {
    const engine = makeSchedulingEngine({ scheduleId: 'abc-123' });
    const scheduler = createAgentScheduler({ engine });

    const handle = await scheduler.schedule('researcher', {
      spec: { every: '1h' },
      input: 'hello',
    });

    expect(handle.id).toBe('abc-123');
  });

  it('getSchedule() delegates to engine.getSchedule', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine });

    const result = await scheduler.getSchedule('test-sched-1');

    expect(result?.id).toBe('test-sched-1');
  });

  it('listSchedules() delegates to engine.listSchedules', async () => {
    const engine = makeSchedulingEngine({
      summaries: [mockSummary, { ...mockSummary, id: 'sched-2' }],
    });
    const scheduler = createAgentScheduler({ engine });

    const result = await scheduler.listSchedules();

    expect(result.items).toHaveLength(2);
  });

  it('pauseSchedule() delegates to engine.pauseSchedule', async () => {
    const paused: string[] = [];
    const engine = makeSchedulingEngine();
    engine.pauseSchedule = async (id: string) => {
      paused.push(id);
    };
    const scheduler = createAgentScheduler({ engine });

    await scheduler.pauseSchedule('my-sched');

    expect(paused).toContain('my-sched');
  });

  it('cancelSchedule() delegates to engine.cancelSchedule', async () => {
    const cancelled: string[] = [];
    const engine = makeSchedulingEngine();
    engine.cancelSchedule = async (id: string) => {
      cancelled.push(id);
    };
    const scheduler = createAgentScheduler({ engine });

    await scheduler.cancelSchedule('my-sched');

    expect(cancelled).toContain('my-sched');
  });

  it('respects a custom workflowType override', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine, workflowType: 'myRun' });

    await scheduler.schedule('agent', { spec: { every: '1h' }, input: 'x' });

    expect(engine.calls[0]?.type).toBe('myRun');
  });

  it('listSchedules() can filter by status', async () => {
    let capturedFilter: ScheduleFilter | undefined;
    const engine = makeSchedulingEngine();
    const originalList = engine.listSchedules.bind(engine);
    engine.listSchedules = async (filter?: ScheduleFilter) => {
      capturedFilter = filter;
      return originalList(filter);
    };
    const scheduler = createAgentScheduler({ engine });

    await scheduler.listSchedules({ status: 'active' });

    expect(capturedFilter?.status).toBe('active');
  });
});
