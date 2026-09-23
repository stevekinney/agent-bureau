import { createAgent, createMockGenerate } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { createAgentCatalog } from './agent-catalog';
import { createSupervisor } from './create-supervisor';
import { makeAgent } from './supervisor-test-helpers';
describe('createSupervisor', () => {
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
