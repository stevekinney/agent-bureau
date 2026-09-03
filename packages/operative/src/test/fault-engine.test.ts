import { createTool, createToolbox } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createManualRuntimeServices, HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import { createActiveRun } from '../create-run';
import type { OperativeHookMap } from '../hooks';
import type { GenerateContext, GenerateResponse } from '../types';
import {
  createFaultEngine,
  FAULT_BOUNDARY_EFFECT_KINDS,
  UnsupportedFaultBoundaryError,
} from './fault-engine';
import type { FaultPlan } from './fault-plan';
import { createScriptedGenerate } from './scripted-generate';
import { createScriptedHook } from './scripted-tool';

function baseOptions(
  generate: (context: GenerateContext) => Promise<GenerateResponse>,
  extra: Record<string, unknown> = {},
) {
  return {
    generate,
    toolbox: createTestToolbox([]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
    ...extra,
  };
}

/** A minimal in-memory key/value+query storage double, recording every call it receives. */
function createRecordingStore() {
  const data = new Map<string, unknown>();
  const calls: { verb: string; key?: string }[] = [];
  return {
    calls,
    data,
    async get(key: string): Promise<unknown> {
      calls.push({ verb: 'get', key });
      return data.get(key);
    },
    async set(key: string, value: unknown): Promise<void> {
      calls.push({ verb: 'set', key });
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      calls.push({ verb: 'delete', key });
      data.delete(key);
    },
    async query(predicate: (value: unknown) => boolean): Promise<unknown[]> {
      calls.push({ verb: 'query' });
      return [...data.values()].filter(predicate);
    },
  };
}

function minimalGenerateContext(overrides: Partial<GenerateContext> = {}): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox([]),
    ...overrides,
  };
}

describe('createFaultEngine', () => {
  describe('process-death boundary', () => {
    it('is rejected at construction with UnsupportedFaultBoundaryError naming AB-97', () => {
      const runtime = createManualRuntimeServices();
      const plan: FaultPlan = [
        {
          id: 'crash-1',
          boundary: 'process-death',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: undefined,
        },
      ];

      expect(() => createFaultEngine(plan, runtime)).toThrow(UnsupportedFaultBoundaryError);
      try {
        createFaultEngine(plan, runtime);
        throw new Error('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedFaultBoundaryError);
        expect((error as Error).message).toContain('AB-97');
        expect((error as Error).name).toBe('UnsupportedFaultBoundaryError');
      }
    });
  });

  describe('FAULT_BOUNDARY_EFFECT_KINDS', () => {
    it('names at least one effect kind for every non-process-death boundary', () => {
      const nonProcessDeath = Object.entries(FAULT_BOUNDARY_EFFECT_KINDS).filter(
        ([boundary]) => boundary !== 'process-death',
      );
      for (const [, kinds] of nonProcessDeath) {
        expect(kinds.length).toBeGreaterThan(0);
      }
      expect(FAULT_BOUNDARY_EFFECT_KINDS['process-death']).toEqual([]);
    });
  });

  describe('effect validation', () => {
    it('throws a TypeError when an effect does not match its boundary', () => {
      const runtime = createManualRuntimeServices();
      const engine = createFaultEngine(
        [
          {
            id: 'mismatched',
            boundary: 'after-effect',
            operation: 'generate',
            occurrence: { kind: 'every' },
            // 'block' is a before-work effect, not an after-effect one.
            effect: { kind: 'block', release: Promise.resolve() },
          },
        ],
        runtime,
      );
      const generate = engine.wrapGenerate(async () => ({ content: 'ok', toolCalls: [] }));
      expect(generate(minimalGenerateContext())).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe('before-work: block', () => {
    it('suspends the call until release, then lets it proceed', async () => {
      const runtime = createManualRuntimeServices();
      let reachedCalled = false;
      let resolveRelease!: () => void;
      const release = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      const plan: FaultPlan = [
        {
          id: 'block-1',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: { kind: 'block', release, onReached: () => (reachedCalled = true) },
        },
      ];
      const engine = createFaultEngine(plan, runtime);

      let called = false;
      const generate = engine.wrapGenerate(async () => {
        called = true;
        return { content: 'ok', toolCalls: [] };
      });

      const resultPromise = generate(minimalGenerateContext());
      await Promise.resolve();
      await Promise.resolve();
      expect(reachedCalled).toBe(true);
      expect(called).toBe(false);

      resolveRelease();
      const result = await resultPromise;
      expect(called).toBe(true);
      expect(result.content).toBe('ok');
      expect(engine.fired()).toHaveLength(1);
      expect(engine.fired()[0]?.boundary).toBe('before-work');
    });
  });

  describe('before-work: delay', () => {
    it('resolves only once `advance` crosses the delay, never on a real timer', async () => {
      const runtime = createManualRuntimeServices();
      const plan: FaultPlan = [
        {
          id: 'delay-1',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: { kind: 'delay', milliseconds: 500 },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const generate = engine.wrapGenerate(async () => ({ content: 'ok', toolCalls: [] }));

      let settled = false;
      void generate(minimalGenerateContext()).then(() => (settled = true));

      await runtime.advance(200);
      expect(settled).toBe(false);

      await runtime.advance(300);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(true);
    });
  });

  describe('before-work: reject-before-work', () => {
    it('never calls the underlying function — proved by zero recorded calls', async () => {
      const runtime = createManualRuntimeServices();
      const generateDouble = createScriptedGenerate([
        { kind: 'respond', response: { content: 'x', toolCalls: [] } },
      ]);
      const plan: FaultPlan = [
        {
          id: 'reject-1',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('boom') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapGenerate(generateDouble);

      expect(wrapped(minimalGenerateContext())).rejects.toThrow('boom');
      expect(generateDouble.callCount).toBe(0);
      expect(engine.fired()).toHaveLength(1);
    });
  });

  describe('after-effect: fail-after-effect', () => {
    it('runs the underlying call to completion, then the caller sees a failure', async () => {
      const runtime = createManualRuntimeServices();
      const generateDouble = createScriptedGenerate([
        { kind: 'respond', response: { content: 'x', toolCalls: [] } },
      ]);
      const plan: FaultPlan = [
        {
          id: 'fail-effect-1',
          boundary: 'after-effect',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: { kind: 'fail-after-effect', error: new Error('after-effect boom') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapGenerate(generateDouble);

      expect(wrapped(minimalGenerateContext())).rejects.toThrow('after-effect boom');
      expect(generateDouble.callCount).toBe(1);
    });
  });

  describe('storage: before-commit / after-commit', () => {
    it('fail-before-commit: a computed value exists but no durable write happens', async () => {
      const runtime = createManualRuntimeServices();
      const store = createRecordingStore();
      const plan: FaultPlan = [
        {
          id: 'before-commit-1',
          boundary: 'before-commit',
          operation: 'storage:set',
          occurrence: { kind: 'every' },
          effect: { kind: 'fail-before-commit', error: new Error('no commit') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(store);

      expect(wrapped.set('key-1', 'computed-value')).rejects.toThrow('no commit');
      expect(store.calls).toHaveLength(0);
      expect(store.data.has('key-1')).toBe(false);
    });

    it('fail-after-commit: the durable write happens for real, then the caller sees a failure', async () => {
      const runtime = createManualRuntimeServices();
      const store = createRecordingStore();
      const plan: FaultPlan = [
        {
          id: 'after-commit-1',
          boundary: 'after-commit',
          operation: 'storage:set',
          occurrence: { kind: 'every' },
          effect: { kind: 'fail-after-commit', error: new Error('commit but fail') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(store);

      expect(wrapped.set('key-1', 'real-value')).rejects.toThrow('commit but fail');
      expect(store.calls).toEqual([{ verb: 'set', key: 'key-1' }]);
      expect(store.data.get('key-1')).toBe('real-value');
    });
  });

  describe('storage: stale-read', () => {
    it('returns a superseded value in place of the current one', async () => {
      const runtime = createManualRuntimeServices();
      const store = createRecordingStore();
      store.data.set('key-1', 'fresh');
      const plan: FaultPlan = [
        {
          id: 'stale-1',
          boundary: 'stale-read',
          operation: 'storage:get',
          occurrence: { kind: 'every' },
          effect: { kind: 'stale-read', value: 'superseded' },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(store);

      const result = await wrapped.get('key-1');
      expect(result).toBe('superseded');
      expect(store.calls).toHaveLength(0);
    });
  });

  describe('storage: corrupt-payload', () => {
    it('rewrites a real result so it fails its own schema', async () => {
      const runtime = createManualRuntimeServices();
      const store = createRecordingStore();
      store.data.set('key-1', { valid: true });
      const schema = z.object({ valid: z.boolean() });

      const plan: FaultPlan = [
        {
          id: 'corrupt-1',
          boundary: 'corrupt-payload',
          operation: 'storage:get',
          occurrence: { kind: 'every' },
          effect: { kind: 'corrupt-payload', corrupt: () => ({ valid: 'not-a-boolean' }) },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(store);

      const result = await wrapped.get('key-1');
      expect(store.calls).toEqual([{ verb: 'get', key: 'key-1' }]);
      expect(schema.safeParse(result).success).toBe(false);
    });
  });

  describe('storage: duplicate-delivery', () => {
    it('invokes the underlying call twice — proved by callCount', async () => {
      const runtime = createManualRuntimeServices();
      const store = createRecordingStore();
      const plan: FaultPlan = [
        {
          id: 'duplicate-1',
          boundary: 'duplicate-delivery',
          operation: 'storage:set',
          occurrence: { kind: 'every' },
          effect: { kind: 'duplicate-delivery' },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(store);

      await wrapped.set('key-1', 'value');
      expect(store.calls).toEqual([
        { verb: 'set', key: 'key-1' },
        { verb: 'set', key: 'key-1' },
      ]);
    });
  });

  describe('storage: lost-acknowledgement (drop-acknowledgement)', () => {
    it('commits the write for real, but the acknowledgement never reaches the caller', async () => {
      const runtime = createManualRuntimeServices();
      const store = createRecordingStore();
      const plan: FaultPlan = [
        {
          id: 'drop-ack-1',
          boundary: 'lost-acknowledgement',
          operation: 'storage:set',
          occurrence: { kind: 'every' },
          effect: { kind: 'drop-acknowledgement' },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(store);

      let settled = false;
      void wrapped.set('key-1', 'committed-value').then(
        () => (settled = true),
        () => (settled = true),
      );

      // Give the real underlying call every chance to complete and the
      // caller-facing promise every chance to (wrongly) settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(store.data.get('key-1')).toBe('committed-value');
      expect(settled).toBe(false);
      expect(engine.fired()).toHaveLength(1);
    });

    it('swallows a rejection from the real underlying call rather than letting it become unhandled', async () => {
      const runtime = createManualRuntimeServices();
      const failingStore = {
        async set(_key: string, _value: unknown): Promise<void> {
          throw new Error('the real write itself failed');
        },
      };
      const plan: FaultPlan = [
        {
          id: 'drop-ack-reject',
          boundary: 'lost-acknowledgement',
          operation: 'storage:set',
          occurrence: { kind: 'every' },
          effect: { kind: 'drop-acknowledgement' },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(failingStore);

      let settled = false;
      void wrapped.set('key-1', 'value').then(
        () => (settled = true),
        () => (settled = true),
      );

      // No unhandled-rejection failure and no settlement — the underlying
      // call's rejection is caught and discarded, exactly as a resolution
      // would be, because the caller-facing promise never observes either.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
    });
  });

  describe('ignored-abort', () => {
    it('generate: the wrapped function receives a signal that cannot observe the caller abort', async () => {
      const runtime = createManualRuntimeServices();
      const controller = new AbortController();
      let observedAborted: boolean | undefined;
      const plan: FaultPlan = [
        {
          id: 'ignore-abort-1',
          boundary: 'ignored-abort',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: { kind: 'ignore-abort' },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapGenerate(async (context) => {
        observedAborted = context.signal?.aborted;
        return { content: 'completed anyway', toolCalls: [] };
      });

      controller.abort();
      const result = await wrapped(minimalGenerateContext({ signal: controller.signal }));

      expect(observedAborted).toBe(false);
      expect(result.content).toBe('completed anyway');
    });

    it('tool: the wrapped tool call receives a signal that cannot observe the caller abort', async () => {
      const runtime = createManualRuntimeServices();
      const controller = new AbortController();
      let observedAborted: boolean | undefined;
      const tool = createTool({
        name: 'checks-abort',
        description: 'Records whether its signal was already aborted.',
        input: z.object({}),
        execute: async (_params, context) => {
          observedAborted = context.signal?.aborted;
          return 'completed anyway';
        },
      });
      const toolbox = createToolbox([tool]);
      const plan: FaultPlan = [
        {
          id: 'ignore-abort-tool-1',
          boundary: 'ignored-abort',
          operation: 'tool:checks-abort',
          occurrence: { kind: 'every' },
          effect: { kind: 'ignore-abort' },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapToolbox(toolbox);

      controller.abort();
      const result = await wrapped.execute(
        { id: 'call-1', name: 'checks-abort', arguments: {} },
        { signal: controller.signal },
      );

      expect(observedAborted).toBe(false);
      expect(result.outcome).toBe('success');
      expect(result.result).toBe('completed anyway');
    });
  });

  describe('tool: FaultOperation matches only the named tool', () => {
    it('does not fire against a different tool', async () => {
      const runtime = createManualRuntimeServices();
      const toolA = createTool({
        name: 'tool-a',
        description: 'a',
        input: z.object({}),
        execute: async () => 'a-ok',
      });
      const toolB = createTool({
        name: 'tool-b',
        description: 'b',
        input: z.object({}),
        execute: async () => 'b-ok',
      });
      const toolbox = createToolbox([toolA, toolB]);
      const plan: FaultPlan = [
        {
          id: 'target-a-only',
          boundary: 'before-work',
          operation: 'tool:tool-a',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('a is down') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapToolbox(toolbox);

      expect(wrapped.execute({ id: 'call-a', name: 'tool-a', arguments: {} })).rejects.toThrow(
        'a is down',
      );
      const bResult = await wrapped.execute({ id: 'call-b', name: 'tool-b', arguments: {} });
      expect(bResult.outcome).toBe('success');
      expect(bResult.result).toBe('b-ok');
    });

    it('executes a batch of calls, faulting only the named tool within the batch', async () => {
      const runtime = createManualRuntimeServices();
      const toolA = createTool({
        name: 'tool-a',
        description: 'a',
        input: z.object({}),
        execute: async () => 'a-ok',
      });
      const toolB = createTool({
        name: 'tool-b',
        description: 'b',
        input: z.object({}),
        execute: async () => 'b-ok',
      });
      const toolbox = createToolbox([toolA, toolB]);
      const plan: FaultPlan = [
        {
          id: 'target-a-batch',
          boundary: 'before-work',
          operation: 'tool:tool-a',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('a is down') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapToolbox(toolbox);

      expect(
        wrapped.execute([
          { id: 'call-a', name: 'tool-a', arguments: {} },
          { id: 'call-b', name: 'tool-b', arguments: {} },
        ]),
      ).rejects.toThrow('a is down');
    });
  });

  describe('hooks', () => {
    it('before-model / after-model: faults the manually-dispatched beforeGenerate/afterGenerate path', async () => {
      const runtime = createManualRuntimeServices();
      const hooks = new HookRegistry<OperativeHookMap>();
      const beforeDouble = createScriptedHook('before-model', [
        { kind: 'resolve', value: undefined },
      ]);
      hooks.on(beforeDouble.hookName, beforeDouble);

      const plan: FaultPlan = [
        {
          id: 'before-model-1',
          boundary: 'before-work',
          operation: 'hook:before-model',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('hook down') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrappedHooks = engine.wrapHooks(hooks);

      const generate = createScriptedGenerate([
        { kind: 'respond', response: { content: 'ok', toolCalls: [] } },
      ]);
      const run = createActiveRun(baseOptions(generate, { hooks: wrappedHooks, runtime }));
      const result = await run.result;

      expect(result.finishReason).toBe('error');
      expect(beforeDouble.callCount).toBe(0);
      expect(generate.callCount).toBe(0);
      expect(engine.fired()).toHaveLength(1);
    });

    it('before-tool / after-tool: faults the run()-dispatched beforeToolExecution/afterToolExecution path', async () => {
      const runtime = createManualRuntimeServices();
      const hooks = new HookRegistry<OperativeHookMap>();
      const afterToolDouble = createScriptedHook('after-tool', [
        { kind: 'resolve', value: undefined },
      ]);
      hooks.on(afterToolDouble.hookName, afterToolDouble);

      const plan: FaultPlan = [
        {
          id: 'after-tool-1',
          boundary: 'after-effect',
          operation: 'hook:after-tool',
          occurrence: { kind: 'every' },
          effect: { kind: 'fail-after-effect', error: new Error('after-tool hook boom') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrappedHooks = engine.wrapHooks(hooks);

      const echoTool = createTool({
        name: 'echo',
        description: 'echoes',
        input: z.object({}).catchall(z.unknown()),
        execute: async () => 'echoed',
      });
      const toolbox = createToolbox([echoTool]);
      const generate = createScriptedGenerate([
        {
          kind: 'respond',
          response: { content: '', toolCalls: [{ id: 'call-1', name: 'echo', arguments: {} }] },
        },
        { kind: 'respond', response: { content: 'done', toolCalls: [] } },
      ]);
      const run = createActiveRun(baseOptions(generate, { hooks: wrappedHooks, runtime, toolbox }));
      await run.result;

      expect(afterToolDouble.callCount).toBe(1);
      expect(engine.fired()).toHaveLength(1);
      expect(engine.fired()[0]?.boundary).toBe('after-effect');
    });

    it('does not fire against a different hook phase', async () => {
      const runtime = createManualRuntimeServices();
      const hooks = new HookRegistry<OperativeHookMap>();
      const beforeDouble = createScriptedHook('before-model', [
        { kind: 'resolve', value: undefined },
      ]);
      hooks.on(beforeDouble.hookName, beforeDouble);

      const plan: FaultPlan = [
        {
          id: 'target-after-tool-only',
          boundary: 'before-work',
          operation: 'hook:after-tool',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('never matches') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrappedHooks = engine.wrapHooks(hooks);
      const generate = createScriptedGenerate([
        { kind: 'respond', response: { content: 'ok', toolCalls: [] } },
      ]);
      const run = createActiveRun(baseOptions(generate, { hooks: wrappedHooks, runtime }));
      const result = await run.result;

      expect(result.finishReason).toBe('stop-condition');
      expect(beforeDouble.callCount).toBe(1);
      expect(engine.fired()).toHaveLength(0);
    });
  });

  describe('storage: FaultOperation matches only the named verb', () => {
    it('a get-only fault never fires against set', async () => {
      const runtime = createManualRuntimeServices();
      const store = createRecordingStore();
      const plan: FaultPlan = [
        {
          id: 'get-only',
          boundary: 'before-work',
          operation: 'storage:get',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('get is down') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(store);

      await wrapped.set('key-1', 'value');
      expect(store.data.get('key-1')).toBe('value');
      expect(wrapped.get('key-1')).rejects.toThrow('get is down');
    });
  });

  describe('occurrence: nth', () => {
    it('fires only on the nth matching call, never the others', async () => {
      const runtime = createManualRuntimeServices();
      const plan: FaultPlan = [
        {
          id: 'nth-2',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'nth', n: 2 },
          effect: { kind: 'reject-before-work', error: new Error('second call fails') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const generate = engine.wrapGenerate(async () => ({ content: 'ok', toolCalls: [] }));

      expect(generate(minimalGenerateContext())).resolves.toEqual({ content: 'ok', toolCalls: [] });
      expect(generate(minimalGenerateContext())).rejects.toThrow('second call fails');
      expect(generate(minimalGenerateContext())).resolves.toEqual({ content: 'ok', toolCalls: [] });
      expect(engine.fired()).toHaveLength(1);
      expect(engine.fired()[0]?.occurrence).toBe(2);
    });
  });

  describe('occurrence: every', () => {
    it('fires on every matching call', async () => {
      const runtime = createManualRuntimeServices();
      const plan: FaultPlan = [
        {
          id: 'every-1',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('always fails') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const generate = engine.wrapGenerate(async () => ({ content: 'ok', toolCalls: [] }));

      expect(generate(minimalGenerateContext())).rejects.toThrow('always fails');
      expect(generate(minimalGenerateContext())).rejects.toThrow('always fails');
      expect(generate(minimalGenerateContext())).rejects.toThrow('always fails');
      expect(engine.fired()).toHaveLength(3);
      expect(engine.fired().map((f) => f.occurrence)).toEqual([1, 2, 3]);
    });
  });

  describe('occurrence: after-sequence', () => {
    it('fires once RuntimeServices.deferred has observed that many settlements, not before', async () => {
      const runtime = createManualRuntimeServices();
      const plan: FaultPlan = [
        {
          id: 'after-seq-2',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'after-sequence', sequence: 2 },
          effect: { kind: 'reject-before-work', error: new Error('fires after two settlements') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const generate = engine.wrapGenerate(async () => ({ content: 'ok', toolCalls: [] }));

      // Nothing tracked yet — the fault must not fire.
      expect(generate(minimalGenerateContext())).resolves.toEqual({ content: 'ok', toolCalls: [] });
      expect(engine.fired()).toHaveLength(0);

      // Track and settle two deferred promises.
      runtime.deferred.track(Promise.resolve('a'), 'label-a');
      runtime.deferred.track(Promise.resolve('b'), 'label-b');
      await Promise.resolve();
      await Promise.resolve();

      let secondCallError: unknown;
      await generate(minimalGenerateContext()).catch((error: unknown) => {
        secondCallError = error;
      });
      expect(secondCallError).toBeInstanceOf(Error);
      expect((secondCallError as Error).message).toBe('fires after two settlements');
      expect(engine.fired()).toHaveLength(1);

      // Having fired once, subsequent calls succeed again (single-fire).
      expect(generate(minimalGenerateContext())).resolves.toEqual({ content: 'ok', toolCalls: [] });
      expect(engine.fired()).toHaveLength(1);
    });

    it('continues the plan-order scan past an unfired after-sequence entry to a later every/nth entry', async () => {
      const runtime = createManualRuntimeServices();
      const plan: FaultPlan = [
        {
          id: 'pending-after-sequence',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'after-sequence', sequence: 10 },
          effect: { kind: 'reject-before-work', error: new Error('never reaches ten') },
        },
        {
          // Targets the SAME call's 2nd occurrence — on this, the call's
          // FIRST matching occurrence, it must not fire either, so the scan
          // continues past it too (proving the non-firing `continue` branch,
          // not just the firing `return` branch, in the same async pass).
          id: 'pending-nth',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'nth', n: 2 },
          effect: { kind: 'reject-before-work', error: new Error('never reaches the 2nd call') },
        },
        {
          id: 'every-after-it',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('the every entry fires instead') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const generate = engine.wrapGenerate(async () => ({ content: 'ok', toolCalls: [] }));

      // Settle one deferred promise — short of the after-sequence threshold
      // (10), so `pickFiringFromAfterSequence` must fall through to the
      // second, `'every'` entry in the SAME call rather than firing itself.
      runtime.deferred.track(Promise.resolve('a'), 'label-a');
      await Promise.resolve();
      await Promise.resolve();

      let error: unknown;
      await generate(minimalGenerateContext()).catch((caught: unknown) => {
        error = caught;
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('the every entry fires instead');
      expect(engine.fired()).toEqual([
        {
          plan: 'every-after-it',
          boundary: 'before-work',
          occurrence: 1,
          firedAt: expect.any(String),
        },
      ]);
    });
  });

  describe('fired() and assertAllFired()', () => {
    it('fired() returns fired faults in fire order', async () => {
      const runtime = createManualRuntimeServices();
      const plan: FaultPlan = [
        {
          id: 'first',
          boundary: 'before-work',
          operation: 'tool:a',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('a') },
        },
        {
          id: 'second',
          boundary: 'before-work',
          operation: 'tool:b',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('b') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const toolA = createTool({
        name: 'a',
        description: 'a',
        input: z.object({}),
        execute: async () => 'a',
      });
      const toolB = createTool({
        name: 'b',
        description: 'b',
        input: z.object({}),
        execute: async () => 'b',
      });
      const wrapped = engine.wrapToolbox(createToolbox([toolA, toolB]));

      expect(wrapped.execute({ id: '1', name: 'b', arguments: {} })).rejects.toThrow('b');
      expect(wrapped.execute({ id: '2', name: 'a', arguments: {} })).rejects.toThrow('a');

      expect(engine.fired().map((f) => f.plan)).toEqual(['second', 'first']);
      engine.assertAllFired();
    });

    it('assertAllFired throws naming every entry that never fired', () => {
      const runtime = createManualRuntimeServices();
      const plan: FaultPlan = [
        {
          id: 'never-runs',
          boundary: 'before-work',
          operation: 'tool:ghost',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('unused') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);

      expect(() => engine.assertAllFired()).toThrow('never-runs');
    });

    it('every FiredFault carries plan/boundary/occurrence/firedAt from RuntimeServices.clock', async () => {
      const runtime = createManualRuntimeServices({ origin: '2030-05-01T00:00:00.000Z' });
      const plan: FaultPlan = [
        {
          id: 'timestamped',
          boundary: 'before-work',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: { kind: 'reject-before-work', error: new Error('boom') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const generate = engine.wrapGenerate(async () => ({ content: 'ok', toolCalls: [] }));

      expect(generate(minimalGenerateContext())).rejects.toThrow('boom');

      expect(engine.fired()).toEqual([
        {
          plan: 'timestamped',
          boundary: 'before-work',
          occurrence: 1,
          firedAt: '2030-05-01T00:00:00.000Z',
        },
      ]);
    });
  });

  describe('determinism', () => {
    it('two runs of the same plan against the same scripted doubles and seeds produce identical fired() output', async () => {
      function buildPlan(): FaultPlan {
        return [
          {
            id: 'det-1',
            boundary: 'before-work',
            operation: 'generate',
            occurrence: { kind: 'nth', n: 1 },
            effect: { kind: 'reject-before-work', error: new Error('boom') },
          },
        ];
      }

      async function runOnce(): Promise<unknown> {
        const runtime = createManualRuntimeServices({ origin: '2031-01-01T00:00:00.000Z' });
        const engine = createFaultEngine(buildPlan(), runtime);
        const generate = engine.wrapGenerate(async () => ({ content: 'ok', toolCalls: [] }));
        expect(generate(minimalGenerateContext())).rejects.toThrow('boom');
        return JSON.parse(JSON.stringify(engine.fired()));
      }

      const first = await runOnce();
      const second = await runOnce();
      expect(first).toEqual(second);
    });
  });

  // -------------------------------------------------------------------------
  // AB-95's own acceptance criterion, restated by AB-265's: a fault fired
  // after an external effect but before its acknowledgement must never let
  // the run report a rolled-back or exactly-once outcome. These three tests
  // (one per boundary AB-265 names) prove the ambiguity exists rather than
  // asserting a new production status: the underlying double's own call log
  // is the only source that can distinguish "nothing happened" (a genuine
  // rollback) from "it happened, but the caller only sees an error" — and
  // for every one of these three boundaries, that log proves the effect
  // occurred while the caller-visible signal is still a bare failure.
  // Neither fact, alone or read from the caller's side only, would let a
  // reader safely conclude a clean rollback or an exactly-once outcome.
  // -------------------------------------------------------------------------
  describe('no false rollback/exactly-once claim', () => {
    it('after-effect: the double proves the effect ran even though the caller only sees a failure', async () => {
      const runtime = createManualRuntimeServices();
      const generateDouble = createScriptedGenerate([
        { kind: 'respond', response: { content: 'x', toolCalls: [] } },
      ]);
      const plan: FaultPlan = [
        {
          id: 'unknown-after-effect',
          boundary: 'after-effect',
          operation: 'generate',
          occurrence: { kind: 'every' },
          effect: { kind: 'fail-after-effect', error: new Error('caller sees only this') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapGenerate(generateDouble);

      let callerFailed = false;
      try {
        await wrapped(minimalGenerateContext());
      } catch {
        callerFailed = true;
      }

      // The caller-visible signal alone (a thrown error) is indistinguishable
      // from a clean, nothing-happened rollback. Only the double's own call
      // log — evidence outside what the caller can see — proves otherwise.
      expect(callerFailed).toBe(true);
      expect(generateDouble.callCount).toBe(1);
    });

    it('after-commit: the double proves the durable write ran even though the caller only sees a failure', async () => {
      const runtime = createManualRuntimeServices();
      const store = createRecordingStore();
      const plan: FaultPlan = [
        {
          id: 'unknown-after-commit',
          boundary: 'after-commit',
          operation: 'storage:set',
          occurrence: { kind: 'every' },
          effect: { kind: 'fail-after-commit', error: new Error('caller sees only this') },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(store);

      let callerFailed = false;
      try {
        await wrapped.set('key-1', 'committed-for-real');
      } catch {
        callerFailed = true;
      }

      expect(callerFailed).toBe(true);
      // The store itself (not the caller-visible result) is the only
      // evidence this was NOT a clean rollback: the write is really there.
      expect(store.data.get('key-1')).toBe('committed-for-real');
    });

    it('lost-acknowledgement: the write commits for real but the caller never observes any terminal outcome at all', async () => {
      const runtime = createManualRuntimeServices();
      const store = createRecordingStore();
      const plan: FaultPlan = [
        {
          id: 'unknown-lost-ack',
          boundary: 'lost-acknowledgement',
          operation: 'storage:set',
          occurrence: { kind: 'every' },
          effect: { kind: 'drop-acknowledgement' },
        },
      ];
      const engine = createFaultEngine(plan, runtime);
      const wrapped = engine.wrapStorage(store);

      let outcome: 'resolved' | 'rejected' | 'pending' = 'pending';
      void wrapped.set('key-1', 'committed-for-real').then(
        () => (outcome = 'resolved'),
        () => (outcome = 'rejected'),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The caller cannot even observe a clean failure here — no exactly-once
      // AND no rolled-back reading is available, because nothing ever
      // settles. Only the store proves the write happened.
      expect(outcome).toBe('pending');
      expect(store.data.get('key-1')).toBe('committed-for-real');
    });
  });
});
