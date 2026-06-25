import { describe, expect, it } from 'bun:test';

import type { AgentRegistryEntry, RegistryAgent } from '../src/create-agent-registry';
import {
  createFanOutRouting,
  createRoundRobinRouting,
  createSupervisor,
} from '../src/create-supervisor';
import type { RunResult } from '../src/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRunResult(content: string): RunResult {
  return {
    content,
    steps: [],
    conversation: {} as never,
    usage: { inputTokens: 0, outputTokens: 0 },
    finishReason: 'stop-condition',
  };
}

function makeAgent(
  name: string,
  respond: (input: string) => Promise<RunResult> = (input) =>
    Promise.resolve(makeRunResult(`${name}: ${input}`)),
): RegistryAgent & { receivedInputs: string[] } {
  const receivedInputs: string[] = [];
  return {
    name,
    receivedInputs,
    async run(input: string) {
      receivedInputs.push(input);
      return respond(input);
    },
  };
}

function makeEntry(agent: RegistryAgent, capabilities: string[] = []): AgentRegistryEntry {
  return { agent, description: `${agent.name} agent`, capabilities };
}

// ---------------------------------------------------------------------------
// createSupervisor — core delegation
// ---------------------------------------------------------------------------

describe('createSupervisor', () => {
  describe('delegate', () => {
    it('routes the task to the chosen agent and returns its result', async () => {
      const agent = makeAgent('writer');
      const supervisor = createSupervisor({
        agents: [makeEntry(agent)],
        routing: () => 'writer',
      });

      const result = await supervisor.delegate('Write a poem');
      expect(result.task).toBe('Write a poem');
      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0]!.result?.content).toBe('writer: Write a poem');
    });

    it('passes the task string unmodified to the delegated agent', async () => {
      const agent = makeAgent('worker');
      const supervisor = createSupervisor({
        agents: [makeEntry(agent)],
        routing: () => 'worker',
      });

      const task = 'Do something specific';
      await supervisor.delegate(task);

      expect(agent.receivedInputs).toEqual([task]);
    });

    it('returns error in agentResults when agent is not found', async () => {
      const supervisor = createSupervisor({
        agents: [],
        routing: () => 'nonexistent',
      });

      const result = await supervisor.delegate('task');
      expect(result.agentResults[0]!.error).toBeInstanceOf(Error);
      expect((result.agentResults[0]!.error as Error).message).toContain('nonexistent');
    });

    it('throws when maximum delegations is exceeded', async () => {
      const agent = makeAgent('a');
      const supervisor = createSupervisor({
        agents: [makeEntry(agent)],
        routing: () => 'a',
        maximumDelegations: 1,
      });

      await supervisor.delegate('first');
      await expect(supervisor.delegate('second')).rejects.toThrow('Maximum delegations');
    });
  });

  describe('delegateAll', () => {
    it('delegates each task sequentially by default', async () => {
      const order: string[] = [];
      const agent: RegistryAgent = {
        name: 'worker',
        async run(input: string) {
          order.push(input);
          return makeRunResult(`done: ${input}`);
        },
      };

      const supervisor = createSupervisor({
        agents: [makeEntry(agent)],
        routing: () => 'worker',
      });

      await supervisor.delegateAll(['task-1', 'task-2', 'task-3']);
      expect(order).toEqual(['task-1', 'task-2', 'task-3']);
    });

    it('delegates tasks in parallel when parallel option is set', async () => {
      const agent = makeAgent('worker');
      const supervisor = createSupervisor({
        agents: [makeEntry(agent)],
        routing: () => 'worker',
        maximumDelegations: 10,
      });

      const results = await supervisor.delegateAll(['a', 'b', 'c'], { parallel: true });
      expect(results).toHaveLength(3);
    });
  });

  describe('pipeline', () => {
    it('chains tasks through stages in order', async () => {
      const agentA = makeAgent('a', async () => makeRunResult('output-from-a'));
      const agentB: RegistryAgent & { receivedInputs: string[] } = {
        name: 'b',
        receivedInputs: [],
        async run(input: string) {
          agentB.receivedInputs.push(input);
          return makeRunResult(`output-from-b`);
        },
      };

      const supervisor = createSupervisor({
        agents: [makeEntry(agentA), makeEntry(agentB)],
        routing: () => 'a',
      });

      await supervisor.pipeline('initial', [{ agentName: 'a' }, { agentName: 'b' }]);

      // Stage 2 receives stage 1's output
      expect(agentB.receivedInputs[0]).toBe('output-from-a');
    });

    it('returns empty synthesis for empty pipeline', async () => {
      const supervisor = createSupervisor({
        agents: [],
        routing: () => 'a',
      });

      const result = await supervisor.pipeline('task', []);
      expect(result.synthesis).toBe('');
      expect(result.agentResults).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Regression: PRRT_kwDORvupsc6MX3Pg
  // Scratchpad tools were advertised in the prompt with wrong names
  // (read_scratchpad/write_scratchpad) but never wired into the agent run.
  // The CreateSupervisorOptions.scratchpad field no longer exists; the task
  // string reaches the agent unmodified.
  // -------------------------------------------------------------------------

  describe('scratchpad option (regression PRRT_kwDORvupsc6MX3Pg)', () => {
    it('does not inject scratchpad tool names into the task prompt', async () => {
      const agent = makeAgent('worker');
      const supervisor = createSupervisor({
        agents: [makeEntry(agent)],
        routing: () => 'worker',
      });

      const task = 'Run the task without scratchpad noise';
      await supervisor.delegate(task);

      const received = agent.receivedInputs[0] ?? '';
      expect(received).not.toContain('read_scratchpad');
      expect(received).not.toContain('write_scratchpad');
      expect(received).not.toContain('read-scratchpad');
      expect(received).not.toContain('write-scratchpad');
      // Task arrives verbatim
      expect(received).toBe(task);
    });

    it('CreateSupervisorOptions does not expose a scratchpad property', () => {
      // TypeScript enforces this at compile time; we verify at runtime that
      // passing an unrecognised option is silently ignored (no crash).
      const agent = makeAgent('worker');
      const options = {
        agents: [makeEntry(agent)],
        routing: () => 'worker',
        // Intentionally passing scratchpad as an unknown extra key to confirm
        // the runtime handles it gracefully (TS prevents this at compile time).
        scratchpad: { get: () => undefined, set: () => undefined },
      };

      // Should not throw even with the extra key (JS is permissive)
      expect(() =>
        createSupervisor(options as Parameters<typeof createSupervisor>[0]),
      ).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Built-in routing strategies
// ---------------------------------------------------------------------------

describe('createRoundRobinRouting', () => {
  it('cycles through agents in order', () => {
    const agentA = makeAgent('a');
    const agentB = makeAgent('b');
    const pool = [makeEntry(agentA), makeEntry(agentB)];
    const routing = createRoundRobinRouting();

    expect(routing('task', pool)).toBe('a');
    expect(routing('task', pool)).toBe('b');
    expect(routing('task', pool)).toBe('a');
  });

  it('throws when pool is empty', () => {
    const routing = createRoundRobinRouting();
    expect(() => routing('task', [])).toThrow('No agents available');
  });
});

describe('createFanOutRouting', () => {
  it('returns all agent names', () => {
    const pool = [makeEntry(makeAgent('a')), makeEntry(makeAgent('b')), makeEntry(makeAgent('c'))];
    const routing = createFanOutRouting();

    expect(routing('task', pool)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array when pool is empty', () => {
    const routing = createFanOutRouting();
    expect(routing('task', [])).toEqual([]);
  });
});
