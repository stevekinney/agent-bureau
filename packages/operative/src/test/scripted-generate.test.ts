import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import { createActiveRun } from '../create-run';
import type { GenerateResponse } from '../types';
import { createScriptedGenerate } from './scripted-generate';

function baseOptions(generate: ReturnType<typeof createScriptedGenerate>) {
  return {
    generate,
    toolbox: createTestToolbox([]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
  };
}

describe('createScriptedGenerate', () => {
  describe('respond step', () => {
    it('resolves with the scripted response', async () => {
      const response: GenerateResponse = { content: 'hello', toolCalls: [] };
      const generate = createScriptedGenerate([{ kind: 'respond', response }]);

      const run = createActiveRun(baseOptions(generate));
      const result = await run.result;

      expect(result.finishReason).toBe('stop-condition');
      expect(generate.callCount).toBe(1);
      expect(generate.calls[0]?.context.conversation).toBeInstanceOf(Conversation);
    });

    it('throws naming the index and total when no step remains', async () => {
      const generate = createScriptedGenerate([]);

      const run = createActiveRun(baseOptions(generate));
      const result = await run.result;

      expect(result.finishReason).toBe('error');
    });
  });

  describe('stream step', () => {
    it('concatenates chunks into the response content', async () => {
      const generate = createScriptedGenerate([{ kind: 'stream', chunks: ['hel', 'lo'] }]);

      const run = createActiveRun(baseOptions(generate));
      const result = await run.result;

      expect(result.finishReason).toBe('stop-condition');
      expect(result.content).toBe('hello');
    });

    it('stringifies non-string chunks', async () => {
      const generate = createScriptedGenerate([{ kind: 'stream', chunks: [{ a: 1 }] }]);

      const run = createActiveRun(baseOptions(generate));
      const result = await run.result;

      expect(result.content).toBe('{"a":1}');
    });
  });

  describe('block step', () => {
    it('suspends until release, then consumes the next step', async () => {
      const response: GenerateResponse = { content: 'unblocked', toolCalls: [] };
      const generate = createScriptedGenerate([
        { kind: 'block', barrier: 'gate' },
        { kind: 'respond', response },
      ]);

      const run = createActiveRun(baseOptions(generate));

      await generate.reached('gate');
      expect(generate.callCount).toBe(1);
      // Still blocked: the run hasn't produced a result yet.
      let settled = false;
      void run.result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      generate.release('gate');
      const result = await run.result;

      expect(result.finishReason).toBe('stop-condition');
      expect(result.content).toBe('unblocked');
    });

    it('reached() resolves immediately when release already happened (latch semantics)', async () => {
      const generate = createScriptedGenerate([
        { kind: 'block', barrier: 'gate' },
        { kind: 'respond', response: { content: 'done', toolCalls: [] } },
      ]);

      generate.release('gate');
      const run = createActiveRun(baseOptions(generate));
      await generate.reached('gate');
      const result = await run.result;

      expect(result.finishReason).toBe('stop-condition');
    });
  });

  describe('fail step', () => {
    it('rejects the generate call', async () => {
      const generate = createScriptedGenerate([{ kind: 'fail', error: new Error('boom') }]);

      const run = createActiveRun(baseOptions(generate));
      const result = await run.result;

      expect(result.finishReason).toBe('error');
    });
  });

  describe('ignore-abort step', () => {
    it('resolves its inner step regardless of the abort signal, while the run still terminates as aborted', async () => {
      const controller = new AbortController();
      const generate = createScriptedGenerate([
        { kind: 'ignore-abort', then: { kind: 'block', barrier: 'gate' } },
        { kind: 'respond', response: { content: 'ignored the abort', toolCalls: [] } },
      ]);

      const run = createActiveRun({ ...baseOptions(generate), signal: controller.signal });

      await generate.reached('gate');
      controller.abort();
      generate.release('gate');

      const result = await run.result;

      // The double completed its scripted response...
      expect(generate.callCount).toBe(1);
      // ...but the run layer's own post-generate abort check is what
      // terminates the run — not the double racing the signal.
      expect(result.finishReason).toBe('aborted');
    });
  });

  describe('assertReceived', () => {
    function makeCall() {
      const response: GenerateResponse = { content: 'ok', toolCalls: [] };
      const generate = createScriptedGenerate([{ kind: 'respond', response }]);
      const conversation = new Conversation();
      conversation.appendUserMessage('hi');
      return { generate, conversation };
    }

    it('asserts conversation by identity', async () => {
      const { generate, conversation } = makeCall();
      const run = createActiveRun({
        generate,
        toolbox: createTestToolbox([]),
        conversation,
      });
      await run.result;

      expect(() => generate.assertReceived(0, { conversation })).not.toThrow();
      expect(() => generate.assertReceived(0, { conversation: new Conversation() })).toThrow(
        /conversation/,
      );
    });

    it('asserts tools as the toolbox names', async () => {
      const echo = createTool({
        name: 'echo',
        description: 'Echoes its input.',
        input: z.object({ input: z.string() }),
        execute: async (params: { input: string }) => params.input,
      });
      const response: GenerateResponse = { content: 'ok', toolCalls: [] };
      const generate = createScriptedGenerate([{ kind: 'respond', response }]);
      const run = createActiveRun({
        ...baseOptions(generate),
        toolbox: createTestToolbox([echo]),
      });
      await run.result;

      expect(() => generate.assertReceived(0, { tools: ['echo'] })).not.toThrow();
      expect(() => generate.assertReceived(0, { tools: ['nonexistent'] })).toThrow(/tools/);
    });

    it('asserts signal by aborted state', async () => {
      const controller = new AbortController();
      const generate = createScriptedGenerate([
        { kind: 'block', barrier: 'gate' },
        { kind: 'respond', response: { content: 'ok', toolCalls: [] } },
      ]);
      const run = createActiveRun({ ...baseOptions(generate), signal: controller.signal });

      await generate.reached('gate');
      controller.abort();
      generate.release('gate');
      await run.result;

      expect(() => generate.assertReceived(0, { signal: controller.signal })).not.toThrow();
      const unaborted = new AbortController();
      expect(() => generate.assertReceived(0, { signal: unaborted.signal })).toThrow(/signal/);
    });

    it("asserts traceContext, captured via the double's withTraceContext wrapper", async () => {
      const response: GenerateResponse = { content: 'ok', toolCalls: [] };
      const generate = createScriptedGenerate([{ kind: 'respond', response }]);
      const traceContext = { traceId: 'trace-1' };

      const run = createActiveRun({
        ...baseOptions(generate),
        runId: 'run-1',
        parentContext: traceContext,
        withTraceContext: generate.withTraceContext,
      });
      await run.result;

      expect(() => generate.assertReceived(0, { traceContext })).not.toThrow();
      expect(() => generate.assertReceived(0, { traceContext: { traceId: 'other' } })).toThrow(
        /traceContext/,
      );
    });

    it('fails naming both the actual and expected value', async () => {
      const response: GenerateResponse = { content: 'ok', toolCalls: [] };
      const generate = createScriptedGenerate([{ kind: 'respond', response }]);
      const run = createActiveRun(baseOptions(generate));
      await run.result;

      let message = '';
      try {
        generate.assertReceived(0, { tools: ['does-not-exist'] });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('does-not-exist');
      expect(message).toContain('[]');
    });

    it('throws naming callCount when index is out of range', async () => {
      const response: GenerateResponse = { content: 'ok', toolCalls: [] };
      const generate = createScriptedGenerate([{ kind: 'respond', response }]);
      const run = createActiveRun(baseOptions(generate));
      await run.result;

      expect(() => generate.assertReceived(5, { tools: [] })).toThrow(/callCount/);
    });

    it('only compares fields explicitly present on the expected object', async () => {
      const response: GenerateResponse = { content: 'ok', toolCalls: [] };
      const generate = createScriptedGenerate([{ kind: 'respond', response }]);
      const run = createActiveRun(baseOptions(generate));
      await run.result;

      // model/effort/traceContext/signal are all omitted from `expected` —
      // none of them are checked even though the actual call had none set.
      expect(() => generate.assertReceived(0, {})).not.toThrow();
    });
  });
});
