import type { AgentRun, RunResult } from '@lostgradient/operative';
import { createAgent } from '@lostgradient/operative';
import { createMockGenerate } from '@lostgradient/operative/test';
import { describe, expect, it } from 'bun:test';

import { createAgentCatalog } from './agent-catalog';
import type { AgentDescriptor } from './create-supervisor';
import {
  createFanOutRouting,
  createRoundRobinRouting,
  createSupervisor,
  TaskCompletedEvent,
  TaskFailedEvent,
} from './create-supervisor';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRunResult(
  content: string,
  finishReason: RunResult['finishReason'] = 'stop-condition',
): RunResult {
  return {
    content,
    steps: [],
    conversation: {} as never,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason,
  };
}

function makeFailedRunResult(finishReason: RunResult['finishReason'], error?: Error): RunResult {
  return { ...makeRunResult('', finishReason), error };
}

/** A minimal synchronous-`run()` RunnableAgent fixture, mirroring evaluation's. */
function makeAgent(
  name: string,
  respond: (input: string) => Promise<RunResult> = (input) =>
    Promise.resolve(makeRunResult(`${name}: ${input}`)),
) {
  const receivedInputs: string[] = [];
  return {
    fixture: {
      name,
      run: (input: string) => {
        receivedInputs.push(input);
        return {
          result: () => respond(input),
          unwrap: () => Promise.reject(new Error('not used by these tests')),
          abort: () => {},
          [Symbol.dispose]: () => {},
          [Symbol.asyncIterator]: () => {
            throw new Error('not used by these tests');
          },
        } as unknown as AgentRun;
      },
    },
    receivedInputs,
  };
}

// ---------------------------------------------------------------------------
// createSupervisor — core delegation
// ---------------------------------------------------------------------------

describe('createSupervisor', () => {
  describe('delegate', () => {
    it('routes the task to the chosen agent and returns its result', async () => {
      const writer = makeAgent('writer');
      const catalog = createAgentCatalog({ writer: writer.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'writer' });

      const result = await supervisor.delegate('Write a poem');
      expect(result.task).toBe('Write a poem');
      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0]!.result?.content).toBe('writer: Write a poem');
    });

    it('passes the task string unmodified to the delegated agent', async () => {
      const worker = makeAgent('worker');
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const task = 'Do something specific';
      await supervisor.delegate(task);

      expect(worker.receivedInputs).toEqual([task]);
    });

    it('routing may return a Promise of a name', async () => {
      const worker = makeAgent('worker');
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({
        agents: catalog,
        routing: () => Promise.resolve('worker' as const),
      });

      const result = await supervisor.delegate('task');
      expect(result.agentResults[0]!.agentName).toBe('worker');
    });

    it('throws (not swallowed into agentResults) when routing selects an unknown agent', async () => {
      const worker = makeAgent('worker');
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({
        agents: catalog,
        // @ts-expect-error — deliberately an invalid name for this test.
        routing: () => 'nonexistent',
      });

      expect(supervisor.delegate('task')).rejects.toThrow(/unknown agent "nonexistent"/i);
    });

    it('never invokes .run() on an unselected agent, including a lazy one (only selected lazy agents load)', async () => {
      const writer = makeAgent('writer');
      let lazyLoaded = false;
      const catalog = createAgentCatalog({
        writer: writer.fixture,
        lazy: {
          name: '(lazy)',
          run: () => {
            lazyLoaded = true;
            throw new Error('the lazy agent must never be invoked when unselected');
          },
        },
      });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'writer' });

      await supervisor.delegate('task');

      expect(lazyLoaded).toBe(false);
    });

    it('throws when maximum delegations is exceeded', async () => {
      const worker = makeAgent('a');
      const catalog = createAgentCatalog({ a: worker.fixture });
      const supervisor = createSupervisor({
        agents: catalog,
        routing: () => 'a',
        maximumDelegations: 1,
      });

      await supervisor.delegate('first');
      expect(supervisor.delegate('second')).rejects.toThrow('Maximum delegations');
    });

    it('exposes all event facade methods on delegated runs', async () => {
      const worker = makeAgent('worker');
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const events: string[] = [];
      const removedListener = () => events.push('removed');
      const onSubscription = supervisor.on('synthesis.completed').subscribe({
        next() {
          events.push('on');
        },
      });
      const observableSubscription = supervisor.toObservable().subscribe({
        next(event) {
          if (event.type === 'synthesis.completed') events.push('observable');
        },
      });

      supervisor.addEventListener('task.routed', removedListener);
      supervisor.removeEventListener('task.routed', removedListener);
      supervisor.once('task.completed', () => events.push('once'));
      const subscription = supervisor.subscribe('synthesis.completed', () => {
        events.push('subscribe');
      });

      await supervisor.delegate('facade task');

      onSubscription.unsubscribe();
      observableSubscription.unsubscribe();
      subscription.unsubscribe();

      expect(events).toContain('once');
      expect(events).toContain('subscribe');
      expect(events).toContain('observable');
      expect(events).toContain('on');
      expect(events).not.toContain('removed');
    });

    it('delegates one task to every routed agent when routing returns multiple names', async () => {
      const writer = makeAgent('writer');
      const reviewer = makeAgent('reviewer');
      const catalog = createAgentCatalog({ writer: writer.fixture, reviewer: reviewer.fixture });
      const supervisor = createSupervisor({
        agents: catalog,
        routing: () => ['writer', 'reviewer'],
      });

      const result = await supervisor.delegate('ship it');

      expect(writer.receivedInputs).toEqual(['ship it']);
      expect(reviewer.receivedInputs).toEqual(['ship it']);
      expect(result.agentResults.map((agentResult) => agentResult.agentName).sort()).toEqual([
        'reviewer',
        'writer',
      ]);
    });
  });

  describe('failed agent RunResult', () => {
    const FAILURE_REASONS: RunResult['finishReason'][] = [
      'error',
      'aborted',
      'budget-exceeded',
      'elicitation-denied',
      'tripwire',
    ];

    for (const reason of FAILURE_REASONS) {
      it(`dispatches TaskFailedEvent (not TaskCompletedEvent) when finishReason is "${reason}"`, async () => {
        const originalError = new Error(`agent failed: ${reason}`);
        const worker = makeAgent('worker', () =>
          Promise.resolve(makeFailedRunResult(reason, originalError)),
        );
        const catalog = createAgentCatalog({ worker: worker.fixture });
        const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

        const completedEvents: TaskCompletedEvent[] = [];
        const failedEvents: TaskFailedEvent[] = [];
        supervisor.addEventListener(TaskCompletedEvent.type, (e) => completedEvents.push(e));
        supervisor.addEventListener(TaskFailedEvent.type, (e) => failedEvents.push(e));

        const result = await supervisor.delegate('do something');

        expect(failedEvents).toHaveLength(1);
        expect(completedEvents).toHaveLength(0);

        const agentResult = result.agentResults[0];
        expect(agentResult?.error).toBe(originalError);
        expect(agentResult?.result?.finishReason).toBe(reason);
      });
    }

    it('surfaces a synthetic Error when RunResult has a failure reason but no .error property', async () => {
      const worker = makeAgent('worker', () =>
        Promise.resolve(makeFailedRunResult('budget-exceeded')),
      );
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const result = await supervisor.delegate('do something');
      const agentResult = result.agentResults[0];
      expect(agentResult?.error).toBeInstanceOf(Error);
      expect((agentResult?.error as Error).message).toContain('budget-exceeded');
    });

    it('includes the failure in the default synthesis output', async () => {
      const worker = makeAgent('worker', () =>
        Promise.resolve(makeFailedRunResult('error', new Error('something broke'))),
      );
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const result = await supervisor.delegate('do something');
      expect(result.synthesis).toContain('Error:');
      expect(result.synthesis).toContain('something broke');
    });

    it('does not short-circuit for stop-condition (success)', async () => {
      const worker = makeAgent('worker', () =>
        Promise.resolve(makeRunResult('all done', 'stop-condition')),
      );
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const completedEvents: TaskCompletedEvent[] = [];
      const failedEvents: TaskFailedEvent[] = [];
      supervisor.addEventListener(TaskCompletedEvent.type, (e) => completedEvents.push(e));
      supervisor.addEventListener(TaskFailedEvent.type, (e) => failedEvents.push(e));

      const result = await supervisor.delegate('do something');
      expect(completedEvents).toHaveLength(1);
      expect(failedEvents).toHaveLength(0);
      expect(result.agentResults[0]?.error).toBeUndefined();
    });

    it('does not treat maximum-steps as a failure', async () => {
      const worker = makeAgent('worker', () =>
        Promise.resolve(makeRunResult('partial output', 'maximum-steps')),
      );
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const completedEvents: TaskCompletedEvent[] = [];
      const failedEvents: TaskFailedEvent[] = [];
      supervisor.addEventListener(TaskCompletedEvent.type, (e) => completedEvents.push(e));
      supervisor.addEventListener(TaskFailedEvent.type, (e) => failedEvents.push(e));

      const result = await supervisor.delegate('do something');
      expect(completedEvents).toHaveLength(1);
      expect(failedEvents).toHaveLength(0);
      expect(result.agentResults[0]?.error).toBeUndefined();
    });
  });

  describe('delegateAll', () => {
    it('runs tasks sequentially by default, preserving order', async () => {
      const order: string[] = [];
      const worker = makeAgent('worker', (input) => {
        order.push(input);
        return Promise.resolve(makeRunResult(input));
      });
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const results = await supervisor.delegateAll(['a', 'b', 'c']);

      expect(order).toEqual(['a', 'b', 'c']);
      expect(results.map((r) => r.task)).toEqual(['a', 'b', 'c']);
    });

    it('runs tasks in parallel when { parallel: true }', async () => {
      const worker = makeAgent('worker');
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const results = await supervisor.delegateAll(['a', 'b'], { parallel: true });

      expect(results.map((r) => r.task).sort()).toEqual(['a', 'b']);
    });
  });

  describe('pipeline', () => {
    it('threads each stage output into the next stage input', async () => {
      const inputsSeen: string[] = [];
      function makeStageAgent(name: string, output: string) {
        return makeAgent(name, (input) => {
          inputsSeen.push(input);
          return Promise.resolve(makeRunResult(output));
        });
      }
      const drafter = makeStageAgent('drafter', 'draft text');
      const editor = makeStageAgent('editor', 'edited text');
      const catalog = createAgentCatalog({ drafter: drafter.fixture, editor: editor.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'drafter' });

      const result = await supervisor.pipeline('topic', [
        { agentName: 'drafter' },
        { agentName: 'editor' },
      ]);

      expect(inputsSeen).toEqual(['topic', 'draft text']);
      expect(result.synthesis).toBe('edited text');
    });

    it('applies mapInput when supplied', async () => {
      const worker = makeAgent('worker', (input) => Promise.resolve(makeRunResult(input)));
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      await supervisor.pipeline('topic', [
        {
          agentName: 'worker',
          mapInput: (previous, original) => `${original}:${previous || 'seed'}`,
        },
      ]);

      expect(worker.receivedInputs).toEqual(['topic:seed']);
    });

    it('short-circuits and synthesizes on the first stage failure', async () => {
      const failing = makeAgent('failing', () => Promise.resolve(makeFailedRunResult('error')));
      const neverRun = makeAgent('never-run');
      const catalog = createAgentCatalog({
        failing: failing.fixture,
        neverRun: neverRun.fixture,
      });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'failing' });

      const result = await supervisor.pipeline('topic', [
        { agentName: 'failing' },
        { agentName: 'neverRun' },
      ]);

      expect(result.agentResults).toHaveLength(1);
      expect(neverRun.receivedInputs).toEqual([]);
    });

    it('returns an empty result for an empty stage list', async () => {
      const catalog = createAgentCatalog({ worker: makeAgent('worker').fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const result = await supervisor.pipeline('topic', []);

      expect(result.agentResults).toEqual([]);
      expect(result.synthesis).toBe('');
    });

    it('reports an unknown stage agentName as a failed stage rather than throwing (pipeline bypasses routing validation)', async () => {
      const catalog = createAgentCatalog({ worker: makeAgent('worker').fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const result = await supervisor.pipeline('topic', [
        // @ts-expect-error — deliberately an invalid name for this test.
        { agentName: 'ghost' },
      ]);

      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0]!.error).toBeInstanceOf(Error);
      // Pins the source of the failure to catalog.get()'s own throw (the
      // ONLY unknown-agent guard left in runAgent after resolveRoutedNames'
      // has() guard was removed as redundant) — not a .run() throw or a
      // .result() rejection, both of which would also land in this same
      // catch block and read as "covered" without this assertion.
      expect((result.agentResults[0]!.error as Error).message).toMatch(/unknown agent "ghost"/i);
    });
  });

  describe('abort signal', () => {
    it('rejects delegate() when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const catalog = createAgentCatalog({ worker: makeAgent('worker').fixture });
      const supervisor = createSupervisor({
        agents: catalog,
        routing: () => 'worker',
        signal: controller.signal,
      });

      expect(supervisor.delegate('task')).rejects.toThrow();
    });

    it('rejects delegation without invoking any agent when the signal aborts during an asynchronous routing strategy', async () => {
      const controller = new AbortController();
      const worker = makeAgent('worker');
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({
        agents: catalog,
        // Routing itself awaits external state (an LLM-based router, a
        // policy lookup) — the pre-routing `throwIfAborted()` check has
        // already passed by the time this resolves, so only a check AFTER
        // awaiting the strategy can catch an abort that lands in this
        // window.
        routing: async () => {
          controller.abort();
          await Promise.resolve();
          return 'worker' as const;
        },
        signal: controller.signal,
      });

      expect(supervisor.delegate('task')).rejects.toThrow();
      // Give the rejected delegation's microtasks a turn, then confirm the
      // routed agent was never actually invoked — this is the behavior the
      // rejection needs to prove, not just that SOME error surfaced.
      await Promise.resolve();
      await Promise.resolve();
      expect(worker.receivedInputs).toEqual([]);
    });
  });

  describe('custom synthesis', () => {
    it('uses the supplied SynthesisStrategy instead of the default', async () => {
      const worker = makeAgent('worker', () => Promise.resolve(makeRunResult('ignored')));
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({
        agents: catalog,
        routing: () => 'worker',
        synthesis: () => 'custom synthesis',
      });

      const result = await supervisor.delegate('task');
      expect(result.synthesis).toBe('custom synthesis');
    });
  });
});

// ---------------------------------------------------------------------------
// Built-in routing strategies
// ---------------------------------------------------------------------------

describe('createRoundRobinRouting', () => {
  it('cycles through descriptors in order across calls', () => {
    const routing = createRoundRobinRouting();
    const descriptors: readonly AgentDescriptor[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

    expect(routing('t1', descriptors)).toBe('a');
    expect(routing('t2', descriptors)).toBe('b');
    expect(routing('t3', descriptors)).toBe('c');
    expect(routing('t4', descriptors)).toBe('a');
  });

  it('throws when there are no agents to route to', () => {
    const routing = createRoundRobinRouting();
    expect(() => routing('t1', [])).toThrow('No agents available for routing');
  });
});

describe('createFanOutRouting', () => {
  it('selects every descriptor', () => {
    const routing = createFanOutRouting();
    const descriptors: readonly AgentDescriptor[] = [{ name: 'a' }, { name: 'b' }];

    expect(routing('t1', descriptors)).toEqual(['a', 'b']);
  });

  it('selects nothing when the catalog is empty', () => {
    const routing = createFanOutRouting();
    expect(routing('t1', [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration smoke test against a real createAgent-produced agent
// ---------------------------------------------------------------------------

describe('createSupervisor with real createAgent agents', () => {
  it('delegates to and synthesizes a real agent run end to end', async () => {
    const writer = createAgent({
      name: 'writer',
      generate: createMockGenerate([{ content: 'a real poem', toolCalls: [] }]),
    });
    const catalog = createAgentCatalog({ writer });
    const supervisor = createSupervisor({ agents: catalog, routing: () => 'writer' });

    const result = await supervisor.delegate('Write a poem');

    expect(result.agentResults[0]!.result?.content).toBe('a real poem');
    expect(result.synthesis).toContain('a real poem');
  });
});
