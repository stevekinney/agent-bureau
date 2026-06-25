import { describe, expect, it } from 'bun:test';
import { CompletableEventTarget } from 'lifecycle';
import { z } from 'zod';

import { createSubagentTool } from './create-subagent-tool';
import type { CombinedOperativeEventMap } from './events';
import { ChildWorkflowStartedEvent } from './events';
import type { RunResult } from './types';

describe('createSubagentTool', () => {
  function makeSuccessfulRun(
    content = 'ok',
  ): (
    input: string,
    context: { signal?: AbortSignal; traceContext?: unknown },
  ) => Promise<RunResult> {
    return (_input, _context) =>
      Promise.resolve({
        conversation: {} as any,
        content,
        finishReason: 'end-turn',
        steps: [],
        usage: { prompt: 1, completion: 1, total: 2 },
      } as any);
  }

  function makeEmitter() {
    return new CompletableEventTarget<CombinedOperativeEventMap>();
  }

  describe('basic behavior', () => {
    it('returns the sub-agent result content via mapOutput default', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun('Research result'),
      });

      const result = await (
        tool as unknown as { execute: (p: unknown) => Promise<unknown> }
      ).execute({ topic: 'AI' });
      expect(result).toBe('Research result');
    });

    it('throws when the sub-agent finishes with error', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),

        run: (_input: string, _context: any) =>
          Promise.resolve({
            conversation: {} as any,
            content: '',
            finishReason: 'error',
            steps: [],
            usage: { prompt: 0, completion: 0, total: 0 },
          } as any),
      });

      let caughtError: unknown;
      try {
        await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
          topic: 'AI',
        });
      } catch (error) {
        caughtError = error;
      }
      expect(String(caughtError)).toContain('error');
    });

    it('throws when the sub-agent finishes with budget-exceeded', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),

        run: (_input: string, _context: any) =>
          Promise.resolve({
            conversation: {} as any,
            content: '',
            finishReason: 'budget-exceeded',
            steps: [],
            usage: { prompt: 0, completion: 0, total: 0 },
          } as any),
      });

      let caughtError: unknown;
      try {
        await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
          topic: 'AI',
        });
      } catch (error) {
        caughtError = error;
      }
      expect(String(caughtError)).toContain('budget');
    });

    it('throws when the sub-agent finishes with elicitation-denied', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),

        run: (_input: string, _context: any) =>
          Promise.resolve({
            conversation: {} as any,
            content: '',
            finishReason: 'elicitation-denied',
            steps: [],
            usage: { prompt: 0, completion: 0, total: 0 },
          } as any),
      });

      let caughtError: unknown;
      try {
        await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
          topic: 'AI',
        });
      } catch (error) {
        caughtError = error;
      }
      expect(String(caughtError)).toContain('elicitation');
    });

    it('does not throw when treatMaximumStepsAsError is false', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),

        run: (_input: string, _context: any) =>
          Promise.resolve({
            conversation: {} as any,
            content: 'partial',
            finishReason: 'maximum-steps',
            steps: [],
            usage: { prompt: 0, completion: 0, total: 0 },
          } as any),
        treatMaximumStepsAsError: false,
      });

      const result = await (
        tool as unknown as { execute: (p: unknown) => Promise<unknown> }
      ).execute({ topic: 'AI' });
      expect(result).toBe('partial');
    });
  });

  describe('F1 / C3 — ChildWorkflowStartedEvent emission', () => {
    it('dispatches ChildWorkflowStartedEvent when parentContext is provided', async () => {
      const emitter = makeEmitter();
      const received: ChildWorkflowStartedEvent[] = [];

      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
        received.push(event);
      });

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun(),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-parent-1',
          durable: false,
        },
      });

      await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
        topic: 'AI',
      });

      expect(received).toHaveLength(1);
    });

    it('emits correct parentAgentName, childAgentName, and parentRunId', async () => {
      const emitter = makeEmitter();
      const received: ChildWorkflowStartedEvent[] = [];

      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
        received.push(event);
      });

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agentName: 'researcher',
        input: z.object({ q: z.string() }),
        run: makeSuccessfulRun(),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-parent-42',
          durable: true,
        },
      });

      await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
        q: 'hello',
      });

      const event = received[0];
      expect(event?.parentAgentName).toBe('orchestrator');
      expect(event?.childAgentName).toBe('researcher');
      expect(event?.parentRunId).toBe('run-parent-42');
    });

    it('sets durable:true when parentContext.durable is true', async () => {
      const emitter = makeEmitter();
      let capturedDurable: boolean | undefined;

      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
        capturedDurable = event.durable;
      });

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agentName: 'researcher',
        input: z.object({ q: z.string() }),
        run: makeSuccessfulRun(),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-p',
          durable: true,
        },
      });

      await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
        q: 'hello',
      });

      expect(capturedDurable).toBe(true);
    });

    it('sets durable:false when parentContext.durable is false', async () => {
      const emitter = makeEmitter();
      let capturedDurable: boolean | undefined;

      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
        capturedDurable = event.durable;
      });

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agentName: 'researcher',
        input: z.object({ q: z.string() }),
        run: makeSuccessfulRun(),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-p',
          durable: false,
        },
      });

      await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
        q: 'hello',
      });

      expect(capturedDurable).toBe(false);
    });

    it('includes the mapped input string in the event', async () => {
      const emitter = makeEmitter();
      let capturedInput: string | undefined;

      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
        capturedInput = event.input;
      });

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun(),
        mapInput: (params) => `Research: ${(params as { topic: string }).topic}`,
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-p',
          durable: false,
        },
      });

      await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
        topic: 'quantum',
      });

      expect(capturedInput).toBe('Research: quantum');
    });

    it('does not emit any event when parentContext is not provided', async () => {
      const emitter = makeEmitter();
      const received: ChildWorkflowStartedEvent[] = [];

      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
        received.push(event);
      });

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agentName: 'researcher',
        input: z.object({ q: z.string() }),
        run: makeSuccessfulRun(),
        // No parentContext
      });

      await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
        q: 'hello',
      });

      expect(received).toHaveLength(0);
    });

    it('emits the event BEFORE the child run executes', async () => {
      const emitter = makeEmitter();
      const timeline: string[] = [];

      emitter.addEventListener(ChildWorkflowStartedEvent.type, () => {
        timeline.push('event');
      });

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agentName: 'researcher',
        input: z.object({ q: z.string() }),

        run: async (_input: string, _context: any) => {
          timeline.push('run');

          return {
            conversation: {} as any,
            content: 'done',
            finishReason: 'end-turn',
            steps: [],
            usage: { prompt: 0, completion: 0, total: 0 },
          } as any;
        },
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-p',
          durable: false,
        },
      });

      await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
        q: 'hello',
      });

      expect(timeline).toEqual(['event', 'run']);
    });
  });
});
