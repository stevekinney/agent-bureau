import { createTool, createToolbox, createToolCall } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { ScheduleWakeupContext } from './create-schedule-wakeup-tool';
import { createScheduleWakeupTool } from './create-schedule-wakeup-tool';
import { DurableCapabilityUnavailableError } from './durable/durable-capability-unavailable-error';

describe('createScheduleWakeupTool', () => {
  function makeContext(durable = true): ScheduleWakeupContext {
    return { pendingWakeup: undefined, durable };
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

  describe('input schema', () => {
    it('exposes an input Zod schema so armorer does not strip arguments', () => {
      const context = makeContext();
      const tool = createScheduleWakeupTool({ context });

      // The tool MUST have an `input` schema. Without it, armorer's
      // normalizeSchema(undefined) returns z.object({}) which strips every
      // field before execute() is called (Zod strips unknown keys by default).
      expect(tool.input).toBeDefined();
    });

    it('input schema preserves in and note when parsed', () => {
      const context = makeContext();
      const tool = createScheduleWakeupTool({ context });

      const parsed = tool.input.parse({ in: '6h', note: 'Check the deploy' });

      // Both fields must survive schema parsing — no stripping.
      expect(parsed.in).toBe('6h');
      expect(parsed.note).toBe('Check the deploy');
    });

    it('input schema accepts a numeric duration', () => {
      const context = makeContext();
      const tool = createScheduleWakeupTool({ context });

      const parsed = tool.input.parse({ in: 21_600_000 });

      expect(parsed.in).toBe(21_600_000);
    });

    it('input schema treats note as optional', () => {
      const context = makeContext();
      const tool = createScheduleWakeupTool({ context });

      const parsed = tool.input.parse({ in: '6h' });

      expect(parsed.in).toBe('6h');
      expect(parsed.note).toBeUndefined();
    });

    it('input schema rejects calls with no in field', () => {
      const context = makeContext();
      const tool = createScheduleWakeupTool({ context });

      expect(() => tool.input.parse({ note: 'oops' })).toThrow();
    });
  });

  // AB-41 / AB-43 — an unavailable capability rejects with a stable typed
  // error rather than returning a success-shaped no-op.
  describe('when context.durable is false', () => {
    it('throws DurableCapabilityUnavailableError instead of writing pendingWakeup', () => {
      const context = makeContext(false);
      const tool = createScheduleWakeupTool({ context });

      expect(() => tool.execute({ in: '6h' })).toThrow(DurableCapabilityUnavailableError);
      expect(context.pendingWakeup).toBeUndefined();
    });

    it('throws an error satisfying armorer isToolError (code, category, retryable, message)', () => {
      const context = makeContext(false);
      const tool = createScheduleWakeupTool({ context });

      try {
        tool.execute({ in: '6h' });
        throw new Error('expected execute to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(DurableCapabilityUnavailableError);
        const durableError = error as DurableCapabilityUnavailableError;
        expect(durableError.code).toBe('DurableCapabilityUnavailableError');
        expect(durableError.category).toBe('unavailable');
        expect(durableError.retryable).toBe(false);
        expect(durableError.message).toContain('scheduleWakeup');
      }
    });

    it('does not overwrite an existing pendingWakeup slot', () => {
      const context = makeContext(false);
      context.pendingWakeup = { duration: '1h' };
      const tool = createScheduleWakeupTool({ context });

      expect(() => tool.execute({ in: '6h' })).toThrow(DurableCapabilityUnavailableError);
      expect(context.pendingWakeup).toEqual({ duration: '1h' });
    });
  });

  // Configuration 1 of AB-43's four named configurations: a standalone
  // in-memory agent (no Bureau composition) — the tool has no way to be
  // omitted from the toolbox, so it must reject on invocation. Routes the
  // thrown error through armorer's real `createToolbox`/`isToolError` catch
  // to prove the resulting `ToolExecutionResult.error.category` is
  // `'unavailable'`, exactly as AB-41's decision record specifies.
  describe('standalone createAgent toolbox (armorer integration)', () => {
    it('rejects with an unavailable ToolExecutionResult when the standalone toolbox has no durable run', async () => {
      const context = makeContext(false);
      const rawTool = createScheduleWakeupTool({ context });
      const tool = createTool({
        ...rawTool,
        execute: async (input) => await Promise.resolve(rawTool.execute(input)),
      });
      const toolbox = createToolbox([tool]);

      const result = await toolbox.execute(createToolCall(tool.name, { in: '6h' }));

      expect(result.outcome).toBe('error');
      expect(result.error?.code).toBe('DurableCapabilityUnavailableError');
      expect(result.error?.category).toBe('unavailable');
      expect(result.error?.retryable).toBe(false);
    });
  });
});
