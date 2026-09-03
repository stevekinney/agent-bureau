import type {
  ScheduleFilter,
  ScheduleOptions,
  ScheduleSpec,
  ScheduleSummary,
} from '@lostgradient/weft';
import { ScheduleHandle } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import type { SchedulePausedEvent } from '../events';
import type { ScheduledAgentRunInput, SchedulingEngine } from './schedule-agent';
import {
  createAgentSchedule,
  createAgentScheduler,
  InvalidScheduleError,
  isScheduledAgentRunInput,
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
  queuedRuns: [],
};

interface ScheduleCall {
  type: string;
  input: unknown;
  spec: string | ScheduleSpec;
  options?: ScheduleOptions;
}

/**
 * Create a fake ScheduleHandle for testing. We construct the real ScheduleHandle
 * class over a stub engine that records lifecycle calls, so handle-delegation can
 * be asserted (`pause`/`resume`/`cancel` route to the engine by id).
 */
function makeFakeHandle(id: string, recorder?: Record<string, string[]>): ScheduleHandle {
  const stubEngine = {
    pauseSchedule: async (scheduleId: string) => {
      recorder?.['pause']?.push(scheduleId);
    },
    resumeSchedule: async (scheduleId: string) => {
      recorder?.['resume']?.push(scheduleId);
    },
    cancelSchedule: async (scheduleId: string) => {
      recorder?.['cancel']?.push(scheduleId);
    },
    updateSchedule: async () => {},
    getSchedule: async () => mockSummary,
  };
  return new ScheduleHandle(id, stubEngine);
}

function makeSchedulingEngine(options?: {
  scheduleId?: string;
  summaries?: ScheduleSummary[];
  handleRecorder?: Record<string, string[]>;
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
      return makeFakeHandle(opts?.id ?? scheduleId, options?.handleRecorder);
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

/**
 * Flushes several microtask turns and reports whether `promise` is still
 * unsettled — used by the `AgentScheduleHandle.closed()` tests below to
 * assert a NEGATIVE (it does NOT resolve), which a plain `await` can't do.
 */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  return !settled;
}

// ---------------------------------------------------------------------------
// isScheduledAgentRunInput
// ---------------------------------------------------------------------------

describe('isScheduledAgentRunInput', () => {
  it('accepts a well-formed input with and without sessionId', () => {
    expect(isScheduledAgentRunInput({ agentName: 'a', input: 'hi' })).toBe(true);
    expect(isScheduledAgentRunInput({ agentName: 'a', input: 'hi', sessionId: 's' })).toBe(true);
    expect(isScheduledAgentRunInput({ agentName: 'a', input: 'hi', scheduleId: 'sched-1' })).toBe(
      true,
    );
  });

  it('rejects missing/mistyped fields and non-objects', () => {
    expect(isScheduledAgentRunInput(null)).toBe(false);
    expect(isScheduledAgentRunInput('nope')).toBe(false);
    expect(isScheduledAgentRunInput({ input: 'hi' })).toBe(false);
    expect(isScheduledAgentRunInput({ agentName: 'a' })).toBe(false);
    expect(isScheduledAgentRunInput({ agentName: 1, input: 'hi' })).toBe(false);
    expect(isScheduledAgentRunInput({ agentName: 'a', input: 'hi', sessionId: 5 })).toBe(false);
    expect(isScheduledAgentRunInput({ agentName: 'a', input: 'hi', scheduleId: 5 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createAgentSchedule
//
// Registers a durable agent schedule against the engine. Each fire starts the
// `agentRun` workflow with a `ScheduledAgentRunInput` ({ agentName, input,
// scheduleId, sessionId? }); the bureau's run-services resolver builds fresh run
// deps per fire (#109). These tests assert the registration shape and the
// returned handle's lifecycle delegation.
// ---------------------------------------------------------------------------

describe('createAgentSchedule', () => {
  it('registers the agentRun workflow with a ScheduledAgentRunInput', async () => {
    const engine = makeSchedulingEngine();

    const handle = await createAgentSchedule({
      engine: engine,
      agentName: 'researcher',
      spec: { cron: '0 9 * * *' },
      input: 'Summarize overnight activity',
    });

    expect(engine.calls).toHaveLength(1);
    const call = engine.calls[0]!;
    expect(call.type).toBe('agentRun');
    expect(call.spec).toEqual({ cron: '0 9 * * *' });
    const input = call.input as ScheduledAgentRunInput;
    expect(input.agentName).toBe('researcher');
    expect(input.input).toBe('Summarize overnight activity');
    expect(input.scheduleId).toBe(handle.id);
    // No session → the scheduled input carries no sessionId (fresh per fire).
    expect(input.sessionId).toBeUndefined();
    expect(call.options?.id).toBe(handle.id);
  });

  it('threads description, session, overlap, and stable id through to the engine', async () => {
    const engine = makeSchedulingEngine({ scheduleId: 'daily-digest-sched' });

    await createAgentSchedule({
      engine: engine,
      agentName: 'researcher',
      spec: { every: '6h' },
      input: 'hello',
      description: 'Daily digest',
      session: 'daily-digest',
      overlap: 'skip',
      id: 'daily-digest-sched',
    });

    expect(engine.calls).toHaveLength(1);
    const call = engine.calls[0]!;
    expect(call.spec).toEqual({ every: '6h' });
    expect((call.input as ScheduledAgentRunInput).scheduleId).toBe('daily-digest-sched');
    expect((call.input as ScheduledAgentRunInput).sessionId).toBe('daily-digest');
    expect(call.options).toEqual({
      description: 'Daily digest',
      overlap: 'skip',
      id: 'daily-digest-sched',
    });
  });

  it('trims a padded schedule id before registering', async () => {
    const engine = makeSchedulingEngine();

    await createAgentSchedule({
      engine: engine,
      agentName: 'researcher',
      spec: { every: '6h' },
      input: 'hello',
      id: '  daily-digest-sched  ',
    });

    const call = engine.calls[0]!;
    expect((call.input as ScheduledAgentRunInput).scheduleId).toBe('daily-digest-sched');
    expect(call.options).toEqual({ id: 'daily-digest-sched' });
  });

  it('uses a custom workflowType when supplied', async () => {
    const engine = makeSchedulingEngine();

    await createAgentSchedule({
      engine: engine,
      workflowType: 'myRun',
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
    });

    expect(engine.calls[0]!.type).toBe('myRun');
  });

  it('trims a padded session id before registering', async () => {
    const engine = makeSchedulingEngine();
    await createAgentSchedule({
      engine: engine,
      agentName: 'a',
      spec: { every: '1h' },
      input: 'x',
      session: '  daily-digest  ',
    });
    expect((engine.calls[0]!.input as ScheduledAgentRunInput).sessionId).toBe('daily-digest');
  });

  it('rejects a blank session at the chokepoint (before reaching the engine)', async () => {
    const engine = makeSchedulingEngine();
    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'a',
        spec: { every: '1h' },
        input: 'x',
        session: '   ',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidScheduleError);
    expect(engine.calls).toHaveLength(0);
  });

  it('rejects a blank schedule id at the chokepoint (before reaching the engine)', async () => {
    const engine = makeSchedulingEngine();
    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'a',
        spec: { every: '1h' },
        input: 'x',
        id: '   ',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidScheduleError);
    expect(engine.calls).toHaveLength(0);
  });

  it("rejects overlap 'allow' combined with a recurring session", async () => {
    const engine = makeSchedulingEngine();
    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'a',
        spec: { every: '1h' },
        input: 'x',
        session: 'digest',
        overlap: 'allow',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidScheduleError);
    expect(engine.calls).toHaveLength(0);
  });

  it("allows overlap 'allow' when there is no session (stateless fires)", async () => {
    const engine = makeSchedulingEngine();
    const handle = await createAgentSchedule({
      engine: engine,
      agentName: 'a',
      spec: { every: '1h' },
      input: 'x',
      overlap: 'allow',
    });
    expect(engine.calls).toHaveLength(1);
    expect((engine.calls[0]!.input as ScheduledAgentRunInput).scheduleId).toBe(handle.id);
  });

  it("rejects overlap 'queue' at the chokepoint (before reaching the engine)", async () => {
    const engine = makeSchedulingEngine();
    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'a',
        spec: { every: '1h' },
        input: 'x',
        // A caller coercing an untyped value (e.g. deserialized JSON) past the
        // compiler is exactly what the runtime check must still catch, even
        // though `overlap` is now typed `'skip' | 'allow'`.
        overlap: 'queue' as unknown as 'skip' | 'allow',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidScheduleError);
    expect((caught as Error).message).toContain("overlap policy 'queue' is not supported");
    expect(engine.calls).toHaveLength(0);
  });

  it("rejects overlap 'cancel-running' at the chokepoint (before reaching the engine)", async () => {
    const engine = makeSchedulingEngine();
    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'a',
        spec: { every: '1h' },
        input: 'x',
        overlap: 'cancel-running' as unknown as 'skip' | 'allow',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidScheduleError);
    expect((caught as Error).message).toContain("overlap policy 'cancel-running' is not supported");
    expect(engine.calls).toHaveLength(0);
  });

  it('generates a non-empty schedule id from the default runtime when none is supplied', async () => {
    const engine = makeSchedulingEngine({ scheduleId: 'ignored' });

    const handle = await createAgentSchedule({
      engine: engine,
      agentName: 'a',
      spec: { every: '1h' },
      input: 'x',
    });

    expect(typeof handle.id).toBe('string');
    expect(handle.id.length).toBeGreaterThan(0);
    expect((engine.calls[0]!.input as ScheduledAgentRunInput).scheduleId).toBe(handle.id);
  });

  it('generates a deterministic schedule id from an injected manual runtime (AB-92/AB-253)', async () => {
    const runtime = createManualRuntimeServices();
    const engine = makeSchedulingEngine({ scheduleId: 'ignored' });

    const handleA = await createAgentSchedule({
      engine: engine,
      agentName: 'a',
      spec: { every: '1h' },
      input: 'x',
      runtime,
    });
    const handleB = await createAgentSchedule({
      engine: engine,
      agentName: 'a',
      spec: { every: '1h' },
      input: 'x',
      runtime,
    });

    expect(handleA.id).toBe('schedule-1');
    expect(handleB.id).toBe('schedule-2');
    expect((engine.calls[0]!.input as ScheduledAgentRunInput).scheduleId).toBe(handleA.id);
    expect((engine.calls[1]!.input as ScheduledAgentRunInput).scheduleId).toBe(handleB.id);
  });

  it('returns a handle whose lifecycle methods delegate to the engine', async () => {
    const recorder = { pause: [] as string[], resume: [] as string[], cancel: [] as string[] };
    const engine = makeSchedulingEngine({ handleRecorder: recorder });

    const handle = await createAgentSchedule({
      engine: engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
    });

    await handle.pause();
    await handle.resume();
    await handle.cancel();
    expect(recorder.pause).toContain(handle.id);
    expect(recorder.resume).toContain(handle.id);
    expect(recorder.cancel).toContain(handle.id);

    const summary = await handle.describe();
    expect(summary.id).toBe('test-sched-1');
  });

  it('dispatches SchedulePausedEvent/ScheduleResumedEvent/ScheduleCancelledEvent from a freshly-registered handle when an emitter is supplied (AB-223)', async () => {
    const engine = makeSchedulingEngine();
    const dispatched: Event[] = [];
    const emitter = {
      dispatch: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    };

    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
      emitter,
    });

    await handle.pause();
    await handle.resume();
    await handle.cancel();

    expect(dispatched.map((event) => event.type)).toEqual([
      'schedule.paused',
      'schedule.resumed',
      'schedule.cancelled',
    ]);
    for (const event of dispatched) {
      expect((event as SchedulePausedEvent).scheduleId).toBe(handle.id);
    }
  });

  it('dispatches nothing when no emitter is supplied to a freshly-registered handle', async () => {
    const engine = makeSchedulingEngine();

    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
    });

    // Exercises the emitter?.dispatch(...) no-op branch — must not throw.
    await handle.pause();
    await handle.resume();
    await handle.cancel();
  });

  it('reuses an existing compatible schedule when idempotent registration is requested', async () => {
    const existingSummary: ScheduleSummary = {
      ...mockSummary,
      id: 'schedule-self-run-step',
      intervalMs: 3_600_000,
    };
    const engine = makeSchedulingEngine({ summaries: [existingSummary] });

    const handle = await createAgentSchedule({
      engine: engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
      id: 'schedule-self-run-step',
      idempotent: true,
    });

    expect(engine.calls).toHaveLength(0);
    expect(handle.id).toBe('schedule-self-run-step');
    await handle.pause();
    await handle.resume();
    await handle.cancel();
    const summary = await handle.describe();
    expect(summary.id).toBe('schedule-self-run-step');
  });

  it('dispatches lifecycle events from a reused idempotent handle (scheduleHandleFromEngine) when an emitter is supplied (AB-223)', async () => {
    const existingSummary: ScheduleSummary = {
      ...mockSummary,
      id: 'schedule-self-run-step',
      intervalMs: 3_600_000,
    };
    const engine = makeSchedulingEngine({ summaries: [existingSummary] });
    const dispatched: Event[] = [];
    const emitter = {
      dispatch: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    };

    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
      id: 'schedule-self-run-step',
      idempotent: true,
      emitter,
    });

    await handle.pause();
    await handle.resume();
    await handle.cancel();

    expect(dispatched.map((event) => event.type)).toEqual([
      'schedule.paused',
      'schedule.resumed',
      'schedule.cancelled',
    ]);
  });

  it('uses the trimmed schedule id when reusing an existing idempotent schedule', async () => {
    const existingSummary: ScheduleSummary = {
      ...mockSummary,
      id: 'schedule-self-run-step',
      intervalMs: 3_600_000,
    };
    const engine = makeSchedulingEngine({ summaries: [] });
    const getScheduleCalls: string[] = [];
    engine.getSchedule = async (scheduleId: string) => {
      getScheduleCalls.push(scheduleId);
      return scheduleId === existingSummary.id ? existingSummary : null;
    };

    const handle = await createAgentSchedule({
      engine: engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
      id: '  schedule-self-run-step  ',
      idempotent: true,
    });

    expect(getScheduleCalls).toEqual(['schedule-self-run-step']);
    expect(engine.calls).toHaveLength(0);
    expect(handle.id).toBe('schedule-self-run-step');
  });

  it('idempotent schedule handles throw when the reused schedule disappears before describe', async () => {
    const existingSummary: ScheduleSummary = {
      ...mockSummary,
      id: 'vanishing-schedule',
      intervalMs: 3_600_000,
    };
    const engine = makeSchedulingEngine({ summaries: [existingSummary] });
    let calls = 0;
    engine.getSchedule = async () => {
      calls++;
      return calls === 1 ? existingSummary : null;
    };

    const handle = await createAgentSchedule({
      engine: engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'hello',
      id: 'vanishing-schedule',
      idempotent: true,
    });

    try {
      await handle.describe();
      throw new Error('expected describe to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('vanishing-schedule no longer exists');
    }
  });

  it('treats a duplicate-id schedule race as success when the existing schedule is compatible', async () => {
    const existingSummary: ScheduleSummary = {
      ...mockSummary,
      id: 'schedule-race',
      cronExpression: '0 9 * * *',
    };
    const engine = makeSchedulingEngine({ summaries: [] });
    let getScheduleCalls = 0;
    engine.getSchedule = async () => {
      getScheduleCalls++;
      return getScheduleCalls === 1 ? null : existingSummary;
    };
    engine.schedule = async (
      type: string,
      input: unknown,
      spec: string | ScheduleSpec,
      options?: ScheduleOptions,
    ) => {
      engine.calls.push({ type, input, spec, options });
      throw new Error('Schedule with id "schedule-race" already exists');
    };

    const handle = await createAgentSchedule({
      engine: engine,
      agentName: 'researcher',
      spec: { cron: '0 9 * * *' },
      input: 'hello',
      id: 'schedule-race',
      idempotent: true,
    });

    expect(engine.calls).toHaveLength(1);
    expect(handle.id).toBe('schedule-race');
  });

  it('rejects an existing incompatible schedule when idempotent registration is requested', async () => {
    const engine = makeSchedulingEngine({
      summaries: [{ ...mockSummary, id: 'schedule-collision', workflowType: 'otherWorkflow' }],
    });

    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'researcher',
        spec: { every: '1h' },
        input: 'hello',
        id: 'schedule-collision',
        idempotent: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Schedule schedule-collision already exists for workflow otherWorkflow; expected agentRun.',
    );
    expect(engine.calls).toHaveLength(0);
  });

  it('rejects an existing schedule with a different cron spec when idempotent registration is requested', async () => {
    const engine = makeSchedulingEngine({
      summaries: [
        {
          ...mockSummary,
          id: 'schedule-collision',
          cronExpression: '0 10 * * *',
        },
      ],
    });

    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'researcher',
        spec: { cron: '0 9 * * *' },
        input: 'hello',
        id: 'schedule-collision',
        idempotent: true,
      });
      throw new Error('expected createAgentSchedule to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('different cron spec');
    }
  });

  it('rethrows a duplicate-id schedule race when no existing schedule can be read back', async () => {
    const engine = makeSchedulingEngine({ summaries: [] });
    engine.schedule = async () => {
      throw new Error('Schedule with id "schedule-race" already exists');
    };

    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'researcher',
        spec: { every: '1h' },
        input: 'hello',
        id: 'schedule-race',
        idempotent: true,
      });
      throw new Error('expected createAgentSchedule to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('schedule-race');
    }
  });

  it('rejects an existing cancelled schedule when idempotent registration is requested', async () => {
    const engine = makeSchedulingEngine({
      summaries: [{ ...mockSummary, id: 'schedule-collision', status: 'cancelled' }],
    });

    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'researcher',
        spec: { every: '1h' },
        input: 'hello',
        id: 'schedule-collision',
        idempotent: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Schedule schedule-collision already exists but is cancelled.',
    );
    expect(engine.calls).toHaveLength(0);
  });

  it('rejects an existing schedule with a different interval when idempotent registration is requested', async () => {
    const engine = makeSchedulingEngine({
      summaries: [{ ...mockSummary, id: 'schedule-collision', intervalMs: 1_800_000 }],
    });

    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'researcher',
        spec: { every: '1h' },
        input: 'hello',
        id: 'schedule-collision',
        idempotent: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Schedule schedule-collision already exists with a different interval spec.',
    );
    expect(engine.calls).toHaveLength(0);
  });

  it('rejects an existing schedule with a different overlap policy when idempotent registration is requested', async () => {
    const engine = makeSchedulingEngine({
      summaries: [
        { ...mockSummary, id: 'schedule-collision', intervalMs: 3_600_000, overlap: 'queue' },
      ],
    });

    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'researcher',
        spec: { every: '1h' },
        input: 'hello',
        id: 'schedule-collision',
        idempotent: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Schedule schedule-collision already exists with overlap queue; expected skip.',
    );
    expect(engine.calls).toHaveLength(0);
  });

  it('rejects an existing schedule with a different description when idempotent registration is requested', async () => {
    const engine = makeSchedulingEngine({
      summaries: [
        {
          ...mockSummary,
          id: 'schedule-collision',
          description: 'Existing digest',
          intervalMs: 3_600_000,
        },
      ],
    });

    let caught: unknown;
    try {
      await createAgentSchedule({
        engine: engine,
        agentName: 'researcher',
        spec: { every: '1h' },
        input: 'hello',
        description: 'Requested digest',
        id: 'schedule-collision',
        idempotent: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Schedule schedule-collision already exists with a different description.',
    );
    expect(engine.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createAgentScheduler
// ---------------------------------------------------------------------------

describe('createAgentScheduler', () => {
  it('schedule() registers via the engine (routes through createAgentSchedule)', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine });

    const handle = await scheduler.schedule('researcher', {
      spec: { every: '6h' },
      input: 'Nightly report',
    });

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.type).toBe('agentRun');
    expect((engine.calls[0]!.input as ScheduledAgentRunInput).agentName).toBe('researcher');
    expect((engine.calls[0]!.input as ScheduledAgentRunInput).scheduleId).toBe(handle.id);
  });

  it('threads the constructor-bound emitter into every handle schedule() returns (AB-223)', async () => {
    const engine = makeSchedulingEngine();
    const dispatched: Event[] = [];
    const emitter = {
      dispatch: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    };
    const scheduler = createAgentScheduler({ engine, emitter });

    const handle = await scheduler.schedule('researcher', {
      spec: { every: '6h' },
      input: 'Nightly report',
    });
    await handle.pause();

    expect(dispatched.map((event) => event.type)).toEqual(['schedule.paused']);
  });

  it('schedule() carries agentName and session into the scheduled input', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine });

    await scheduler.schedule('writer', { spec: { every: '1h' }, input: 'hello', session: 's1' });

    expect(engine.calls).toHaveLength(1);
    const input = engine.calls[0]!.input as ScheduledAgentRunInput;
    expect(input.agentName).toBe('writer');
    expect(input.sessionId).toBe('s1');
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

  it('schedule() honors a custom workflowType override', async () => {
    const engine = makeSchedulingEngine();
    const scheduler = createAgentScheduler({ engine, workflowType: 'myRun' });

    await scheduler.schedule('agent', { spec: { every: '1h' }, input: 'x' });

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.type).toBe('myRun');
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

// ---------------------------------------------------------------------------
// AgentScheduleHandle.closed() — AB-210
// ---------------------------------------------------------------------------

describe('AgentScheduleHandle.closed()', () => {
  it('stays pending on an active schedule that has not been cancelled', async () => {
    const engine = makeSchedulingEngine();
    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'poll',
    });

    expect(await stillPending(handle.closed())).toBe(true);
  });

  it('coordinator ruling (2026-09-02): stays pending after a fire completes without cancel()', async () => {
    const engine = makeSchedulingEngine();
    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'poll',
    });

    // Simulate a fire completing — nothing about any individual fire's own
    // lifecycle ever settles the schedule DEFINITION's own closed(); only
    // this handle's own cancel() does.
    await Promise.resolve();
    await Promise.resolve();

    expect(await stillPending(handle.closed())).toBe(true);
  });

  it('resolves { status: "completed" } once this handle\'s own cancel() settles', async () => {
    const engine = makeSchedulingEngine();
    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'poll',
    });

    await handle.cancel();

    expect(await handle.closed()).toEqual({ status: 'completed' });
  });

  it('AC3 — "already canceled": resolves promptly and returns the identical cached object on a repeat call', async () => {
    const engine = makeSchedulingEngine();
    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'poll',
    });
    await handle.cancel();
    await handle.closed();

    // A second call after settlement returns the SAME cached object —
    // createClosedAcknowledgement's shared idempotency guarantee (AB-37/
    // AB-204), reused here rather than reinvented for schedules.
    const first = await handle.closed();
    const second = await handle.closed();
    expect(first).toBe(second);
  });

  it('AC4: does not wait on a separately-tracked in-flight fire — closed() resolves right after cancel() even while a fire dispatched earlier is still running', async () => {
    let fireSettled = false;
    const fireStillRunning = new Promise<void>(() => {
      // Deliberately never resolves during this test — models a fire
      // dispatched before cancel() that is still in flight. This handle's
      // closed() must never await it; it is reachable only through the
      // fire's own AgentRun.closed() (AB-204), not through this handle.
    });
    void fireStillRunning.then(() => {
      fireSettled = true;
    });

    const engine = makeSchedulingEngine();
    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'poll',
    });

    await handle.cancel();
    const acknowledgement = await handle.closed();

    expect(acknowledgement).toEqual({ status: 'completed' });
    expect(fireSettled).toBe(false);
  });

  it('bounds a caller-supplied signal without disturbing the shared cache', async () => {
    const engine = makeSchedulingEngine();
    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'poll',
    });

    const controller = new AbortController();
    const closedPromise = handle.closed({ signal: controller.signal });
    controller.abort();

    expect(await closedPromise).toEqual({ status: 'unresolved', reason: 'timed-out' });

    // The schedule is still uncancelled — a later signal-free call still
    // waits on the real settlement rather than caching the timed-out result.
    await handle.cancel();
    expect(await handle.closed()).toEqual({ status: 'completed' });
  });

  it('the idempotent-reuse handle (scheduleHandleFromEngine) also delivers closed()', async () => {
    const existingSummary: ScheduleSummary = {
      ...mockSummary,
      id: 'schedule-closed-reuse',
      intervalMs: 3_600_000,
    };
    const engine = makeSchedulingEngine({ summaries: [existingSummary] });

    const handle = await createAgentSchedule({
      engine,
      agentName: 'researcher',
      spec: { every: '1h' },
      input: 'poll',
      id: 'schedule-closed-reuse',
      idempotent: true,
    });

    expect(await stillPending(handle.closed())).toBe(true);
    await handle.cancel();
    expect(await handle.closed()).toEqual({ status: 'completed' });
  });
});
