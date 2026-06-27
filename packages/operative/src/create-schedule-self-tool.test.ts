import type { ScheduleOptions, ScheduleSpec, ScheduleSummary } from '@lostgradient/weft';
import { ScheduleHandle } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { ScheduleSelfFn } from './create-schedule-self-tool';
import { createScheduleSelfTool } from './create-schedule-self-tool';
import type { AgentScheduleHandle, SchedulingEngine } from './durable/schedule-agent';
import { createAgentScheduler } from './durable/schedule-agent';

const mockSummary: ScheduleSummary = {
  id: 'sched-1',
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

function makeHandle(id = 'sched-1'): AgentScheduleHandle {
  return {
    id,
    pause: async () => {},
    resume: async () => {},
    cancel: async () => {},
    describe: async () => mockSummary,
  };
}

type ScheduleSelfOptions = Parameters<ScheduleSelfFn>[1];

describe('createScheduleSelfTool', () => {
  it('calls schedule with the agent name and spec', async () => {
    const calls: Array<{ agentName: string; options: unknown }> = [];
    const schedule: ScheduleSelfFn = async (name, options) => {
      calls.push({ agentName: name, options });
      return makeHandle();
    };
    const tool = createScheduleSelfTool({ agentName: 'researcher', schedule });

    await tool.execute({ spec: { every: '6h' }, input: 'Summarize' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.agentName).toBe('researcher');
  });

  it('passes spec and input to the schedule function', async () => {
    let captured: any = null;
    const schedule: ScheduleSelfFn = async (_, options) => {
      captured = options;
      return makeHandle();
    };
    const tool = createScheduleSelfTool({ agentName: 'writer', schedule });

    await tool.execute({ spec: { cron: '0 9 * * *' }, input: 'Daily brief' });

    expect(captured?.spec).toEqual({ cron: '0 9 * * *' });
    expect(captured?.input).toBe('Daily brief');
  });

  it('passes session id when provided', async () => {
    let captured: any = null;
    const schedule: ScheduleSelfFn = async (_, options) => {
      captured = options;
      return makeHandle();
    };
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    await tool.execute({
      spec: { cron: '0 9 * * *' },
      input: 'Daily',
      session: 'daily-digest',
    });

    expect(captured?.session).toBe('daily-digest');
  });

  it('does not pass session when absent', async () => {
    let captured: any = null;
    const schedule: ScheduleSelfFn = async (_, options) => {
      captured = options;
      return makeHandle();
    };
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    await tool.execute({ spec: { every: '1h' }, input: 'Heartbeat' });

    expect(captured?.session).toBeUndefined();
  });

  it('passes overlap policy when provided', async () => {
    let captured: any = null;
    const schedule: ScheduleSelfFn = async (_, options) => {
      captured = options;
      return makeHandle();
    };
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    await tool.execute({ spec: { every: '1h' }, input: 'test', overlap: 'queue' });

    expect(captured?.overlap).toBe('queue');
  });

  it('passes a deterministic idempotent schedule id when durable operation context is present', async () => {
    let captured: ScheduleSelfOptions | undefined;
    const schedule: ScheduleSelfFn = async (_, options) => {
      captured = options;
      return makeHandle(options.id);
    };
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    await tool.execute(
      { spec: { every: '1h' }, input: 'test' },
      { durableOperationKey: 'schedule-safe:run-1:step-0:tool-0:scheduleSelf' },
    );

    expect(captured?.id).toBe('schedule-self:schedule-safe:run-1:step-0:tool-0:scheduleSelf');
    expect(captured?.idempotent).toBe(true);
  });

  it('preserves no-id behavior when durable operation context is absent', async () => {
    let captured: ScheduleSelfOptions | undefined;
    const schedule: ScheduleSelfFn = async (_, options) => {
      captured = options;
      return makeHandle();
    };
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    await tool.execute({ spec: { every: '1h' }, input: 'test' });

    expect(captured?.id).toBeUndefined();
    expect(captured?.idempotent).toBeUndefined();
  });

  it('uses an explicit schedule id factory when provided', async () => {
    let captured: ScheduleSelfOptions | undefined;
    const schedule: ScheduleSelfFn = async (_, options) => {
      captured = options;
      return makeHandle(options.id);
    };
    const tool = createScheduleSelfTool({
      agentName: 'agent',
      schedule,
      scheduleId: ({ agentName }) => `custom-${agentName}`,
    });

    await tool.execute(
      { spec: { every: '1h' }, input: 'test' },
      { durableOperationKey: 'schedule-safe:ignored' },
    );

    expect(captured?.id).toBe('custom-agent');
    expect(captured?.idempotent).toBe(true);
  });

  it('collapses repeated durable scheduleSelf registration to one stored schedule', async () => {
    const schedules = new Map<string, ScheduleSummary>();
    const engine: SchedulingEngine = {
      async schedule(
        type: string,
        _input: unknown,
        spec: string | ScheduleSpec,
        options?: ScheduleOptions,
      ): Promise<ScheduleHandle> {
        const scheduleId = options?.id ?? `generated-${schedules.size + 1}`;
        if (schedules.has(scheduleId)) {
          throw new Error(`Schedule with id "${scheduleId}" already exists`);
        }
        const requestedSpec = typeof spec === 'string' ? { cron: spec } : spec;
        schedules.set(scheduleId, {
          ...mockSummary,
          id: scheduleId,
          workflowType: type,
          ...('every' in requestedSpec ? { intervalMs: 3_600_000 } : {}),
          ...('cron' in requestedSpec ? { cronExpression: requestedSpec.cron } : {}),
          overlap: options?.overlap ?? 'skip',
        });
        return new ScheduleHandle(scheduleId, {
          pauseSchedule: async () => {},
          resumeSchedule: async () => {},
          cancelSchedule: async () => {},
          updateSchedule: async () => {},
          getSchedule: async () => schedules.get(scheduleId) ?? null,
        });
      },
      async getSchedule(scheduleId: string): Promise<ScheduleSummary | null> {
        return schedules.get(scheduleId) ?? null;
      },
      async listSchedules() {
        const items = [...schedules.values()];
        return { items, total: items.length, offset: 0, limit: 100 };
      },
      async pauseSchedule(): Promise<void> {},
      async resumeSchedule(): Promise<void> {},
      async cancelSchedule(): Promise<void> {},
    };
    const scheduler = createAgentScheduler({ engine });
    const tool = createScheduleSelfTool({
      agentName: 'agent',
      schedule: scheduler.schedule.bind(scheduler),
    });
    const context = { durableOperationKey: 'schedule-safe:run-1:step-0:tool-0:scheduleSelf' };

    await tool.execute({ spec: { every: '1h' }, input: 'test' }, context);
    await tool.execute({ spec: { every: '1h' }, input: 'test' }, context);

    const result = await scheduler.listSchedules();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(
      'schedule-self:schedule-safe:run-1:step-0:tool-0:scheduleSelf',
    );
  });

  it('returns scheduled:true with the schedule id from the handle', async () => {
    const schedule: ScheduleSelfFn = async () => makeHandle('my-schedule-id');
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    const result = await tool.execute({ spec: { every: '6h' }, input: 'hello' });

    expect(result.scheduled).toBe(true);
    expect(result.scheduleId).toBe('my-schedule-id');
  });

  it('returns a message mentioning the cron expression', async () => {
    const schedule: ScheduleSelfFn = async () => makeHandle('sched-99');
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    const result = await tool.execute({
      spec: { cron: '0 9 * * *' },
      input: 'Morning brief',
    });

    expect(result.message).toContain('0 9 * * *');
  });

  it('returns a message mentioning the interval', async () => {
    const schedule: ScheduleSelfFn = async () => makeHandle('sched-42');
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    const result = await tool.execute({ spec: { every: '6h' }, input: 'Poll' });

    expect(result.message).toContain('6h');
  });

  it('mentions the session in the message when provided', async () => {
    const schedule: ScheduleSelfFn = async () => makeHandle();
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    const result = await tool.execute({
      spec: { every: '6h' },
      input: 'Poll',
      session: 'my-session',
    });

    expect(result.message).toContain('my-session');
  });

  it('mentions fresh session in the message when session is absent', async () => {
    const schedule: ScheduleSelfFn = async () => makeHandle();
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    const result = await tool.execute({ spec: { every: '6h' }, input: 'Poll' });

    expect(result.message).toContain('fresh session');
  });

  it('has the correct tool name', () => {
    const tool = createScheduleSelfTool({
      agentName: 'x',
      schedule: async () => makeHandle(),
    });
    expect(tool.name).toBe('scheduleSelf');
  });

  it('has a non-empty description', () => {
    const tool = createScheduleSelfTool({
      agentName: 'x',
      schedule: async () => makeHandle(),
    });
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('propagates errors from the schedule function', async () => {
    const schedule: ScheduleSelfFn = async () => {
      throw new Error('No engine available');
    };
    const tool = createScheduleSelfTool({ agentName: 'agent', schedule });

    let caught: Error | undefined;
    try {
      await tool.execute({ spec: { every: '1h' }, input: 'test' });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe('No engine available');
  });

  describe('input schema', () => {
    it('exposes an input Zod schema so armorer does not strip arguments', () => {
      const tool = createScheduleSelfTool({
        agentName: 'x',
        schedule: async () => makeHandle(),
      });

      // Without an `input` schema, armorer's normalizeSchema(undefined) returns
      // z.object({}) which strips every field — spec, input, session, overlap —
      // before execute() is called, causing undefined-access errors at runtime.
      expect(tool.input).toBeDefined();
    });

    it('input schema preserves spec and input when parsed through cron path', () => {
      const tool = createScheduleSelfTool({
        agentName: 'x',
        schedule: async () => makeHandle(),
      });

      const parsed = tool.input.parse({ spec: { cron: '0 9 * * *' }, input: 'Morning brief' });

      expect(parsed.spec).toEqual({ cron: '0 9 * * *' });
      expect(parsed.input).toBe('Morning brief');
    });

    it('input schema preserves spec and input when parsed through every path', () => {
      const tool = createScheduleSelfTool({
        agentName: 'x',
        schedule: async () => makeHandle(),
      });

      const parsed = tool.input.parse({ spec: { every: '6h' }, input: 'Poll' });

      expect(parsed.spec).toEqual({ every: '6h' });
      expect(parsed.input).toBe('Poll');
    });

    it('input schema preserves session when provided', () => {
      const tool = createScheduleSelfTool({
        agentName: 'x',
        schedule: async () => makeHandle(),
      });

      const parsed = tool.input.parse({
        spec: { every: '1h' },
        input: 'Heartbeat',
        session: 'daily-digest',
      });

      expect(parsed.session).toBe('daily-digest');
    });

    it('input schema treats session as optional', () => {
      const tool = createScheduleSelfTool({
        agentName: 'x',
        schedule: async () => makeHandle(),
      });

      const parsed = tool.input.parse({ spec: { every: '1h' }, input: 'Heartbeat' });

      expect(parsed.session).toBeUndefined();
    });

    it('input schema preserves overlap when provided', () => {
      const tool = createScheduleSelfTool({
        agentName: 'x',
        schedule: async () => makeHandle(),
      });

      const parsed = tool.input.parse({ spec: { every: '1h' }, input: 'test', overlap: 'queue' });

      expect(parsed.overlap).toBe('queue');
    });

    it('input schema treats overlap as optional', () => {
      const tool = createScheduleSelfTool({
        agentName: 'x',
        schedule: async () => makeHandle(),
      });

      const parsed = tool.input.parse({ spec: { every: '1h' }, input: 'test' });

      expect(parsed.overlap).toBeUndefined();
    });

    it('input schema rejects calls with no spec field', () => {
      const tool = createScheduleSelfTool({
        agentName: 'x',
        schedule: async () => makeHandle(),
      });

      expect(() => tool.input.parse({ input: 'Missing spec' })).toThrow();
    });

    it('input schema rejects calls with no input field', () => {
      const tool = createScheduleSelfTool({
        agentName: 'x',
        schedule: async () => makeHandle(),
      });

      expect(() => tool.input.parse({ spec: { every: '1h' } })).toThrow();
    });
  });
});
