import type { ScheduleSummary } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { ScheduleSelfFn } from './create-schedule-self-tool';
import { createScheduleSelfTool } from './create-schedule-self-tool';
import type { AgentScheduleHandle } from './durable/schedule-agent';

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
});
