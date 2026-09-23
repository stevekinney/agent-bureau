import { describe, expect, it } from 'bun:test';
import { createAgentCatalog } from './agent-catalog';
import { createSupervisor } from './create-supervisor';
import {
  makeAgent,
  makeFailedRunResult,
  makeRunResult,
  requireError,
} from './supervisor-test-helpers';
describe('createSupervisor', () => {
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

      expect(results.map((r) => r.task).toSorted()).toEqual(['a', 'b']);
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
      expect(requireError(result.agentResults[0]!.error).message).toMatch(/unknown agent "ghost"/i);
    });
  });
});
