import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createDefaultRuntimeServices, createManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import { createAgentRun } from '../agent-run';
import { noToolCalls } from '../conditions/predicates';
import { createAgent } from '../create-agent';
import { createActiveRun } from '../create-run';
import type { CombinedOperativeEventClassMap } from '../events';
import type { GenerateResponse } from '../types';
import { createEventRecorder } from './event-recorder';
import { createMockGenerate } from './index';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function controllableGenerate(): {
  generate: () => Promise<GenerateResponse>;
  started: Promise<void>;
  resolveWith: (response: GenerateResponse) => void;
} {
  let resolve: ((response: GenerateResponse) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((_resolve) => {
    markStarted = _resolve;
  });
  const generate = () =>
    new Promise<GenerateResponse>((_resolve) => {
      resolve = _resolve;
      markStarted?.();
    });
  return {
    generate,
    started,
    resolveWith: (response) => resolve?.(response),
  };
}

describe('EventRecorder', () => {
  describe('attach — complete event-map subscription, no hand-maintained allowlist', () => {
    it('captures a member of a locally declared event map without editing event-recorder.ts', () => {
      // The regression this recorder exists to close: `createRunRecorder`'s
      // deleted 32-entry `eventTypes` array silently omitted event families
      // added later. `attach`'s third parameter is how a caller observing a
      // map this file has never seen still gets full coverage — no edit to
      // event-recorder.ts required.
      const target = new EventTarget();
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);

      interface LocalEventMap {
        'local.new-family': Event;
      }

      const detach = recorder.attach<LocalEventMap>(target, { kind: 'local', id: 'target-1' }, [
        'local.new-family',
      ]);

      target.dispatchEvent(new Event('local.new-family'));

      const entries = recorder.normalize();
      expect(entries.map((entry) => entry.event)).toEqual(['local.new-family']);

      detach();
    });

    it('two recorders attached to the same run both observe every event; disposing one does not affect the other', async () => {
      const runtime = createManualRuntimeServices();
      const recorderA = createEventRecorder(runtime);
      const recorderB = createEventRecorder(runtime);

      const activeRun = createActiveRun({
        generate: createMockGenerate([textResponse('Done.')]),
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });

      const detachA = recorderA.attach<CombinedOperativeEventClassMap>(activeRun, {
        kind: 'run',
        id: 'shared',
      });
      recorderB.attach<CombinedOperativeEventClassMap>(activeRun, { kind: 'run', id: 'shared' });

      // Detach A immediately, before the run produces most of its events.
      detachA();

      await activeRun.result;

      const eventsA = recorderA.normalize();
      const eventsB = recorderB.normalize();

      // A only saw whatever fired synchronously before detach (at most
      // `run.started`); B, never detached, saw the full run.
      expect(eventsA.length).toBeLessThan(eventsB.length);
      expect(eventsB.map((entry) => entry.event)).toContain('run.completed');
    });

    it('detach removes every listener it added, observed through a second independent subscriber', () => {
      const target = new EventTarget();
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);

      interface LocalEventMap {
        'local.ping': Event;
      }

      // A second, independent subscriber — proves both that dispatch really
      // happens (so the recorder's later silence isn't just "nothing fired")
      // and, via its own count, that the recorder's own listener is gone.
      let independentCount = 0;
      target.addEventListener('local.ping', () => {
        independentCount++;
      });

      const detach = recorder.attach<LocalEventMap>(target, { kind: 'local', id: 'target-1' }, [
        'local.ping',
      ]);

      target.dispatchEvent(new Event('local.ping'));
      expect(recorder.normalize()).toHaveLength(1);
      expect(independentCount).toBe(1);

      detach();
      // Detaching twice is a no-op (never throws, never double-removes).
      detach();

      target.dispatchEvent(new Event('local.ping'));
      expect(recorder.normalize()).toHaveLength(1); // unchanged
      expect(independentCount).toBe(2); // the independent subscriber still fires
    });
  });

  describe('normalize — portable, byte-identical output', () => {
    async function runScriptedCase(runtime: ReturnType<typeof createManualRuntimeServices>) {
      const activeRun = createActiveRun({
        generate: createMockGenerate([textResponse('Done.')]),
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
        agentName: 'scripted-agent',
      });
      const recorder = createEventRecorder(runtime);
      recorder.attach<CombinedOperativeEventClassMap>(activeRun, { kind: 'run', id: 'scripted' });
      await activeRun.result;
      return recorder.normalize();
    }

    it('produces byte-identical normalized output across two independently constructed manual runtimes', async () => {
      const traceA = await runScriptedCase(createManualRuntimeServices());
      const traceB = await runScriptedCase(createManualRuntimeServices());

      expect(traceA.length).toBeGreaterThan(0);
      expect(JSON.stringify(traceA)).toBe(JSON.stringify(traceB));
    });

    it('produces a byte-identical conversation id in the terminal RunResult across two independently constructed manual runtimes with the same seeds (AB-321)', async () => {
      // AB-263's own reproduction-artifact test (`packages/bureau/src/test/
      // reproduction-artifact.test.ts`) documented this exact gap:
      // conversationalist's `randomId` environment seam was not wired to
      // AB-92's `RuntimeServices`, so `run.result().conversation`'s id
      // differed run to run even under two identically-seeded manual
      // runtimes. AB-321 closes it — `createAgent` now forwards its
      // resolved `runtime` into every `Conversation` it constructs.
      async function runScriptedCase(runtime: ReturnType<typeof createManualRuntimeServices>) {
        const agent = createAgent({
          name: 'scripted-agent',
          generate: createMockGenerate([textResponse('Done.')]),
          toolbox: createToolbox([]),
          stopWhen: noToolCalls(),
          runtime,
        });
        const recorder = createEventRecorder(runtime);
        const run = agent.run('hello');
        recorder.attachIterable(run, { kind: 'run', id: 'scripted' });
        const result = await run.result();
        await runtime.deferred.drain();
        return { trace: recorder.normalize(), result };
      }

      const seeds = { origin: '2030-01-01T00:00:00.000Z', identifierSeed: 'shared-seed' };
      const caseA = await runScriptedCase(createManualRuntimeServices(seeds));
      const caseB = await runScriptedCase(createManualRuntimeServices(seeds));

      expect(caseA.result.conversation.current.id).toBe(caseB.result.conversation.current.id);
      expect(JSON.stringify(caseA.trace)).toBe(JSON.stringify(caseB.trace));
      // `RunResult.conversation` and every `StepResult.conversation` are
      // live `Conversation` instances (not JSON-safe — each carries an
      // internal event target), so compare the terminal result's own
      // plain, serializable fields plus the conversation's serializable
      // `ConversationHistory` snapshot instead of the whole object graph.
      expect(
        JSON.stringify({
          content: caseA.result.content,
          finishReason: caseA.result.finishReason,
          usage: caseA.result.usage,
          conversation: caseA.result.conversation.current,
        }),
      ).toBe(
        JSON.stringify({
          content: caseB.result.content,
          finishReason: caseB.result.finishReason,
          usage: caseB.result.usage,
          conversation: caseB.result.conversation.current,
        }),
      );
    });

    it('never surfaces an absolute wall-clock value — only an offset from the runtime clock origin', async () => {
      // Two runtimes with different origins: if the recorder captured an
      // absolute `clock.now()` reading anywhere, these two traces would
      // diverge by exactly the origin difference. They don't, because
      // `capturedAtOffsetMs` is always relative to each recorder's own
      // construction-time clock reading.
      const traceA = await runScriptedCase(
        createManualRuntimeServices({ origin: '2024-01-01T00:00:00.000Z' }),
      );
      const traceB = await runScriptedCase(
        createManualRuntimeServices({ origin: '2030-06-15T00:00:00.000Z' }),
      );

      expect(JSON.stringify(traceA)).toBe(JSON.stringify(traceB));
    });

    it('rewrites identifier-shaped strings to first-seen logical positions', () => {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const target = new EventTarget();

      interface IdEventMap {
        'id.seen': Event & { readonly runId: string };
      }

      recorder.attach<IdEventMap>(target, { kind: 'local', id: 't' }, ['id.seen']);

      const first = new Event('id.seen') as Event & { runId: string };
      first.runId = runtime.identifiers.next('run');
      const second = new Event('id.seen') as Event & { runId: string };
      second.runId = runtime.identifiers.next('run');

      target.dispatchEvent(first);
      target.dispatchEvent(second);

      const [entryOne, entryTwo] = recorder.normalize();
      const resultOne = entryOne?.result as { runId: string };
      const resultTwo = entryTwo?.result as { runId: string };

      expect(resultOne.runId).toBe('identifier-1');
      expect(resultTwo.runId).toBe('identifier-2');
      expect(resultOne.runId).not.toBe(first.runId);
    });

    it("rewrites the default runtime's `${kind}-${n}-${uuid}` identifiers too, not only the manual runtime's shape", () => {
      const runtime = createDefaultRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const target = new EventTarget();

      interface IdEventMap {
        'id.seen': Event & { readonly runId: string };
      }

      recorder.attach<IdEventMap>(target, { kind: 'local', id: 't' }, ['id.seen']);

      const first = new Event('id.seen') as Event & { runId: string };
      first.runId = runtime.identifiers.next('run');
      const second = new Event('id.seen') as Event & { runId: string };
      second.runId = runtime.identifiers.next('run');

      target.dispatchEvent(first);
      target.dispatchEvent(second);

      const [entryOne, entryTwo] = recorder.normalize();
      const resultOne = entryOne?.result as { runId: string };
      const resultTwo = entryTwo?.result as { runId: string };

      expect(resultOne.runId).toBe('identifier-1');
      expect(resultTwo.runId).toBe('identifier-2');
    });

    it('projects array-valued and identifier-array-valued fields on a captured event', async () => {
      // Exercises `projectValue`'s array branch (an event whose own field is
      // a non-empty array — `toolCalls`/`results` on the tool-execution
      // events) and `IdentifierNormalizer.rewrite`'s array branch (an array
      // containing identifier-shaped strings) together, via a real tool call
      // through `ActiveRun`.
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const weatherTool = createTool({
        name: 'get_weather',
        description: 'Get weather for a location',
        input: z.object({ location: z.string() }),
        execute: async ({ location }) => ({ temperature: 72, location }),
      });
      const activeRun = createActiveRun({
        generate: createMockGenerate([
          {
            content: '',
            toolCalls: [{ name: 'get_weather', arguments: { location: 'Denver' } }],
          },
          textResponse('Done.'),
        ]),
        toolbox: createToolbox([weatherTool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });
      recorder.attach<CombinedOperativeEventClassMap>(activeRun, { kind: 'run', id: 'r' });
      await activeRun.result;

      const toolsExecuting = recorder
        .normalize()
        .find((entry) => entry.event === 'tools.executing');
      const result = toolsExecuting?.result as { toolCalls: unknown[] };
      expect(Array.isArray(result.toolCalls)).toBe(true);
      expect(result.toolCalls.length).toBeGreaterThan(0);
    });
  });

  describe('assertSequence', () => {
    it('passes for the exact observed sequence on a single resource', async () => {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const activeRun = createActiveRun({
        generate: createMockGenerate([textResponse('Done.')]),
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });
      recorder.attach<CombinedOperativeEventClassMap>(activeRun, { kind: 'run', id: 'r' }, [
        'run.started',
        'step.started',
        'run.completed',
      ]);
      await activeRun.result;

      expect(() =>
        recorder.assertSequence(['run.started', 'step.started', 'run.completed']),
      ).not.toThrow();
    });

    it('fails with the observed sequence in the message', async () => {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const activeRun = createActiveRun({
        generate: createMockGenerate([textResponse('Done.')]),
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });
      recorder.attach<CombinedOperativeEventClassMap>(activeRun, { kind: 'run', id: 'r' }, [
        'run.started',
        'run.completed',
      ]);
      await activeRun.result;

      expect(() => recorder.assertSequence(['run.completed', 'run.started'])).toThrow(
        /run\.started, run\.completed/,
      );
    });

    it('rejects a multi-resource trace, naming assertHappensBefore instead', async () => {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const runA = createActiveRun({
        generate: createMockGenerate([textResponse('a')]),
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });
      const runB = createActiveRun({
        generate: createMockGenerate([textResponse('b')]),
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });
      recorder.attach<CombinedOperativeEventClassMap>(runA, { kind: 'run', id: 'a' }, [
        'run.started',
      ]);
      recorder.attach<CombinedOperativeEventClassMap>(runB, { kind: 'run', id: 'b' }, [
        'run.started',
      ]);
      await Promise.all([runA.result, runB.result]);

      expect(() => recorder.assertSequence(['run.started'])).toThrow(/assertHappensBefore/);
    });
  });

  describe('assertHappensBefore', () => {
    async function buildTwoChildren(order: 'a-first' | 'b-first') {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const a = controllableGenerate();
      const b = controllableGenerate();

      const runA = createActiveRun({
        generate: a.generate,
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });
      const runB = createActiveRun({
        generate: b.generate,
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });

      recorder.attach<CombinedOperativeEventClassMap>(runA, { kind: 'run', id: 'child-a' });
      recorder.attach<CombinedOperativeEventClassMap>(runB, { kind: 'run', id: 'child-b' });

      await Promise.all([a.started, b.started]);

      if (order === 'a-first') {
        a.resolveWith(textResponse('a done'));
        await Promise.resolve();
        b.resolveWith(textResponse('b done'));
      } else {
        b.resolveWith(textResponse('b done'));
        await Promise.resolve();
        a.resolveWith(textResponse('a done'));
      }

      await Promise.all([runA.result, runB.result]);
      return recorder;
    }

    it('holds for each child regardless of which child settles first', async () => {
      const aFirst = await buildTwoChildren('a-first');
      aFirst.assertHappensBefore('run:child-a:run.started', 'run:child-a:run.completed');
      aFirst.assertHappensBefore('run:child-b:run.started', 'run:child-b:run.completed');

      const bFirst = await buildTwoChildren('b-first');
      bFirst.assertHappensBefore('run:child-a:run.started', 'run:child-a:run.completed');
      bFirst.assertHappensBefore('run:child-b:run.started', 'run:child-b:run.completed');
    });

    it('throws when no causal path connects the two entries', async () => {
      const recorder = await buildTwoChildren('a-first');
      expect(() =>
        recorder.assertHappensBefore('run:child-a:run.completed', 'run:child-a:run.started'),
      ).toThrow(/no causal path/);
    });

    it('throws a clear ambiguity error for an unqualified key matching multiple resources', async () => {
      const recorder = await buildTwoChildren('a-first');
      expect(() =>
        recorder.assertHappensBefore('run.started', 'run:child-a:run.completed'),
      ).toThrow(/ambiguous/);
    });

    it('resolves a bare unqualified key when it uniquely matches one entry', async () => {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const activeRun = createActiveRun({
        generate: createMockGenerate([textResponse('Done.')]),
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });
      recorder.attach<CombinedOperativeEventClassMap>(activeRun, { kind: 'run', id: 'solo' }, [
        'run.started',
        'run.completed',
      ]);
      await activeRun.result;

      // Both keys are bare event-type names — a single resource means each
      // is unambiguous, so this resolves through the unqualified branch.
      expect(() => recorder.assertHappensBefore('run.started', 'run.completed')).not.toThrow();
    });

    it('throws when a key matches no captured entry at all', async () => {
      const recorder = await buildTwoChildren('a-first');
      expect(() =>
        recorder.assertHappensBefore('no.such.event', 'run:child-a:run.completed'),
      ).toThrow(/did not match any captured entry/);
    });
  });

  describe('attachIterable — the AsyncIterable<RunEvent> surface', () => {
    it('captures every event from an AgentRun stream', async () => {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);
      const activeRun = createActiveRun({
        generate: createMockGenerate([textResponse('Done.')]),
        toolbox: createToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      });
      const agentRun = createAgentRun(activeRun);

      recorder.attachIterable(agentRun, { kind: 'agent-run', id: 'r' });
      await agentRun.result();
      // `result()` resolving doesn't guarantee the background consumption
      // loop `attachIterable` started has caught up to the iterable's own
      // end — `deferred.drain()` waits for that loop's tracked promise to
      // settle, which only happens once the iterable itself is exhausted.
      await runtime.deferred.drain();

      const entries = recorder.normalize();
      expect(entries.map((entry) => entry.event)).toContain('run.started');
      expect(entries.map((entry) => entry.event)).toContain('run.completed');
    });

    it('detach calls iterator.return() and stops recording, even if the source still has a value in flight', async () => {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);

      let returnCalled = false;
      let resolveSecond: (() => void) | undefined;
      const secondReady = new Promise<void>((_resolve) => {
        resolveSecond = _resolve;
      });

      const source: AsyncIterable<{ type: string }> = {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              if (index === 0) {
                index++;
                return { done: false, value: { type: 'run.started' } };
              }
              await secondReady;
              index++;
              return { done: false, value: { type: 'run.completed' } };
            },
            async return() {
              returnCalled = true;
              return { done: true, value: undefined };
            },
          };
        },
      };

      const detach = recorder.attachIterable(source as never, { kind: 'agent-run', id: 'r' });

      // Let the first value deliver.
      await Promise.resolve();
      await Promise.resolve();
      expect(recorder.normalize().map((entry) => entry.event)).toEqual(['run.started']);

      detach();
      expect(returnCalled).toBe(true);

      // The source still had a second value pending — releasing it now must
      // not be recorded, since `attach`'s `stopped` flag gates capture
      // independent of whether `.return()` alone would have cut this off.
      resolveSecond?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(recorder.normalize().map((entry) => entry.event)).toEqual(['run.started']);

      const report = await runtime.deferred.drain();
      expect(report.outstanding).toEqual([]);
    });

    it('reports a rejected iteration through deferred.drain() rather than an unhandled rejection', async () => {
      const runtime = createManualRuntimeServices();
      const recorder = createEventRecorder(runtime);

      const source = {
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(new Error('iteration failed')),
          };
        },
      };

      recorder.attachIterable(source, { kind: 'agent-run', id: 'r' });

      const report = await runtime.deferred.drain();
      const failed = report.settled.find((entry) => entry.label === 'event-recorder:agent-run:r');
      expect(failed?.outcome).toBe('rejected');
    });
  });
});
