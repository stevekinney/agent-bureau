import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type ConversationHistory } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';
import { z } from 'zod';

import type { AgentRun, SuccessfulRunResult } from './agent-run';
import { attenuateDelegatedAuthority, createChildRunRegistry } from './child-run';
import { createAgent } from './create-agent';
import { createSubagentTool, defaultSubagentSummarizer } from './create-subagent-tool';
import { GuardrailTripwireError, SubagentRunError } from './errors';
import type { CombinedOperativeEventMap } from './events';
import { ChildWorkflowStartedEvent } from './events';
import { createModelCatalog } from './providers/model-catalog.ts';
import type { DelegatedAuthority } from './providers/policy.ts';
import { select } from './providers/selection.ts';
import type { AgentInput, AgentRunContext, RunnableAgent } from './runnable-agent';
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
  // AB-234: defaults to `false`, matching `H`'s own default. A caller
  // exercising the `hasOutput` runtime witness (e.g. a hand-written
  // `RunnableAgent<O, true>` that never actually validates output) passes
  // this explicitly rather than relying on the (compile-time-only) `H`.
  options: { hasOutput?: boolean } = {},
): { agent: RunnableAgent<O, H>; calls: RecordedRunCall[] } {
  const calls: RecordedRunCall[] = [];
  const agent: RunnableAgent<O, H> = {
    name: 'mock-agent',
    hasOutput: options.hasOutput ?? false,
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

/**
 * A `RunnableAgent` test double whose `run()` result never settles until
 * `settle()` is called — needed to assert on a registry entry's `'running'`
 * status before completion (e.g. a cross-run `abortChild` must not settle a
 * still-in-flight sibling).
 */
function makeControllableAgent<O = never, H extends boolean = false>(): {
  agent: RunnableAgent<O, H>;
  calls: RecordedRunCall[];
  settle: (result: RunResult<O, H>) => void;
} {
  const calls: RecordedRunCall[] = [];
  let resolveResult: ((result: RunResult<O, H>) => void) | undefined;
  const resultPromise = new Promise<RunResult<O, H>>((resolve) => {
    resolveResult = resolve;
  });
  const agent: RunnableAgent<O, H> = {
    name: 'controllable-agent',
    hasOutput: false,
    run(input, context): AgentRun<O, H> {
      calls.push({ input, context });
      return {
        result: () => resultPromise,
        unwrap: () => resultPromise.then((result) => result.content as never),
        abort: () => {},
        [Symbol.dispose]: () => {},
        [Symbol.asyncIterator]: () => (async function* () {})(),
      } as unknown as AgentRun<O, H>;
    },
  };
  return {
    agent,
    calls,
    settle: (result) => resolveResult?.(result),
  };
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
  context: {
    signal?: AbortSignal;
    traceContext?: unknown;
    executionContext?: Record<string, unknown>;
  } = {},
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

    it('rejects with SubagentRunError, never invoking toToolOutput, when a schema-backed child structurally claims success but omits output', async () => {
      // A hand-written `RunnableAgent<O, true>` is not obligated to satisfy
      // the internal invariant `run-lifecycle.ts` enforces (`output` is only
      // ever included alongside `finishReason === 'stop-condition' &&
      // schemaValidation?.success`) — nothing stops a third-party
      // implementation from reporting a successful, schema-valid stop while
      // omitting `output` outright. `isSuccessfulRunResult` must reject this
      // at runtime rather than let a structurally-typed but factually absent
      // `output` reach `toToolOutput`.
      const { agent } = makeMockAgent<{ answer: string }, true>(
        () =>
          ({
            conversation: {} as never,
            content: 'ok',
            finishReason: 'stop-condition',
            steps: [],
            usage: { prompt: 0, completion: 0, total: 0 },
            schemaValidation: { success: true },
            // `output` deliberately omitted despite the claimed success.
          }) as unknown as RunResult<{ answer: string }, true>,
      );
      const toToolOutput = (result: SuccessfulRunResult<{ answer: string }, true>) => {
        throw new Error(
          `toToolOutput must not be invoked when output is missing: ${JSON.stringify(result)}`,
        );
      };
      const tool = createSubagentTool<{ topic: string }, { answer: string }, true, string>({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        toToolOutput,
      });

      let caughtError: unknown;
      try {
        await callRaw(tool, { topic: 'AI' });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(SubagentRunError);
      const error = caughtError as SubagentRunError;
      expect(error.result.finishReason).toBe('stop-condition');
      expect((error.result as { output?: unknown }).output).toBeUndefined();
    });

    it('rejects with SubagentRunError when a RunnableAgent<O, true> stub never attaches schemaValidation at all, trusting agent.hasOutput over the structural claim (AB-234)', async () => {
      // Before AB-234, `RunnableAgent`'s `H` was a compile-time-only phantom
      // parameter: a hand-written `RunnableAgent<O, true>` whose `RunResult`
      // never attaches `schemaValidation` (not merely a failed or
      // output-less success — genuinely absent, as a naive third-party
      // implementation that never wires up schema validation at all would
      // produce) fell through `isSuccessfulRunResult`'s
      // `schemaValidation === undefined` branch and narrowed successfully,
      // reaching `toToolOutput` with no validated `output` on the result at
      // all. `agent.hasOutput` (the real runtime witness this issue adds)
      // closes that: `createSubagentTool` now rejects this case instead.
      const { agent } = makeMockAgent<{ answer: string }, true>(
        () =>
          ({
            conversation: {} as never,
            content: 'ok',
            finishReason: 'stop-condition',
            steps: [],
            usage: { prompt: 0, completion: 0, total: 0 },
            // No `schemaValidation` at all — not a failed or output-less
            // success, just entirely absent, as a stub that never validates
            // anything would produce.
          }) as unknown as RunResult<{ answer: string }, true>,
        { hasOutput: true },
      );
      const toToolOutput = (result: SuccessfulRunResult<{ answer: string }, true>) => {
        throw new Error(
          `toToolOutput must not be invoked when the agent's own hasOutput witness is true but no schemaValidation was ever attached: ${JSON.stringify(result)}`,
        );
      };
      const tool = createSubagentTool<{ topic: string }, { answer: string }, true, string>({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        toToolOutput,
      });

      let caughtError: unknown;
      try {
        await callRaw(tool, { topic: 'AI' });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(SubagentRunError);
      const error = caughtError as SubagentRunError;
      expect(error.result.finishReason).toBe('stop-condition');
      expect((error.result as { schemaValidation?: unknown }).schemaValidation).toBeUndefined();
    });

    it('accepts a schema-less RunnableAgent<O, false> whose RunResult never attaches schemaValidation — the ordinary, sound case', async () => {
      // The counterpart to the test above: when `agent.hasOutput` is
      // genuinely `false` (the default `makeMockAgent` witness), a result
      // with no `schemaValidation` at all is the NORMAL, expected shape for
      // a schema-less agent — `toToolOutput` must still be reached, not
      // rejected. AB-234's fix must not regress the untyped/schema-less path.
      const { agent } = makeMockAgent(() => makeSuccessfulResult('plain text result'));
      const tool = createSubagentTool({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
      });

      const result = await callRaw(tool, { topic: 'AI' });

      expect(result).toBe('plain text result');
    });

    it('accepts a validated success whose output key is present but holds undefined (e.g. a void/undefined-shaped schema)', async () => {
      // The presence check added above must key on `'output' in result`, not
      // `result.output !== undefined` — `run-lifecycle.ts` includes the
      // `output` key whenever `finishReason === 'stop-condition' &&
      // schemaValidation?.success`, regardless of what that validated value
      // actually is. A schema whose valid output IS `undefined` (`z.void()`,
      // `z.undefined()`, an optional root) must still reach `toToolOutput`,
      // not be misclassified as "output missing".
      const { agent } = makeMockAgent<undefined, true>(() => ({
        conversation: {} as never,
        content: 'ok',
        finishReason: 'stop-condition',
        steps: [],
        usage: { prompt: 0, completion: 0, total: 0 },
        schemaValidation: { success: true },
        output: undefined,
      }));
      const tool = createSubagentTool<{ topic: string }, undefined, true, string>({
        name: 'researcher',
        description: 'Research a topic',
        agent,
        agentName: 'researcher',
        input: z.object({ topic: z.string() }),
        toToolOutput: (result) => `output was ${String(result.output)}`,
      });

      const result = await callRaw(tool, { topic: 'AI' });

      expect(result).toBe('output was undefined');
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

      // AB-50: `dispatchChildRun` composes the parent tool call's signal
      // with a private per-child `AbortController` (so a child-targeted
      // `abort()` never reaches a sibling) — so `agent.run()` no longer
      // receives `controller.signal` by identity. It still observes the
      // same abort, which is the actual contract: aborting the parent's
      // signal must stop the child.
      const childSignal = calls[0]?.context?.signal;
      expect(childSignal).not.toBe(controller.signal);
      expect(childSignal?.aborted).toBe(false);
      controller.abort('parent cancelled');
      expect(childSignal?.aborted).toBe(true);
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

  describe('AB-19 — SubagentRunError visibility through the real toolbox/agent-loop path', () => {
    it("is thrown with full identity from rawExecute, the boundary this tool's own code controls", async () => {
      const { agent } = makeMockAgent((): RunResult => ({
        conversation: {} as never,
        content: '',
        finishReason: 'error',
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
        await callRaw(tool, { topic: 'AI' });
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(SubagentRunError);
      expect((caughtError as SubagentRunError).result.finishReason).toBe('error');
    });

    it('is normalized to a plain ToolError by armorer once driven through a real toolbox — a pre-existing, package-wide armorer behavior for every thrown tool error, not specific to this one', async () => {
      const { agent } = makeMockAgent((): RunResult => ({
        conversation: {} as never,
        content: '',
        finishReason: 'error',
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
      const toolbox = createToolbox([tool]);

      const [result] = await toolbox.execute([
        { id: 'call-1', name: 'researcher', arguments: { topic: 'AI' } },
      ]);

      expect(result?.outcome).toBe('error');
      // `armorer`'s `executeInner` catch handler (packages/armorer/src/create-tool.ts)
      // reconstructs every thrown tool error into a plain, structured
      // `ToolError` — {code, category, retryable, message} — for the
      // `ToolExecutionResult` an LLM-facing agent loop actually sees. This
      // is systemic across every tool in this codebase, not a gap AB-19
      // introduced or can fix here: `instanceof SubagentRunError` and
      // `.result` are reachable only by a caller that invokes the tool's
      // `rawExecute`/underlying function directly (see the test above),
      // never through this standard toolbox path. Preserving custom error
      // identity through armorer's toolbox pipeline is a separate,
      // package-wide armorer concern.
      expect(result?.error).not.toBeInstanceOf(SubagentRunError);
      expect(result?.error).toMatchObject({ category: expect.any(String) });
    });
  });

  describe('AB-233 — per-execution traceContext and childRegistry/parentRunId', () => {
    it("observes the parent run's traceContext in the ordinary createAgent loop, with no toolbox-construction workaround", async () => {
      const { agent: child, calls } = makeMockAgent(() => makeSuccessfulResult('child result'));
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });

      let generateCalls = 0;
      const parent = createAgent({
        generate: async () => {
          generateCalls++;
          if (generateCalls === 1) {
            return {
              content: '',
              toolCalls: [{ id: 'call-1', name: 'delegate', arguments: { q: 'hi' } }],
            };
          }
          return textResponse('done');
        },
        tools: { delegate: tool },
      });

      const parentTraceContext = { traceId: 'parent-trace' };
      const result = await parent.run('go', { traceContext: parentTraceContext }).result();

      expect(result.finishReason).toBe('stop-condition');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.context?.traceContext).toBe(parentTraceContext);
    });

    it("reads a per-call executionContext.childRegistry over parentContext.registry's construction-time default", async () => {
      const { agent: child } = makeMockAgent(() => makeSuccessfulResult());
      const constructionTimeRegistry = createChildRunRegistry();
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
        parentContext: {
          emitter: makeEmitter(),
          parentAgentName: 'orchestrator',
          parentRunId: 'construction-time-run',
          durable: false,
          registry: constructionTimeRegistry,
        },
      });

      const callTimeRegistry = createChildRunRegistry();
      await callRaw(tool, { q: 'hi' }, { executionContext: { childRegistry: callTimeRegistry } });

      expect(callTimeRegistry.children()).toHaveLength(1);
      expect(constructionTimeRegistry.children()).toHaveLength(0);
    });

    it('falls back to parentContext.registry/parentRunId when the per-call executionContext values do not satisfy the guard', async () => {
      const { agent: child } = makeMockAgent(() => makeSuccessfulResult());
      const constructionTimeRegistry = createChildRunRegistry();
      const emitter = makeEmitter();
      const received: ChildWorkflowStartedEvent[] = [];
      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => received.push(event));

      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'construction-time-run',
          durable: false,
          registry: constructionTimeRegistry,
        },
      });

      // `childRegistry` here is a plain object, not a `MutableChildRunRegistry`
      // (no `register`/`settle`/`children`/`abortChild`), and `parentRunId`
      // is a number, not a string — both fail their respective checks, so
      // `createSubagentTool` falls back to the construction-time defaults.
      await callRaw(
        tool,
        { q: 'hi' },
        {
          executionContext: {
            childRegistry: { notARegistry: true },
            parentRunId: 42,
          },
        },
      );

      expect(constructionTimeRegistry.children()).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(received[0]?.parentRunId).toBe('construction-time-run');
    });

    it('registers two concurrent runs of one reused tool instance into distinct registries, with no cross-run abortChild', async () => {
      // AB-50's reuse gap: a single `createSubagentTool` instance is reused
      // by two different `agent.run()` calls (the ordinary pattern for a
      // tool defined once and shared by every run of an agent). Each run
      // supplies its OWN `childRegistry` per-execution — proving neither
      // run's `abortChild` reaches the other's child.
      const childA = makeControllableAgent();
      const childB = makeControllableAgent();
      const toolA = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: childA.agent,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });
      const toolB = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: childB.agent,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });

      const registryA = createChildRunRegistry();
      const registryB = createChildRunRegistry();

      // Both calls dispatch (and register) synchronously up front — neither
      // agent's `run()` result settles until `.settle()` is called below —
      // so both registrations are visible before either call resolves.
      const pendingA = callRaw(
        toolA,
        { q: 'run-a-call' },
        { executionContext: { childRegistry: registryA } },
      );
      const pendingB = callRaw(
        toolB,
        { q: 'run-b-call' },
        { executionContext: { childRegistry: registryB } },
      );

      // `createTool`'s `rawExecute` resolves the (possibly lazy) execute
      // function through a microtask before invoking it, so registration —
      // synchronous within `dispatchChildRun` once the tool's own `execute`
      // body runs — lands a tick later than the `callRaw(...)` call itself.
      await Promise.resolve();
      await Promise.resolve();

      expect(registryA.children()).toHaveLength(1);
      expect(registryB.children()).toHaveLength(1);
      const childInA = registryA.children()[0];
      const childInB = registryB.children()[0];
      expect(childInA?.id).not.toBe(childInB?.id);

      // Aborting through registry A must never reach the child registered
      // through registry B.
      if (childInB) registryA.abortChild(childInB.id, 'cross-run abort attempt');
      expect(registryB.children()[0]?.status).toBe('running');
      expect(childB.calls[0]?.context?.signal?.aborted).toBe(false);

      childA.settle(makeSuccessfulResult());
      childB.settle(makeSuccessfulResult());
      await Promise.all([pendingA, pendingB]);
    });

    it("reads a per-call executionContext.parentRunId over parentContext.parentRunId's construction-time default", async () => {
      const { agent: child } = makeMockAgent(() => makeSuccessfulResult());
      const emitter = makeEmitter();
      const received: ChildWorkflowStartedEvent[] = [];
      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => received.push(event));

      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          parentRunId: 'construction-time-run',
          durable: false,
        },
      });

      await callRaw(tool, { q: 'hi' }, { executionContext: { parentRunId: 'run-b-actual' } });

      expect(received).toHaveLength(1);
      expect(received[0]?.parentRunId).toBe('run-b-actual');
    });

    it('registers two concurrent createAgent runs of one reused tool instance into their own childRegistry (via AgentRunContext, through the ordinary loop)', async () => {
      // Same reuse gap as above, driven through the real `createAgent`
      // ordinary loop end to end (not `callRaw`): `AgentRunContext.childRegistry`
      // reaches `run-step.ts`'s toolbox execute call site via
      // `RunOptions.childRegistry`, which builds this call's
      // `executionContext.childRegistry` — not from whichever registry
      // happened to be captured on `tool`'s `parentContext` (there is none
      // here) at construction time.
      const { agent: child, calls } = makeMockAgent(() => makeSuccessfulResult('child result'));
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });

      function makeParent() {
        let generateCalls = 0;
        return createAgent({
          generate: async () => {
            generateCalls++;
            if (generateCalls === 1) {
              return {
                content: '',
                toolCalls: [{ id: 'call-1', name: 'delegate', arguments: { q: 'hi' } }],
              };
            }
            return textResponse('done');
          },
          tools: { delegate: tool },
        });
      }

      const registryA = createChildRunRegistry();
      const registryB = createChildRunRegistry();
      const parentA = makeParent();
      const parentB = makeParent();

      // Two concurrent runs of the SAME tool instance, each supplying its
      // own run's childRegistry through `AgentRunContext`.
      await Promise.all([
        parentA.run('go', { childRegistry: registryA }).result(),
        parentB.run('go', { childRegistry: registryB }).result(),
      ]);

      expect(calls).toHaveLength(2);
      expect(registryA.children()).toHaveLength(1);
      expect(registryB.children()).toHaveLength(1);
      expect(registryA.children()[0]?.id).not.toBe(registryB.children()[0]?.id);
    });

    it('AB-214: a bare createAgent().run() with no explicit runId still gives createSubagentTool a per-call parentRunId, via the minted standalone-run id', async () => {
      // Before AB-214, `RunOptions.runId` stayed undefined for a bare
      // `createAgent().run()` with no explicit `runId`/`childRegistry`, so
      // `run-step.ts`'s toolbox execute call site never populated
      // `executionContext.parentRunId` at all — `createSubagentTool` fell
      // all the way back to `parentContext.parentRunId`'s construction-time
      // default. AB-214 mints a process-local id for every in-memory run
      // through the local identifier seam, so this per-call value is now
      // always present, even for the bare case this test exercises.
      const { agent: child } = makeMockAgent(() => makeSuccessfulResult('child result'));
      const emitter = makeEmitter();
      const received: ChildWorkflowStartedEvent[] = [];
      emitter.addEventListener(ChildWorkflowStartedEvent.type, (event) => received.push(event));

      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
        parentContext: {
          emitter,
          parentAgentName: 'orchestrator',
          // A deliberately different construction-time fallback, so the
          // assertion below proves the per-call value won, not this one.
          parentRunId: 'construction-time-fallback',
          durable: false,
        },
      });

      let generateCalls = 0;
      const parent = createAgent({
        generate: async () => {
          generateCalls++;
          if (generateCalls === 1) {
            return {
              content: '',
              toolCalls: [{ id: 'call-1', name: 'delegate', arguments: { q: 'hi' } }],
            };
          }
          return textResponse('done');
        },
        tools: { delegate: tool },
      });

      // Bare — no options at all, so `RunOptions.runId` is absent and
      // `createActiveRun` mints one through the identifier seam.
      const run = parent.run('go');
      await run.result();

      expect(received).toHaveLength(1);
      expect(received[0]?.parentRunId).not.toBe('');
      expect(received[0]?.parentRunId).not.toBe('construction-time-fallback');
      // The minted id is the same one the run's own liveness snapshot
      // reports — one identifier seam, not two independent sources.
      expect(received[0]?.parentRunId).toBe(run.snapshot().id);
    });
  });

  describe('AB-300 — parent delegatedAuthority forwarded into dispatchChildRun', () => {
    const parentGrant: DelegatedAuthority = {
      grantedProviders: ['anthropic', 'gemini'],
      policyVersion: 'ab-300-parent-v1',
    };

    it("forwards the parent run's delegatedAuthority unchanged when the tool has no narrowing of its own", async () => {
      const { agent: child, calls } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });

      await callRaw(tool, { q: 'hi' }, { executionContext: { delegatedAuthority: parentGrant } });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.context?.delegatedAuthority).toBe(parentGrant);
    });

    it("attenuates the parent run's delegatedAuthority with the tool's own narrowing before forwarding", async () => {
      const { agent: child, calls } = makeMockAgent(() => makeSuccessfulResult());
      const toolNarrowing: DelegatedAuthority = {
        grantedProviders: ['anthropic'],
        policyVersion: 'ab-300-tool-v1',
      };
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
        delegatedAuthority: toolNarrowing,
      });

      await callRaw(tool, { q: 'hi' }, { executionContext: { delegatedAuthority: parentGrant } });

      // Proven against the real `attenuateDelegatedAuthority` composition,
      // not a value that happens to coincide with either input.
      expect(calls[0]?.context?.delegatedAuthority).toEqual(
        attenuateDelegatedAuthority(parentGrant, toolNarrowing),
      );
      expect(calls[0]?.context?.delegatedAuthority?.grantedProviders).toEqual(['anthropic']);
    });

    it("forwards the tool's own narrowing unchanged when the parent run carries no grant", async () => {
      const { agent: child, calls } = makeMockAgent(() => makeSuccessfulResult());
      const toolNarrowing: DelegatedAuthority = {
        grantedProviders: ['openai'],
        policyVersion: 'ab-300-tool-only-v1',
      };
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
        delegatedAuthority: toolNarrowing,
      });

      await callRaw(tool, { q: 'hi' }, {});

      expect(calls[0]?.context?.delegatedAuthority).toBe(toolNarrowing);
    });

    it('dispatches with delegatedAuthority left undefined when neither the parent run nor the tool supplies a grant', async () => {
      const { agent: child, calls } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });

      await callRaw(tool, { q: 'hi' }, {});

      expect(calls[0]?.context?.delegatedAuthority).toBeUndefined();
    });

    it('treats a malformed executionContext.delegatedAuthority as absent rather than a valid grant', async () => {
      const malformedValues: unknown[] = [
        'not-an-object',
        null,
        {}, // missing the required policyVersion
        { policyVersion: 42 }, // policyVersion not a string
        { policyVersion: 'v1', grantedProviders: 'anthropic' }, // not an array
        { policyVersion: 'v1', grantedModels: 'claude-fable-5' }, // not an array
        { policyVersion: 'v1', maximumEffort: 3 }, // not a string
      ];

      for (const value of malformedValues) {
        const { agent: child, calls } = makeMockAgent(() => makeSuccessfulResult());
        const tool = createSubagentTool({
          name: 'delegate',
          description: 'Delegate',
          agent: child,
          agentName: 'child',
          input: z.object({ q: z.string() }),
        });

        await callRaw(tool, { q: 'hi' }, { executionContext: { delegatedAuthority: value } });

        expect(calls[0]?.context?.delegatedAuthority).toBeUndefined();
      }
    });

    it('reads the per-call executionContext.delegatedAuthority through the ordinary createAgent loop (AgentRunContext.delegatedAuthority end to end)', async () => {
      const { agent: child, calls } = makeMockAgent(() => makeSuccessfulResult('child result'));
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });

      let generateCalls = 0;
      const parent = createAgent({
        generate: async () => {
          generateCalls++;
          if (generateCalls === 1) {
            return {
              content: '',
              toolCalls: [{ id: 'call-1', name: 'delegate', arguments: { q: 'hi' } }],
            };
          }
          return textResponse('done');
        },
        tools: { delegate: tool },
      });

      await parent.run('go', { delegatedAuthority: parentGrant }).result();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.context?.delegatedAuthority).toEqual(parentGrant);
    });

    it("excludes a child-forbidden candidate from its own planSelection record with 'exceeds-delegated-authority'; a parent with no grant still dispatches with delegatedAuthority undefined", async () => {
      const now = () => '2026-09-03T12:00:00.000Z';
      const catalog = createModelCatalog({ now });
      const anthropic = catalog.descriptors.find(
        (d) => d.provider === 'anthropic' && d.model === 'claude-fable-5',
      );
      const gemini = catalog.descriptors.find(
        (d) => d.provider === 'gemini' && d.model === 'gemini-2.5-pro',
      );
      if (!anthropic || !gemini) {
        throw new Error('fixture descriptor not found in the default model catalog');
      }

      const forbiddingGrant: DelegatedAuthority = {
        grantedProviders: ['anthropic'],
        policyVersion: 'ab-300-forbidding-v1',
      };

      const { agent: child, calls } = makeMockAgent(() => makeSuccessfulResult());
      const tool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: child,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });

      await callRaw(
        tool,
        { q: 'hi' },
        { executionContext: { delegatedAuthority: forbiddingGrant } },
      );
      const forwardedGrant = calls[0]?.context?.delegatedAuthority;
      expect(forwardedGrant).toEqual(forbiddingGrant);

      const plan = select(
        {
          agentName: 'ab-300-child',
          taskClassification: 'ab-300-suite',
          catalogRevision: catalog.revision,
          policyRevision: 1,
          availabilitySnapshotRevision: 1,
        },
        {
          catalog: {
            revision: catalog.revision,
            descriptors: [anthropic, gemini],
            generatedAt: now(),
            stale: false,
            projection: 'privileged',
          },
          delegated: forwardedGrant,
          now,
          newPlanId: () => 'ab-300-plan-0000',
        },
      );

      const geminiCandidate = plan.candidates.find((c) => c.provider === 'gemini');
      expect(geminiCandidate?.eligible).toBe(false);
      expect(geminiCandidate?.exclusionCode).toBe('exceeds-delegated-authority');

      const anthropicCandidate = plan.candidates.find((c) => c.provider === 'anthropic');
      expect(anthropicCandidate?.eligible).toBe(true);
      expect(anthropicCandidate?.exclusionCode).toBeUndefined();

      // A parent with no grant still dispatches with `delegatedAuthority`
      // left undefined — never a fabricated all-permissive grant.
      const { agent: unforbiddenChild, calls: unforbiddenCalls } = makeMockAgent(() =>
        makeSuccessfulResult(),
      );
      const unforbiddenTool = createSubagentTool({
        name: 'delegate',
        description: 'Delegate',
        agent: unforbiddenChild,
        agentName: 'child',
        input: z.object({ q: z.string() }),
      });
      await callRaw(unforbiddenTool, { q: 'hi' }, {});
      expect(unforbiddenCalls[0]?.context?.delegatedAuthority).toBeUndefined();
    });
  });
});
