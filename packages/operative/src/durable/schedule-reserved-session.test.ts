/**
 * COR-851 — a schedule's session id may not sit in a namespace durable goals own.
 *
 * A scheduled fire loads whatever session its schedule names, and an agent can
 * register a schedule itself through the `scheduleSelf` tool, handing an
 * arbitrary session id straight to `AgentScheduler.schedule`. The reservation is
 * therefore enforced where every registration converges, `createAgentSchedule`,
 * and not only on the bureau's public wrapper.
 */
import type { ScheduleOptions, ScheduleSpec, ScheduleSummary } from '@lostgradient/weft';
import { ScheduleHandle } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createScheduleSelfTool } from '../create-schedule-self-tool';
import {
  createAgentScheduler,
  InvalidScheduleError,
  type SchedulingEngine,
} from './schedule-agent';

const summary: ScheduleSummary = {
  id: 'sched-1',
  workflowType: 'agentRun',
  status: 'active',
  overlap: 'skip',
  backfill: false,
  revisionPolicy: 'active-at-fire',
  createdAt: 0,
  updatedAt: 0,
  missedFireCount: 0,
  skippedCount: 0,
  nextFireAt: null,
  queuedRuns: [],
};

function recordingEngine() {
  const registered: Array<{ input: unknown; options?: ScheduleOptions | undefined }> = [];
  const engine: SchedulingEngine = {
    schedule: (_type: string, input: unknown, _spec: string | ScheduleSpec, options) => {
      registered.push({ input, options });
      return Promise.resolve(
        new ScheduleHandle(options?.id ?? 'sched-1', {
          pauseSchedule: () => Promise.resolve(),
          resumeSchedule: () => Promise.resolve(),
          cancelSchedule: () => Promise.resolve(),
          updateSchedule: () => Promise.resolve(),
          getSchedule: () => Promise.resolve(summary),
        }),
      );
    },
    getSchedule: () => Promise.resolve(null),
    listSchedules: () => Promise.resolve({ items: [], total: 0, offset: 0, limit: 100 }),
    pauseSchedule: () => Promise.resolve(),
    resumeSchedule: () => Promise.resolve(),
    cancelSchedule: () => Promise.resolve(),
  };
  return { engine, registered };
}

const RESERVED = [
  'goal-g1-s0',
  'goal-victim-a0',
  'goal:g1',
  'bureau-goal-audit:g1',
  '  goal-g1-s0  ',
];

describe('a schedule session in a namespace durable goals own', () => {
  it.each(RESERVED)('is refused by AgentScheduler.schedule: %p', async (session) => {
    const { engine, registered } = recordingEngine();
    const scheduler = createAgentScheduler({ engine });

    const error = await scheduler
      .schedule('agent', { spec: { every: '1h' }, input: 'x', session })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidScheduleError);
    expect((error as Error).message).toContain('reserved-identifier');
    expect(registered).toEqual([]);
  });

  it.each(RESERVED)(
    'is refused through the scheduleSelf tool an agent calls: %p',
    async (session) => {
      const { engine, registered } = recordingEngine();
      const scheduler = createAgentScheduler({ engine });
      const tool = createScheduleSelfTool({
        agentName: 'agent',
        schedule: scheduler.schedule.bind(scheduler),
      });

      const error = await tool
        .execute({ spec: { every: '1h' }, input: 'x', session })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(InvalidScheduleError);
      expect(registered).toEqual([]);
    },
  );

  it('still accepts a session that only resembles a goal prefix', async () => {
    const { engine, registered } = recordingEngine();
    const scheduler = createAgentScheduler({ engine });

    await scheduler.schedule('agent', { spec: { every: '1h' }, input: 'x', session: 'goalpost' });

    expect(registered).toHaveLength(1);
  });
});
