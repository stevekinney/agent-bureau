import type {
  ScheduleFilter,
  ScheduleOptions,
  ScheduleSpec,
  ScheduleSummary,
} from '@lostgradient/weft';
import { ScheduleHandle } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { AnyRunEngine } from './create-run-engine';
import type { SchedulingEngine } from './schedule-agent';
import {
  createAgentSchedule,
  createAgentScheduler,
  UnrunnableScheduleError,
} from './schedule-agent';

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
//
// Contract change (PRRT_kwDORvupsc6Mddv7): registering a durable agent schedule
// is REJECTED until the scheduled-fire path is wired (tracked in #109). A
// schedule registered today would fire the `agentRun` workflow with a
// `ScheduledAgentRunInput` it rejects, and there is no fire-time service
// resolver, so every tick would fail silently. We reject up front — matching
// `Bureau.createSchedule` — rather than register a broken schedule. These tests
// assert that honest rejection (they previously asserted successful
// registration; that behaviour was the bug).
// ---------------------------------------------------------------------------

describe('createAgentSchedule', () => {
  it('rejects with UnrunnableScheduleError instead of registering a schedule', async () => {
    const engine = makeSchedulingEngine();

    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine as unknown as AnyRunEngine,
        agentName: 'researcher',
        spec: { cron: '0 9 * * *' },
        input: 'Summarize overnight activity',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnrunnableScheduleError);
    expect((caught as Error).message).toMatch(/not yet wired/i);
    // Crucially: it must NOT have reached the engine — no broken schedule lands.
    expect(engine.calls).toHaveLength(0);
  });

  it('does not register even when a session, overlap, or stable id is supplied', async () => {
    const engine = makeSchedulingEngine();

    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine as unknown as AnyRunEngine,
        agentName: 'researcher',
        spec: { every: '6h' },
        input: 'hello',
        session: 'daily-digest',
        overlap: 'queue',
        id: 'daily-digest-sched',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnrunnableScheduleError);
    expect(engine.calls).toHaveLength(0);
  });

  it('references the tracking issue in the rejection message', async () => {
    const engine = makeSchedulingEngine();

    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine as unknown as AnyRunEngine,
        agentName: 'researcher',
        spec: { every: '1h' },
        input: 'hello',
      });
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).toMatch(/#109/);
  });
});

// ---------------------------------------------------------------------------
// createAgentScheduler
// ---------------------------------------------------------------------------

describe('createAgentScheduler', () => {
  it('schedule() rejects with UnrunnableScheduleError (routes through createAgentSchedule)', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine });

    let caught: unknown;
    try {
      await scheduler.schedule('researcher', {
        spec: { every: '6h' },
        input: 'Nightly report',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnrunnableScheduleError);
    // The unrunnable schedule never reaches the engine.
    expect(engine.calls).toHaveLength(0);
  });

  it('schedule() rejects regardless of agentName / session', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine });

    let caught: unknown;
    try {
      await scheduler.schedule('writer', { spec: { every: '1h' }, input: 'hello', session: 's1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnrunnableScheduleError);
    expect(engine.calls).toHaveLength(0);
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

  it('schedule() rejects even with a custom workflowType override', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine, workflowType: 'myRun' });

    let caught: unknown;
    try {
      await scheduler.schedule('agent', { spec: { every: '1h' }, input: 'x' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnrunnableScheduleError);
    expect(engine.calls).toHaveLength(0);
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
