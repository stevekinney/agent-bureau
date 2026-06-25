import { describe, expect, it } from 'bun:test';

import type { ScheduleWakeupContext } from './create-schedule-wakeup-tool';
import { createScheduleWakeupTool } from './create-schedule-wakeup-tool';

describe('createScheduleWakeupTool', () => {
  function makeContext(): ScheduleWakeupContext {
    return { pendingWakeup: undefined };
  }

  it('writes the duration into context.pendingWakeup', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    tool.execute({ in: '6h' });

    expect(context.pendingWakeup?.duration).toBe('6h');
  });

  it('writes a numeric duration into context.pendingWakeup', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    tool.execute({ in: 21_600_000 });

    expect(context.pendingWakeup?.duration).toBe(21_600_000);
  });

  it('writes the note into context.pendingWakeup when provided', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    tool.execute({ in: '30m', note: 'Check the deploy' });

    expect(context.pendingWakeup?.note).toBe('Check the deploy');
  });

  it('leaves note undefined in context when not provided', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    tool.execute({ in: '1h' });

    expect(context.pendingWakeup?.note).toBeUndefined();
  });

  it('returns scheduled:true with the duration', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    const result = tool.execute({ in: '6h' });

    expect(result.scheduled).toBe(true);
    expect(result.duration).toBe('6h');
  });

  it('returns a human-readable message without a note', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    const result = tool.execute({ in: '6h' });

    expect(result.message).toContain('6h');
    expect(result.message).toContain('Wakeup');
  });

  it('returns a human-readable message that includes the note', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    const result = tool.execute({ in: '30m', note: 'Check the deploy' });

    expect(result.message).toContain('30m');
    expect(result.message).toContain('Check the deploy');
  });

  it('overwrites a previous wakeup when called multiple times (last call wins)', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    tool.execute({ in: '1h', note: 'First' });
    tool.execute({ in: '6h', note: 'Second' });

    expect(context.pendingWakeup?.duration).toBe('6h');
    expect(context.pendingWakeup?.note).toBe('Second');
  });

  it('returns note in result when provided', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    const result = tool.execute({ in: '1h', note: 'My note' });

    expect(result.note).toBe('My note');
  });

  it('does not include note in result when not provided', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    const result = tool.execute({ in: '1h' });

    expect(result.note).toBeUndefined();
  });

  it('has the correct tool name', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    expect(tool.name).toBe('scheduleWakeup');
  });

  it('has a non-empty description', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('formats a numeric duration in the message as milliseconds label', () => {
    const context = makeContext();
    const tool = createScheduleWakeupTool({ context });

    const result = tool.execute({ in: 5000 });

    expect(result.message).toContain('5000ms');
  });
});
