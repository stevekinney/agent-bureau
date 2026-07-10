import { describe, expect, it } from 'bun:test';
import { CompletableEventTarget } from 'lifecycle';
import { z } from 'zod';

import { createSubagentTool, defaultSubagentSummarizer } from './create-subagent-tool';
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

    it('throws when the sub-agent is aborted', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),

        run: (_input: string, _context: any) =>
          Promise.resolve({
            conversation: {} as any,
            content: '',
            finishReason: 'aborted',
            steps: [],
            usage: { prompt: 0, completion: 0, total: 0 },
          } as any),
      });

      try {
        await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
          topic: 'AI',
        });
        throw new Error('expected sub-agent execution to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('aborted');
      }
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

    it('throws when maximum-steps is treated as an error', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        treatMaximumStepsAsError: true,

        run: (_input: string, _context: any) =>
          Promise.resolve({
            conversation: {} as any,
            content: '',
            finishReason: 'maximum-steps',
            steps: [],
            usage: { prompt: 0, completion: 0, total: 0 },
          } as any),
      });

      try {
        await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
          topic: 'AI',
        });
        throw new Error('expected sub-agent execution to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('maximum steps');
      }
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

  describe('AB-64 — returnMode / summary', () => {
    it('defaults to returnMode "summary"', async () => {
      let receivedMaxTokens: number | undefined;
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun('short result'),
        summarizer: (result, context) => {
          receivedMaxTokens = context.maxTokens;
          return result.content;
        },
      });

      await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
        topic: 'AI',
      });

      // The summarizer is only invoked in 'summary' mode, so its being
      // called at all proves the default is 'summary', not 'full'.
      expect(receivedMaxTokens).toBe(500);
    });

    it('condenses content to the token cap using a mock summarizer', async () => {
      const longContent = 'x'.repeat(10_000);
      let summarizerCalledWith: { content: string; maxTokens: number } | undefined;

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun(longContent),
        summaryTokenCap: 50,
        summarizer: (result, context) => {
          summarizerCalledWith = { content: result.content, maxTokens: context.maxTokens };
          return `[condensed to ${context.maxTokens} tokens]`;
        },
      });

      const result = await (
        tool as unknown as { execute: (p: unknown) => Promise<unknown> }
      ).execute({ topic: 'AI' });

      expect(result).toBe('[condensed to 50 tokens]');
      expect(summarizerCalledWith?.content).toBe(longContent);
      expect(summarizerCalledWith?.maxTokens).toBe(50);
    });

    it('passes the agentName to the summarizer context', async () => {
      let receivedAgentName: string | undefined;

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'topic-researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun('ok'),
        summarizer: (_result, context) => {
          receivedAgentName = context.agentName;
          return 'summarized';
        },
      });

      await (tool as unknown as { execute: (p: unknown) => Promise<unknown> }).execute({
        topic: 'AI',
      });

      expect(receivedAgentName).toBe('topic-researcher');
    });

    it('passes result.content through unmodified when returnMode is "full"', async () => {
      const longContent = 'x'.repeat(10_000);
      let summarizerCalled = false;

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun(longContent),
        returnMode: 'full',
        summaryTokenCap: 10,
        summarizer: () => {
          summarizerCalled = true;
          return 'should not be used';
        },
      });

      const result = await (
        tool as unknown as { execute: (p: unknown) => Promise<unknown> }
      ).execute({ topic: 'AI' });

      expect(result).toBe(longContent);
      expect(summarizerCalled).toBe(false);
    });

    it('applies the default summarizer when content exceeds the token cap', async () => {
      const longContent = 'a'.repeat(1000); // ~250 tokens
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun(longContent),
        summaryTokenCap: 20,
      });

      const result = (await (
        tool as unknown as { execute: (p: unknown) => Promise<unknown> }
      ).execute({ topic: 'AI' })) as string;

      expect(result.length).toBeLessThan(longContent.length);
      expect(result).toContain('truncated');
    });

    it('leaves content untouched via the default summarizer when under the cap', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun('short'),
      });

      const result = await (
        tool as unknown as { execute: (p: unknown) => Promise<unknown> }
      ).execute({ topic: 'AI' });

      expect(result).toBe('short');
    });

    it('mapOutput receives the summarized content, not the raw content', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun('raw content'),
        summarizer: () => 'SUMMARIZED',
        mapOutput: (result) => ({ text: result.content }),
      });

      const result = await (
        tool as unknown as { execute: (p: unknown) => Promise<unknown> }
      ).execute({ topic: 'AI' });

      expect(result).toEqual({ text: 'SUMMARIZED' });
    });

    it('passes the tool call abort signal through to the summarizer context', async () => {
      const controller = new AbortController();
      let observedSignal: AbortSignal | undefined;

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun('raw content'),
        summarizer: (_result, context) => {
          observedSignal = context.signal;
          return 'SUMMARIZED';
        },
      });

      await (
        tool as unknown as {
          execute: (p: unknown, o?: { signal?: AbortSignal }) => Promise<unknown>;
        }
      ).execute({ topic: 'AI' }, { signal: controller.signal });

      expect(observedSignal).toBe(controller.signal);
    });

    it('does not invoke the summarizer once the signal has been aborted', async () => {
      const controller = new AbortController();
      let summarizerCalled = false;

      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        // Aborts the parent run's signal as a side effect of the sub-agent
        // finishing — simulates the parent cancelling right as the child
        // run completes, before summarization would otherwise start.
        run: async (_input, _context) => {
          await Promise.resolve();
          controller.abort();
          return {
            conversation: {} as any,
            content: 'raw content',
            finishReason: 'end-turn',
            steps: [],
            usage: { prompt: 1, completion: 1, total: 2 },
          } as any;
        },
        summarizer: () => {
          summarizerCalled = true;
          return 'SUMMARIZED';
        },
      });

      try {
        await (
          tool as unknown as {
            execute: (p: unknown, o?: { signal?: AbortSignal }) => Promise<unknown>;
          }
        ).execute({ topic: 'AI' }, { signal: controller.signal });
      } catch {
        // Expected: the tool call rejects because the signal aborted.
      }

      expect(summarizerCalled).toBe(false);
    });
  });

  describe('defaultSubagentSummarizer', () => {
    it('returns content unchanged when within the token cap', () => {
      const result = defaultSubagentSummarizer(
        {
          conversation: {} as any,
          content: 'hello world',
          finishReason: 'stop-condition',
          steps: [],
          usage: { prompt: 0, completion: 0, total: 0 },
        } as any,
        { agentName: 'a', maxTokens: 500 },
      );
      expect(result).toBe('hello world');
    });

    it('truncates and annotates content exceeding the token cap', () => {
      const content = 'y'.repeat(400); // ~100 tokens
      const result = defaultSubagentSummarizer(
        {
          conversation: {} as any,
          content,
          finishReason: 'stop-condition',
          steps: [],
          usage: { prompt: 0, completion: 0, total: 0 },
        } as any,
        { agentName: 'a', maxTokens: 50 },
      ) as string;

      expect(result.startsWith('y'.repeat(30))).toBe(true);
      expect(result).toContain('truncated to fit the ~50 token cap');
      // The cap includes the marker itself — never exceeds maxTokens * 4 chars.
      expect(result.length).toBeLessThanOrEqual(200);
    });

    it('never exceeds the token cap even when the marker alone would overflow it', () => {
      const content = 'z'.repeat(1000);
      const result = defaultSubagentSummarizer(
        {
          conversation: {} as any,
          content,
          finishReason: 'stop-condition',
          steps: [],
          usage: { prompt: 0, completion: 0, total: 0 },
        } as any,
        { agentName: 'a', maxTokens: 2 },
      ) as string;

      expect(result.length).toBeLessThanOrEqual(8);
    });
  });

  describe('AB-64 — summarizer output is hard-capped regardless of what it returns', () => {
    it('truncates a custom summarizer that ignores maxTokens entirely', async () => {
      const oversizedSummary = 'w'.repeat(5000);
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun('some content'),
        summaryTokenCap: 25, // 100-char budget
        summarizer: () => oversizedSummary,
      });

      const result = (await (
        tool as unknown as { execute: (p: unknown) => Promise<unknown> }
      ).execute({ topic: 'AI' })) as string;

      expect(result.length).toBeLessThanOrEqual(100);
      expect(result.length).toBeLessThan(oversizedSummary.length);
    });

    it('returns an empty string when summaryTokenCap is 0', async () => {
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        run: makeSuccessfulRun('some content'),
        summaryTokenCap: 0,
      });

      const result = await (
        tool as unknown as { execute: (p: unknown) => Promise<unknown> }
      ).execute({ topic: 'AI' });

      expect(result).toBe('');
    });
  });
});
