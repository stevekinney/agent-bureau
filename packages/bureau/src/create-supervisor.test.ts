import { describe, expect, it } from 'bun:test';
import { createAgentCatalog } from './agent-catalog';
import { createSupervisor } from './create-supervisor';
import { makeAgent, makeRunResult } from './supervisor-test-helpers';
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
          hasOutput: false,
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
      expect(result.agentResults.map((agentResult) => agentResult.agentName).toSorted()).toEqual([
        'reviewer',
        'writer',
      ]);
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
