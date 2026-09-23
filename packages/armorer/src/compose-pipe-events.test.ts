import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { expectPromiseToReject } from './async-assertion-test-helpers';
import { createTool } from './create-tool';
import { pipe } from './utilities';

const addListener = (tool: any, type: string, fn: (event: any) => void) => {
  tool.addEventListener(type, fn);
};

// Setup test tools
const parseNumber = createTool({
  name: 'parse-number',
  description: 'Parses a string to a number',
  input: z.object({ str: z.string() }),
  execute: async ({ str }) => ({ value: parseInt(str, 10) }),
});

const double = createTool({
  name: 'double',
  description: 'Doubles a number',
  input: z.object({ value: z.number() }),
  execute: async ({ value }) => ({ value: value * 2 }),
});

describe('pipe events', () => {
  describe('events', () => {
    it('emits step-start events', async () => {
      const pipeline = pipe(parseNumber, double);
      const events: any[] = [];

      addListener(pipeline, 'step-start', (e) => {
        events.push(e);
      });
      await pipeline({ str: '5' });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        stepIndex: 0,
        stepName: 'parse-number',
        input: { str: '5' },
      });
      expect(events[1]).toMatchObject({
        stepIndex: 1,
        stepName: 'double',
        input: { value: 5 },
      });
    });

    it('emits step-complete events', async () => {
      const pipeline = pipe(parseNumber, double);
      const events: any[] = [];

      addListener(pipeline, 'step-complete', (e) => {
        events.push(e);
      });
      await pipeline({ str: '5' });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        stepIndex: 0,
        stepName: 'parse-number',
        output: { value: 5 },
      });
      expect(events[1]).toMatchObject({
        stepIndex: 1,
        stepName: 'double',
        output: { value: 10 },
      });
    });

    it('emits step-error event on failure', async () => {
      const failing = createTool({
        name: 'failing',
        description: 'Always fails',
        input: z.object({ value: z.number() }),
        execute: async () => {
          throw new Error('boom');
        },
      });

      const pipeline = pipe(parseNumber, failing);
      const errors: any[] = [];
      addListener(pipeline, 'step-error', (e) => {
        errors.push(e);
      });

      await expectPromiseToReject(pipeline({ str: '5' }), (error) =>
        expect(() => {
          throw error;
        }).toThrow(),
      );

      expect(errors).toHaveLength(1);
      expect(errors[0].stepIndex).toBe(1);
      expect(errors[0].stepName).toBe('failing');
      expect(errors[0].error).toBeInstanceOf(Error);
    });
  });
});
