import { describe, expect, it } from 'bun:test';
import { Conversation, type ConversationHistory } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';
import { z } from 'zod';

import type {
  AgentInput,
  AgentRun,
  AgentRunContext,
  RunnableAgent,
  SuccessfulRunResult,
} from './agent-run';
import { createAgent } from './create-agent';
import { createSubagentTool, defaultSubagentSummarizer } from './create-subagent-tool';
import { GuardrailTripwireError, SubagentRunError } from './errors';
import type { CombinedOperativeEventMap } from './events';
import { ChildWorkflowStartedEvent } from './events';
import type { GenerateFunction, GenerateResponse, RunResult } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A single recorded `run()` invocation on a mock `RunnableAgent`. */
interface RecordedRunCall {
  input: AgentInput;
  context: AgentRunContext | undefined;
}

/**
 * A `RunnableAgent` test double that records every `run()` call and hands
 * back a caller-supplied `RunResult` (or a fresh error per call, via
 * `resultFactory`). Never a real agent loop — just enough surface for
 * `createSubagentTool` to drive.
 */
function makeMockAgent<O = never, H extends boolean = false>(
  resultFactory: (call: RecordedRunCall) => RunResult<O, H>,
): { agent: RunnableAgent<O, H>; calls: RecordedRunCall[] } {
  const calls: RecordedRunCall[] = [];
  const agent: RunnableAgent<O, H> = {
    run(input, context): AgentRun<O, H> {
      const call: RecordedRunCall = { input, context };
      calls.push(call);
      const resultPromise = Promise.resolve().then(() => resultFactory(call));
      // `AgentRun<O, H>`'s `OutputMethod<O, H>` branch is a conditional
      // type deferred on this function's own `H`, so a plain object literal
      // never structurally "sufficiently overlaps" it for a direct `as`
      // cast — hence the `as unknown as` step. This test double
      // deliberately omits `.output()` for every `H`; no test here exercises
      // a schema-backed mock agent's `.output()` (the schema-backed
      // integration tests below use a real `createAgent` instead).
      return {
        result: () => resultPromise,
        unwrap: () => resultPromise.then((result) => result.content as never),
        abort: () => {},
        [Symbol.dispose]: () => {},
        [Symbol.asyncIterator]: () => (async function* () {})(),
      } as unknown as AgentRun<O, H>;
    },
  };
  return { agent, calls };
}

function makeSuccessfulResult(content = 'ok'): SuccessfulRunResult {
  return {
    conversation: {} as never,
    content,
    finishReason: 'stop-condition',
    steps: [],
    usage: { prompt: 1, completion: 1, total: 2 },
  };
}

function makeEmitter() {
  return new CompletableEventTarget<CombinedOperativeEventMap>();
}

/**
 * Invokes a `createSubagentTool` result's raw, unwrapped `execute` function
 * directly — bypassing armorer's convenience `tool.execute(params)`
 * overload, which flattens any thrown error to a plain `Error` carrying
 * only the original error's stringified message (see
 * `packages/armorer/src/create-tool.ts`'s `executeParams`). Tests that
 * assert `SubagentRunError` identity, or an exact `AbortSignal` reference,
 * need this raw path; tests that only check a resolved return value or a
 * message substring can use either.
 */
function callRaw(
  tool: unknown,
  params: unknown,
  context: { signal?: AbortSignal; traceContext?: unknown } = {},
): Promise<unknown> {
  return (tool as { rawExecute: (p: unknown, c: unknown) => Promise<unknown> }).rawExecute(
    params,
    context,
  );
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

/** A real `createAgent` child that replies once with fixed text. */
function singleResponseGenerate(content: string): GenerateFunction {
  return async () => textResponse(content);
}

describe('createSubagentTool', () => {
  describe('basic behavior', () => {
    it('returns the sub-agent content via the default toToolOutput', async () => {
      const { agent } = makeMockAgent(() => makeSuccessfulResult('Research result'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
      });

      const result = await callRaw(tool, { topic: 'AI' });
      expect(result).toBe('Research result');
    });

    it('a schema-less child (no toToolOutput) returns a string', async () => {
      const { agent } = makeMockAgent(() => makeSuccessfulResult('plain text'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
      });

      const result = await callRaw(tool, { topic: 'AI' });
      expect(typeof result).toBe('string');
    });

    it.each([
      ['error', 'error'],
      ['aborted', 'aborted'],
      ['budget-exceeded', 'budget-exceeded'],
      ['elicitation-denied', 'elicitation-denied'],
      ['maximum-steps', 'maximum-steps'],
    ] as const)(
      'rejects with SubagentRunError carrying .result for finishReason %s',
      async (finishReason) => {
        const { agent } = makeMockAgent((): RunResult => ({
          conversation: {} as never,
          content: '',
          finishReason,
          steps: [],
          usage: { prompt: 0, completion: 0, total: 0 },
        }));
        const tool = createSubagentTool({
          name: 'researcher',
          description: 'Research a topic',
          agent,
          agentName: 'researcher',
          input: z.object({ topic: z.string() }),
        });

        let caughtError: unknown;
        try {
          await callRaw(tool, {
            topic: 'AI',
          });
        } catch (error) {
          caughtError = error;
        }

        expect(caughtError).toBeInstanceOf(SubagentRunError);
        const error = caughtError as SubagentRunError;
        expect(error.agentName).toBe('researcher');
        expect(error.result.finishReason).toBe(finishReason);
      },
    );

    it('names the guardrail via .result.error when the sub-agent finishes on a tripwire', async () => {
      const tripwireError = new GuardrailTripwireError('Prompt injection detected', {
        guardrailName: 'prompt-injection',
        category: 'prompt-injection',
        phase: 'input',
        confidence: 1,
      });
      const { agent } = makeMockAgent((): RunResult => ({
        conversation: {} as never,
        content: '',
        finishReason: 'tripwire',
        steps: [],
        usage: { prompt: 0, completion: 0, total: 0 },
        error: tripwireError,
      }));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
      });

      let caughtError: unknown;
      try {
        await callRaw(tool, {
          topic: 'AI',
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(SubagentRunError);
      const error = caughtError as SubagentRunError;
      expect(error.result.error).toBe(tripwireError);
      expect((error.result.error as GuardrailTripwireError).guardrailName).toBe('prompt-injection');
    });

    it('rejects with SubagentRunError when a clean stop fails schema validation (invalid output)', async () => {
      const validationError = new Error('output failed schema validation');
      const { agent } = makeMockAgent((): RunResult => ({
        conversation: {} as never,
        content: 'not json',
        finishReason: 'stop-condition',
        steps: [],
        usage: { prompt: 0, completion: 0, total: 0 },
        schemaValidation: { success: false, error: validationError },
      }));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
      });

      let caughtError: unknown;
      try {
        await callRaw(tool, {
          topic: 'AI',
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(SubagentRunError);
      const error = caughtError as SubagentRunError;
      expect(error.result.schemaValidation?.success).toBe(false);
      // The message names the actual failure ("invalid-output"), not the
      // misleading raw finishReason ("stop-condition") — and the cause
      // falls back to the schema-validation error when result.error is unset.
      expect(error.message).toContain('invalid-output');
      expect(error.message).not.toContain('stop-condition');
      expect(error.cause).toBe(validationError);
    });

    it('no longer accepts treatMaximumStepsAsError — maximum-steps always rejects', async () => {
      const { agent } = makeMockAgent((): RunResult => ({
        conversation: {} as never,
        content: 'partial',
        finishReason: 'maximum-steps',
        steps: [],
        usage: { prompt: 0, completion: 0, total: 0 },
      }));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        // @ts-expect-error — treatMaximumStepsAsError was removed (AB-19).
        treatMaximumStepsAsError: false,
      });

      let caughtError: unknown;
      try {
        await callRaw(tool, { topic: 'AI' });
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(SubagentRunError);
    });
  });

  describe('AB-19 — agent: RunnableAgent, toAgentInput, agentName propagation', () => {
    it('passes options.agentName (not any name on agent) to agent.run as context.agentName', async () => {
      const { agent, calls } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent,
        agentName: 'child-name',
        input: z.object({ q: z.string() }),
      });

      await callRaw(tool, {
        q: 'hi',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.context?.agentName).toBe('child-name');
    });

    it('uses options.agentName, not the parent agent name, and proves the two are never swapped', async () => {
      const emitter = makeEmitter();
      let observedChildName: string | undefined;
      let observedParentName: string | undefined;
      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
        observedChildName = event.childAgentName;
        observedParentName = event.parentAgentName;
      });

      const { agent, calls } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent,
        agentName: 'the-child',
        input: z.object({ q: z.string() }),
        parentContext: {
          emitter,
          parentAgentName: 'the-parent',
          parentRunId: 'run-1',
          durable: false,
        },
      });

      await callRaw(tool, {
        q: 'hi',
      });

      expect(observedChildName).toBe('the-child');
      expect(observedParentName).toBe('the-parent');
      expect(observedChildName).not.toBe(observedParentName);
      expect(calls[0]?.context?.agentName).toBe('the-child');
    });

    it('toAgentInput receives the parsed tool arguments and its return value reaches agent.run', async () => {
      const { agent, calls } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        toAgentInput: (parsed) => `Research: ${parsed.topic}`,
      });

      await callRaw(tool, {
        topic: 'quantum',
      });

      expect(calls[0]?.input).toBe('Research: quantum');
    });

    it('defaults toAgentInput to String(parsed input)', async () => {
      const { agent, calls } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
      });

      await callRaw(tool, {
        topic: 'quantum',
      });

      // Matches the default `toAgentInput`'s intentional lossy
      // `String(parsed)` fallback — see `create-subagent-tool.ts`.
      expect(calls[0]?.input).toBe('[object Object]');
    });

    it('accepts a conversation-history AgentInput from toAgentInput', async () => {
      const { agent, calls } = makeMockAgent(() => makeSuccessfulResult());
      const history: ConversationHistory = new Conversation().current;
      const tool = createSubagentTool({
        name: 'resumer',
        description: 'Resume a conversation',
        agent,
        agentName: 'resumer',
        input: z.object({ ignored: z.string() }),
        toAgentInput: () => ({ conversation: history }),
      });

      await callRaw(tool, {
        ignored: 'x',
      });

      expect(calls[0]?.input).toEqual({ conversation: history });
    });

    it('propagates signal, traceContext, and withTraceContext to agent.run', async () => {
      const { agent, calls } = makeMockAgent(() => makeSuccessfulResult());
      const controller = new AbortController();
      const withTraceContext = async <T>(_ctx: unknown, fn: () => Promise<T>) => fn();
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent,
        agentName: 'child',
        input: z.object({ q: z.string() }),
        withTraceContext,
      });

      await callRaw(
        tool,
        { q: 'hi' },
        { signal: controller.signal, traceContext: { traceId: 't-1' } },
      );

      expect(calls[0]?.context?.signal).toBe(controller.signal);
      expect(calls[0]?.context?.traceContext).toEqual({ traceId: 't-1' });
      expect(calls[0]?.context?.withTraceContext).toBe(withTraceContext);
    });
  });

  describe('AB-19 — real createAgent as the child (RunnableAgent structural fit)', () => {
    it('runs a real createAgent child from a string input', async () => {
      const child = createAgent({ generate: singleResponseGenerate('hello from child') });
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });

      const result = await callRaw(tool, { q: 'hi' });
      expect(result).toBe('hello from child');
    });

    it('runs a real createAgent child from conversation-history input, following snapshot semantics', async () => {
      const seed = new Conversation();
      seed.appendUserMessage('earlier turn');
      const history = seed.current;
      const seededMessageCount = history.ids.length;

      let observedTurnCount = 0;
      const child = createAgent({
        generate: async ({ conversation }) => {
          observedTurnCount = conversation.current.ids.length;
          return textResponse('resumed');
        },
      });
      const tool = createSubagentTool({
        name: 'resumer',
        description: 'Resume',
        agent: child,
        agentName: 'resumer',
        input: z.object({ ignored: z.string() }),
        toAgentInput: () => ({ conversation: history }),
      });

      const result = await callRaw(tool, { ignored: 'x' });

      expect(result).toBe('resumed');
      // `createAgent`'s `{ conversation }` form resumes the supplied history
      // as-is (no re-appended instructions/user turn) — the child's own
      // conversation carries exactly the seeded message count.
      expect(observedTurnCount).toBe(seededMessageCount);

      // Snapshot semantics: the run must not have mutated the caller's
      // history object — it's still exactly the seeded message count.
      expect(history.ids.length).toBe(seededMessageCount);
    });

    it("a real createAgent child's abort signal fires when the parent tool call's signal aborts", async () => {
      const controller = new AbortController();
      let sawAbort = false;
      let resolveStarted: () => void;
      // Signals that `generate` has actually been called and registered its
      // abort listener — `createActiveRun`'s loop starts on a later
      // microtask than `agent.run()`'s synchronous return, so aborting
      // immediately (with no synchronization) can beat the run to its first
      // `generate` call, which would make the run short-circuit as already
      // aborted without ever invoking `generate` at all.
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const child = createAgent({
        generate: (context) => {
          resolveStarted();
          return new Promise((_resolve, reject) => {
            context.signal?.addEventListener('abort', () => {
              sawAbort = true;
              reject(new Error('aborted'));
            });
          });
        },
      });
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });

      const executePromise = callRaw(tool, { q: 'hi' }, { signal: controller.signal });
      await started;
      controller.abort('parent cancelled');

      let caughtError: unknown;
      try {
        await executePromise;
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(SubagentRunError);
      expect(sawAbort).toBe(true);
    });

    it('a schema-backed real createAgent child exposes output via a sync toToolOutput', async () => {
      const child = createAgent({
        generate: singleResponseGenerate('{"answer":"42"}'),
        output: z.object({ answer: z.string() }),
      });
      const tool = createSubagentTool({
        name: 'answerer',
        description: 'Answers',
        agent: child,
        agentName: 'answerer',
        input: z.object({ q: z.string() }),
        toToolOutput: (result) => result.output?.answer,
      });

      const result = await callRaw(tool, { q: 'what?' });
      expect(result).toBe('42');
    });

    it('supports an asynchronous toToolOutput', async () => {
      const { agent } = makeMockAgent(() => makeSuccessfulResult('raw'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agent,
        agentName: 'researcher',
        input: z.object({ q: z.string() }),
        toToolOutput: async (result) => {
          await Promise.resolve();
          return { text: result.content.toUpperCase() };
        },
      });

      const result = await callRaw(tool, { q: 'hi' });
      expect(result).toEqual({ text: 'RAW' });
    });
  });

  describe('F1 / C3 — ChildWorkflowStartedEvent emission', () => {
    it('dispatches ChildWorkflowStartedEvent when parentContext is provided', async () => {
      const emitter = makeEmitter();
      const received: ChildWorkflowStartedEvent[] = [];
      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => received.push(event));

      const { agent } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-parent-1',
          durable: false,
        },
      });

      await callRaw(tool, {
        topic: 'AI',
      });

      expect(received).toHaveLength(1);
    });

    it('sets durable:true/false from parentContext.durable', async () => {
      for (const durable of [true, false]) {
        const emitter = makeEmitter();
        let capturedDurable: boolean | undefined;
        emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
          capturedDurable = event.durable;
        });

        const { agent } = makeMockAgent(() => makeSuccessfulResult());
        const tool = createSubagentTool({
          name: 'researcher',
          description: 'Research',
          agent,
          agentName: 'researcher',
          input: z.object({ q: z.string() }),
          parentContext: {
            emitter,
            parentAgentName: 'orchestrator',
            parentRunId: 'run-p',
            durable,
          },
        });

        await callRaw(tool, {
          q: 'hello',
        });

        expect(capturedDurable).toBe(durable);
      }
    });

    it('includes the string AgentInput in the event verbatim', async () => {
      const emitter = makeEmitter();
      let capturedInput: string | undefined;
      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
        capturedInput = event.input;
      });

      const { agent } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        toAgentInput: (parsed) => `Research: ${parsed.topic}`,
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-p',
          durable: false,
        },
      });

      await callRaw(tool, {
        topic: 'quantum',
      });

      expect(capturedInput).toBe('Research: quantum');
    });

    it('projects a conversation-history AgentInput to a named, lossy marker in the event', async () => {
      const emitter = makeEmitter();
      let capturedInput: string | undefined;
      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => {
        capturedInput = event.input;
      });

      const { agent } = makeMockAgent(() => makeSuccessfulResult());
      const history: ConversationHistory = new Conversation().current;
      const tool = createSubagentTool({
        name: 'resumer',
        description: 'Resume',
        agent,
        agentName: 'resumer',
        input: z.object({ ignored: z.string() }),
        toAgentInput: () => ({ conversation: history }),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-p',
          durable: false,
        },
      });

      await callRaw(tool, {
        ignored: 'x',
      });

      expect(capturedInput).toBe('[conversation history]');
    });

    it('does not emit any event when parentContext is not provided', async () => {
      const emitter = makeEmitter();
      const received: ChildWorkflowStartedEvent[] = [];
      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => received.push(event));

      const { agent } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agent,
        agentName: 'researcher',
        input: z.object({ q: z.string() }),
      });

      await callRaw(tool, {
        q: 'hello',
      });

      expect(received).toHaveLength(0);
    });

    it('emits the event BEFORE the child run executes', async () => {
      const emitter = makeEmitter();
      const timeline: string[] = [];
      emitter.addEventListener(ChildWorkflowStartedEvent.type, () => timeline.push('event'));

      const { agent } = makeMockAgent(() => {
        timeline.push('run');
        return makeSuccessfulResult('done');
      });
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        agent,
        agentName: 'researcher',
        input: z.object({ q: z.string() }),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'run-p',
          durable: false,
        },
      });

      await callRaw(tool, {
        q: 'hello',
      });

      expect(timeline).toEqual(['event', 'run']);
    });
  });

  describe('AB-64 — returnMode / summary', () => {
    it('defaults to returnMode "summary"', async () => {
      let receivedMaxTokens: number | undefined;
      const { agent } = makeMockAgent(() => makeSuccessfulResult('short result'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        summarizer: (result, context) => {
          receivedMaxTokens = context.maxTokens;
          return result.content;
        },
      });

      await callRaw(tool, {
        topic: 'AI',
      });

      // The summarizer is only invoked in 'summary' mode, so its being
      // called at all proves the default is 'summary', not 'full'.
      expect(receivedMaxTokens).toBe(500);
    });

    it('condenses content to the token cap using a mock summarizer', async () => {
      const longContent = 'x'.repeat(10_000);
      let summarizerCalledWith: { content: string; maxTokens: number } | undefined;

      const { agent } = makeMockAgent(() => makeSuccessfulResult(longContent));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        summaryTokenCap: 50,
        summarizer: (result, context) => {
          summarizerCalledWith = { content: result.content, maxTokens: context.maxTokens };
          return `[condensed to ${context.maxTokens} tokens]`;
        },
      });

      const result = await callRaw(tool, { topic: 'AI' });

      expect(result).toBe('[condensed to 50 tokens]');
      expect(summarizerCalledWith?.content).toBe(longContent);
      expect(summarizerCalledWith?.maxTokens).toBe(50);
    });

    it('passes the agentName to the summarizer context', async () => {
      let receivedAgentName: string | undefined;
      const { agent } = makeMockAgent(() => makeSuccessfulResult('ok'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'topic-researcher',
        input: z.object({ topic: z.string() }),
        summarizer: (_result, context) => {
          receivedAgentName = context.agentName;
          return 'summarized';
        },
      });

      await callRaw(tool, {
        topic: 'AI',
      });

      expect(receivedAgentName).toBe('topic-researcher');
    });

    it('passes the successful result to toToolOutput unmodified when returnMode is "full"', async () => {
      const longContent = 'x'.repeat(10_000);
      let summarizerCalled = false;

      const { agent } = makeMockAgent(() => makeSuccessfulResult(longContent));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        returnMode: 'full',
        summaryTokenCap: 10,
        summarizer: () => {
          summarizerCalled = true;
          return 'should not be used';
        },
      });

      const result = await callRaw(tool, { topic: 'AI' });

      expect(result).toBe(longContent);
      expect(summarizerCalled).toBe(false);
    });

    it('applies the default summarizer when content exceeds the token cap', async () => {
      const longContent = 'a'.repeat(1000); // ~250 tokens
      const { agent } = makeMockAgent(() => makeSuccessfulResult(longContent));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        summaryTokenCap: 20,
      });

      const result = (await callRaw(tool, { topic: 'AI' })) as string;

      expect(result.length).toBeLessThan(longContent.length);
      expect(result).toContain('truncated');
    });

    it('leaves content untouched via the default summarizer when under the cap', async () => {
      const { agent } = makeMockAgent(() => makeSuccessfulResult('short'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
      });

      const result = await callRaw(tool, { topic: 'AI' });

      expect(result).toBe('short');
    });

    it('toToolOutput receives the summarized content, not the raw content', async () => {
      const { agent } = makeMockAgent(() => makeSuccessfulResult('raw content'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        summarizer: () => 'SUMMARIZED',
        toToolOutput: (result) => ({ text: result.content }),
      });

      const result = await callRaw(tool, { topic: 'AI' });

      expect(result).toEqual({ text: 'SUMMARIZED' });
    });

    it('does not abort the settled summarizer execution context', async () => {
      const controller = new AbortController();
      let observedSignal: AbortSignal | undefined;

      const { agent } = makeMockAgent(() => makeSuccessfulResult('raw content'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        summarizer: (_result, context) => {
          observedSignal = context.signal;
          return 'SUMMARIZED';
        },
      });

      // This specific assertion is about armorer's execution-context signal
      // derivation (a fresh, execution-scoped `AbortSignal` distinct from
      // the caller's own controller) — a property of the full toolbox
      // pipeline, not of `createSubagentTool`'s own logic, which merely
      // forwards whatever `context.signal` it is handed. Goes through the
      // ordinary `tool.execute(...)` convenience path (not `callRaw`) so
      // that derivation actually happens.
      await (tool as unknown as { execute: (p: unknown, o?: unknown) => Promise<unknown> }).execute(
        { topic: 'AI' },
        { signal: controller.signal },
      );

      expect(observedSignal).not.toBe(controller.signal);
      expect(observedSignal?.aborted).toBe(false);
      controller.abort('stop summarizer');
      expect(observedSignal?.aborted).toBe(false);
    });

    it('does not invoke the summarizer once the signal has been aborted', async () => {
      const controller = new AbortController();
      let summarizerCalled = false;

      const { agent } = makeMockAgent(() => {
        // Aborts the parent run's signal as a side effect of the sub-agent
        // finishing — simulates the parent cancelling right as the child
        // run completes, before summarization would otherwise start.
        controller.abort();
        return makeSuccessfulResult('raw content');
      });
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        summarizer: () => {
          summarizerCalled = true;
          return 'SUMMARIZED';
        },
      });

      try {
        await callRaw(tool, { topic: 'AI' }, { signal: controller.signal });
      } catch {
        // Expected: the tool call rejects because the signal aborted.
      }

      expect(summarizerCalled).toBe(false);
    });
  });

  describe('defaultSubagentSummarizer', () => {
    it('returns content unchanged when within the token cap', () => {
      const result = defaultSubagentSummarizer(makeSuccessfulResult('hello world'), {
        agentName: 'a',
        maxTokens: 500,
      });
      expect(result).toBe('hello world');
    });

    it('truncates and annotates content exceeding the token cap', () => {
      const content = 'y'.repeat(400); // ~100 tokens
      const result = defaultSubagentSummarizer(makeSuccessfulResult(content), {
        agentName: 'a',
        maxTokens: 50,
      }) as string;

      expect(result.startsWith('y'.repeat(30))).toBe(true);
      expect(result).toContain('truncated to fit the ~50 token cap');
      // The cap includes the marker itself — never exceeds maxTokens * 4 chars.
      expect(result.length).toBeLessThanOrEqual(200);
    });

    it('never exceeds the token cap even when the marker alone would overflow it', () => {
      const content = 'z'.repeat(1000);
      const result = defaultSubagentSummarizer(makeSuccessfulResult(content), {
        agentName: 'a',
        maxTokens: 2,
      }) as string;

      expect(result.length).toBeLessThanOrEqual(8);
    });
  });

  describe('AB-64 — summarizer output is hard-capped regardless of what it returns', () => {
    it('truncates a custom summarizer that ignores maxTokens entirely', async () => {
      const oversizedSummary = 'w'.repeat(5000);
      const { agent } = makeMockAgent(() => makeSuccessfulResult('some content'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        summaryTokenCap: 25, // 100-char budget
        summarizer: () => oversizedSummary,
      });

      const result = (await callRaw(tool, { topic: 'AI' })) as string;

      expect(result.length).toBeLessThanOrEqual(100);
      expect(result.length).toBeLessThan(oversizedSummary.length);
    });

    it('returns an empty string when summaryTokenCap is 0', async () => {
      const { agent } = makeMockAgent(() => makeSuccessfulResult('some content'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        summaryTokenCap: 0,
      });

      const result = await callRaw(tool, { topic: 'AI' });

      expect(result).toBe('');
    });
  });

  describe('AB-19 — full mode passes parts/output/usage/steps/cost/finishReason through untouched', () => {
    it('preserves every RunResultBase field other than content in full mode', async () => {
      const usage = { prompt: 3, completion: 4, total: 7 };
      const steps: RunResult['steps'] = [];
      const { agent } = makeMockAgent((): RunResult => ({
        conversation: {} as never,
        content: 'verbatim',
        finishReason: 'stop-condition',
        steps,
        usage,
        costEstimate: {
          promptCost: 0.01,
          completionCost: 0.02,
          cacheWriteCost: 0,
          cacheReadCost: 0,
          totalCost: 0.03,
          model: 'test-model',
          usage,
        },
      }));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        returnMode: 'full',
        toToolOutput: (result) => result,
      });

      const result = (await callRaw(tool, { topic: 'AI' })) as RunResult;

      expect(result.content).toBe('verbatim');
      expect(result.finishReason).toBe('stop-condition');
      expect(result.usage).toEqual(usage);
      expect(result.steps).toBe(steps);
      expect(result.costEstimate?.totalCost).toBe(0.03);
    });
  });
});
