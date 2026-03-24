import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';

import { noToolCalls } from '../src/conditions/predicates';
import type { AgentRegistryEntry } from '../src/create-agent-registry';
import { createAgentRegistry } from '../src/create-agent-registry';
import { createScratchpad } from '../src/create-scratchpad';
import {
  createCapabilityRouting,
  createFanOutRouting,
  createRoundRobinRouting,
  createSupervisor,
} from '../src/create-supervisor';
import { defineAgent } from '../src/define-agent';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function createTestEntry(name: string, capabilities: string[] = []): AgentRegistryEntry {
  const agent = defineAgent({
    name,
    generate: async () => textResponse(`Response from ${name}`),
    toolbox: createTestToolbox([]),
    stopWhen: noToolCalls(),
  });
  return {
    agent,
    description: `${name} agent`,
    capabilities,
  };
}

describe('createSupervisor', () => {
  it('delegates a single task to a single agent', async () => {
    const entry = createTestEntry('writer');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'writer',
    });

    const result = await supervisor.delegate('Write a poem');
    expect(result.task).toBe('Write a poem');
    expect(result.agentResults).toHaveLength(1);
    expect(result.agentResults[0]!.agentName).toBe('writer');
    expect(result.agentResults[0]!.result?.content).toBe('Response from writer');
  });

  it('delegates multiple tasks sequentially', async () => {
    const entry = createTestEntry('worker');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
    });

    const results = await supervisor.delegateAll(['Task 1', 'Task 2']);
    expect(results).toHaveLength(2);
    expect(results[0]!.task).toBe('Task 1');
    expect(results[1]!.task).toBe('Task 2');
  });

  it('delegateAll with parallel: true runs concurrently', async () => {
    const completionOrder: string[] = [];

    const entry: AgentRegistryEntry = {
      agent: defineAgent({
        name: 'worker',
        generate: async (context) => {
          const messages = context.conversation.getMessages();
          const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
          const task =
            typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : 'unknown';
          completionOrder.push(task);
          return textResponse(`Response to ${task}`);
        },
        toolbox: createTestToolbox([]),
        stopWhen: noToolCalls(),
      }),
      description: 'Worker',
      capabilities: [],
    };

    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
    });

    const routed: unknown[] = [];
    supervisor.addEventListener('task.routed', (event) => routed.push(event.detail));

    const results = await supervisor.delegateAll(['Task 1', 'Task 2', 'Task 3'], {
      parallel: true,
    });

    expect(results).toHaveLength(3);
    expect(results[0]!.task).toBe('Task 1');
    expect(results[1]!.task).toBe('Task 2');
    expect(results[2]!.task).toBe('Task 3');

    // All tasks are routed before any complete (parallel behavior)
    expect(routed).toHaveLength(3);
  });

  it('delegateAll parallel: true respects maximumDelegations', async () => {
    const entry = createTestEntry('worker');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
      maximumDelegations: 2,
    });

    await expect(
      supervisor.delegateAll(['Task 1', 'Task 2', 'Task 3'], { parallel: true }),
    ).rejects.toThrow('Maximum delegations');
  });

  it('uses default synthesis with attribution', async () => {
    const entry = createTestEntry('writer');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'writer',
    });

    const result = await supervisor.delegate('Write something');
    expect(result.synthesis).toBe('[writer] Response from writer');
  });

  it('uses custom synthesis', async () => {
    const entry = createTestEntry('writer');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'writer',
      synthesis: async (results) => results.map((r) => r.result?.content).join(' + '),
    });

    const result = await supervisor.delegate('Write something');
    expect(result.synthesis).toBe('Response from writer');
  });

  it('handles routing returning an array (fan-out)', async () => {
    const entries = [createTestEntry('a'), createTestEntry('b')];
    const supervisor = createSupervisor({
      agents: entries,
      routing: () => ['a', 'b'],
    });

    const result = await supervisor.delegate('Do this');
    expect(result.agentResults).toHaveLength(2);
    expect(result.agentResults.map((r) => r.agentName).sort()).toEqual(['a', 'b']);
  });

  it('handles agent not found in pool', async () => {
    const entry = createTestEntry('exists');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'missing',
    });

    const result = await supervisor.delegate('Do this');
    expect(result.agentResults[0]!.error).toBeDefined();
  });

  it('enforces maximumDelegations limit', async () => {
    const entry = createTestEntry('worker');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
      maximumDelegations: 2,
    });

    await supervisor.delegate('Task 1');
    await supervisor.delegate('Task 2');
    await expect(supervisor.delegate('Task 3')).rejects.toThrow('Maximum delegations');
  });

  it('propagates abort signal', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');

    const entry = createTestEntry('worker');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
      signal: controller.signal,
    });

    await expect(supervisor.delegate('Task')).rejects.toThrow();
  });

  it('handles partial failure in fan-out', async () => {
    const good = createTestEntry('good');
    const bad: AgentRegistryEntry = {
      agent: defineAgent({
        name: 'bad',
        generate: async () => {
          throw new Error('Agent failure');
        },
        toolbox: createTestToolbox([]),
        stopWhen: noToolCalls(),
      }),
      description: 'A failing agent',
      capabilities: [],
    };

    const supervisor = createSupervisor({
      agents: [good, bad],
      routing: () => ['good', 'bad'],
    });

    const result = await supervisor.delegate('Do this');
    expect(result.agentResults).toHaveLength(2);

    const goodResult = result.agentResults.find((r) => r.agentName === 'good');
    const badResult = result.agentResults.find((r) => r.agentName === 'bad');
    expect(goodResult!.result).toBeDefined();
    expect(goodResult!.result!.finishReason).toBe('stop-condition');
    // The bad agent's run() resolves with finishReason 'error', not a thrown error
    expect(badResult!.result).toBeDefined();
    expect(badResult!.result!.finishReason).toBe('error');
  });
});

describe('routing strategies', () => {
  const entries = [
    createTestEntry('writer', ['writing', 'content']),
    createTestEntry('coder', ['coding', 'review']),
    createTestEntry('analyst', ['analysis', 'data']),
  ];

  describe('createRoundRobinRouting', () => {
    it('cycles through agents in order', () => {
      const routing = createRoundRobinRouting();
      expect(routing('task1', entries)).toBe('writer');
      expect(routing('task2', entries)).toBe('coder');
      expect(routing('task3', entries)).toBe('analyst');
      expect(routing('task4', entries)).toBe('writer');
    });

    it('throws when no agents available', () => {
      const routing = createRoundRobinRouting();
      expect(() => routing('task', [])).toThrow('No agents available');
    });
  });

  describe('createCapabilityRouting', () => {
    it('routes to the agent with the most matching capabilities', () => {
      const routing = createCapabilityRouting();
      expect(routing('writing content', entries)).toBe('writer');
      expect(routing('coding review', entries)).toBe('coder');
    });

    it('uses custom capability extractor', () => {
      const routing = createCapabilityRouting(() => ['analysis']);
      expect(routing('anything', entries)).toBe('analyst');
    });

    it('throws when no agents available', () => {
      const routing = createCapabilityRouting();
      expect(() => routing('task', [])).toThrow('No agents available');
    });
  });

  describe('createFanOutRouting', () => {
    it('returns all agent names', () => {
      const routing = createFanOutRouting();
      const result = routing('task', entries);
      expect(result).toEqual(['writer', 'coder', 'analyst']);
    });
  });
});

describe('supervisor event emission', () => {
  it('emits task.routed event', async () => {
    const entry = createTestEntry('worker');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
    });

    const events: unknown[] = [];
    supervisor.addEventListener('task.routed', (event) => {
      events.push(event.detail);
    });

    await supervisor.delegate('Do this');
    expect(events).toHaveLength(1);
    expect((events[0] as { agentNames: string[] }).agentNames).toEqual(['worker']);
  });

  it('emits task.completed event', async () => {
    const entry = createTestEntry('worker');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
    });

    const events: unknown[] = [];
    supervisor.addEventListener('task.completed', (event) => {
      events.push(event.detail);
    });

    await supervisor.delegate('Do this');
    expect(events).toHaveLength(1);
    expect((events[0] as { agentName: string }).agentName).toBe('worker');
  });

  it('emits task.failed event for missing agent', async () => {
    const entry = createTestEntry('exists');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'missing',
    });

    const events: unknown[] = [];
    supervisor.addEventListener('task.failed', (event) => {
      events.push(event.detail);
    });

    await supervisor.delegate('Do this');
    expect(events).toHaveLength(1);
  });

  it('emits synthesis events', async () => {
    const entry = createTestEntry('worker');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
    });

    const started: unknown[] = [];
    const completed: unknown[] = [];
    supervisor.addEventListener('synthesis.started', (event) => {
      started.push(event.detail);
    });
    supervisor.addEventListener('synthesis.completed', (event) => {
      completed.push(event.detail);
    });

    await supervisor.delegate('Do this');
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
  });
});

describe('supervisor with dynamic registry', () => {
  it('resolves agent pool at delegation time (late binding)', async () => {
    const registry = createAgentRegistry();
    const supervisor = createSupervisor({
      agents: registry,
      routing: () => 'late-agent',
    });

    // Register agent after supervisor creation
    const entry = createTestEntry('late-agent');
    registry.register(entry);

    const result = await supervisor.delegate('Task');
    expect(result.agentResults[0]!.result?.content).toBe('Response from late-agent');
  });
});

describe('supervisor with scratchpad (extended toolbox path)', () => {
  it('delegates with scratchpad and string instructions', async () => {
    const scratchpad = createScratchpad();
    const agent = defineAgent({
      name: 'worker',
      instructions: 'Do work.',
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const entry: AgentRegistryEntry = {
      agent,
      description: 'Worker',
      capabilities: [],
    };

    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
      scratchpad,
    });

    const result = await supervisor.delegate('Task');
    expect(result.agentResults[0]!.result?.content).toBe('Done');
  });

  it('delegates with scratchpad and no instructions', async () => {
    const scratchpad = createScratchpad();
    const agent = defineAgent({
      name: 'worker',
      generate: async () => textResponse('Done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const entry: AgentRegistryEntry = {
      agent,
      description: 'Worker',
      capabilities: [],
    };

    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
      scratchpad,
    });

    const result = await supervisor.delegate('Task');
    expect(result.agentResults[0]!.result?.content).toBe('Done');
  });

  it('handles thrown errors in the catch path', async () => {
    // Create an agent whose run() actually throws (not just returns error)
    const throwingAgent: AgentRegistryEntry = {
      agent: {
        name: 'thrower',
        options: {
          name: 'thrower',
          generate: async () => textResponse(''),
          toolbox: createTestToolbox([]),
        },
        async run() {
          throw new Error('Boom');
        },
        createRun: () => ({}) as never,
      },
      description: 'Throws',
      capabilities: [],
    };

    const supervisor = createSupervisor({
      agents: [throwingAgent],
      routing: () => 'thrower',
    });

    const result = await supervisor.delegate('Task');
    expect(result.agentResults[0]!.error).toBeDefined();
  });

  it('fan-out exceeding maximumDelegations throws', async () => {
    const entries = [createTestEntry('a'), createTestEntry('b'), createTestEntry('c')];
    const supervisor = createSupervisor({
      agents: entries,
      routing: () => ['a', 'b', 'c'], // 3 delegations at once
      maximumDelegations: 2,
    });

    await expect(supervisor.delegate('Task')).rejects.toThrow('Maximum delegations');
  });
});

describe('supervisor with scratchpad respects stopWhen', () => {
  it('respects agent stopWhen (noToolCalls) when scratchpad is provided', async () => {
    const scratchpad = createScratchpad();
    let generateCallCount = 0;

    const agent = defineAgent({
      name: 'bounded-worker',
      instructions: 'Do work.',
      generate: async () => {
        generateCallCount++;
        return textResponse(`Response ${generateCallCount}`);
      },
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      maximumSteps: 10,
    });

    const entry: AgentRegistryEntry = {
      agent,
      description: 'Worker with stop condition',
      capabilities: [],
    };

    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'bounded-worker',
      scratchpad,
    });

    const result = await supervisor.delegate('Task');

    // With noToolCalls(), the run should stop after the first step (text-only response).
    // Without the fix, stopWhen is dropped and the loop runs to maximumSteps.
    expect(result.agentResults[0]!.result?.finishReason).toBe('stop-condition');
    expect(result.agentResults[0]!.result?.steps.length).toBe(1);
  });
});

describe('supervisor with scratchpad (shared state)', () => {
  it('scratchpad is shared across delegated tasks', async () => {
    const scratchpad = createScratchpad();
    scratchpad.set('shared-key', 'shared-value');

    // Agent that reads from scratchpad in its generate function
    let scratchpadContent: unknown;
    const agent = defineAgent({
      name: 'reader',
      generate: async () => {
        // The scratchpad is accessible, simulate reading
        scratchpadContent = scratchpad.get('shared-key');
        return textResponse('Done');
      },
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });

    const entry: AgentRegistryEntry = {
      agent,
      description: 'Reader agent',
      capabilities: [],
    };

    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'reader',
      scratchpad,
    });

    await supervisor.delegate('Read the scratchpad');
    expect(scratchpadContent).toBe('shared-value');
  });
});

describe('supervisor pipeline', () => {
  function createNamedEntry(name: string, responsePrefix?: string): AgentRegistryEntry {
    const prefix = responsePrefix ?? name;
    const agent = defineAgent({
      name,
      generate: async (context) => {
        const messages = context.conversation.getMessages();
        const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
        const content = lastUserMessage?.content ?? '';
        const input = typeof content === 'string' ? content : '';
        return textResponse(`${prefix}: ${input}`);
      },
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
    });
    return {
      agent,
      description: `${name} agent`,
      capabilities: [],
    };
  }

  it('2-stage chain passes output as next input', async () => {
    const entries = [createNamedEntry('stage-a', 'A'), createNamedEntry('stage-b', 'B')];
    const supervisor = createSupervisor({
      agents: entries,
      routing: () => 'stage-a',
    });

    const result = await supervisor.pipeline('hello', [
      { agentName: 'stage-a' },
      { agentName: 'stage-b' },
    ]);

    expect(result.agentResults).toHaveLength(2);
    expect(result.agentResults[0]!.agentName).toBe('stage-a');
    expect(result.agentResults[1]!.agentName).toBe('stage-b');
    // Stage A receives the original task, stage B receives stage A's output
    expect(result.agentResults[0]!.result?.content).toBe('A: hello');
    expect(result.agentResults[1]!.result?.content).toBe('B: A: hello');
    expect(result.synthesis).toBe('B: A: hello');
  });

  it('3-stage chain', async () => {
    const entries = [
      createNamedEntry('first', '1'),
      createNamedEntry('second', '2'),
      createNamedEntry('third', '3'),
    ];
    const supervisor = createSupervisor({
      agents: entries,
      routing: () => 'first',
    });

    const result = await supervisor.pipeline('start', [
      { agentName: 'first' },
      { agentName: 'second' },
      { agentName: 'third' },
    ]);

    expect(result.agentResults).toHaveLength(3);
    expect(result.synthesis).toBe('3: 2: 1: start');
  });

  it('custom mapInput transforms between stages', async () => {
    const entries = [createNamedEntry('alpha', 'A'), createNamedEntry('beta', 'B')];
    const supervisor = createSupervisor({
      agents: entries,
      routing: () => 'alpha',
    });

    const result = await supervisor.pipeline('original', [
      { agentName: 'alpha' },
      {
        agentName: 'beta',
        mapInput: (previousOutput, originalTask) =>
          `transformed(${previousOutput}, ${originalTask})`,
      },
    ]);

    expect(result.agentResults).toHaveLength(2);
    expect(result.agentResults[1]!.result?.content).toBe('B: transformed(A: original, original)');
  });

  it('error mid-pipeline stops and returns partial results', async () => {
    const good = createNamedEntry('good', 'OK');
    const failing: AgentRegistryEntry = {
      agent: {
        name: 'failing',
        options: {
          name: 'failing',
          generate: async () => textResponse(''),
          toolbox: createTestToolbox([]),
        },
        async run() {
          throw new Error('Pipeline stage failed');
        },
        createRun: () => ({}) as never,
      },
      description: 'Failing agent',
      capabilities: [],
    };
    const afterFail = createNamedEntry('after-fail', 'AFTER');

    const supervisor = createSupervisor({
      agents: [good, failing, afterFail],
      routing: () => 'good',
    });

    const result = await supervisor.pipeline('task', [
      { agentName: 'good' },
      { agentName: 'failing' },
      { agentName: 'after-fail' },
    ]);

    // Pipeline should stop at the failing stage
    expect(result.agentResults).toHaveLength(2);
    expect(result.agentResults[0]!.agentName).toBe('good');
    expect(result.agentResults[1]!.agentName).toBe('failing');
    expect(result.agentResults[1]!.error).toBeDefined();
  });

  it('abort signal cancels pipeline', async () => {
    const controller = new AbortController();
    const entry = createNamedEntry('worker');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
      signal: controller.signal,
    });

    controller.abort('cancelled');

    await expect(
      supervisor.pipeline('task', [{ agentName: 'worker' }, { agentName: 'worker' }]),
    ).rejects.toThrow();
  });

  it('empty stages array returns empty result', async () => {
    const entry = createNamedEntry('worker');
    const supervisor = createSupervisor({
      agents: [entry],
      routing: () => 'worker',
    });

    const result = await supervisor.pipeline('task', []);
    expect(result.agentResults).toHaveLength(0);
    expect(result.synthesis).toBe('');
    expect(result.task).toBe('task');
  });

  it('events emitted for each stage', async () => {
    const entries = [createNamedEntry('one', '1'), createNamedEntry('two', '2')];
    const supervisor = createSupervisor({
      agents: entries,
      routing: () => 'one',
    });

    const routed: unknown[] = [];
    const completed: unknown[] = [];
    const synthesisStarted: unknown[] = [];
    const synthesisCompleted: unknown[] = [];

    supervisor.addEventListener('task.routed', (event) => routed.push(event.detail));
    supervisor.addEventListener('task.completed', (event) => completed.push(event.detail));
    supervisor.addEventListener('synthesis.started', (event) =>
      synthesisStarted.push(event.detail),
    );
    supervisor.addEventListener('synthesis.completed', (event) =>
      synthesisCompleted.push(event.detail),
    );

    await supervisor.pipeline('go', [{ agentName: 'one' }, { agentName: 'two' }]);

    expect(routed).toHaveLength(2);
    expect(completed).toHaveLength(2);
    expect(synthesisStarted).toHaveLength(1);
    expect(synthesisCompleted).toHaveLength(1);
  });
});
