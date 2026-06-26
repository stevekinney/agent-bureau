import { describe, expect, it, mock } from 'bun:test';

import {
  createManualCheckpointStore,
  createManualDurableEngine,
  createMockAgentRegistry,
  createMockRegistryAgent,
  createMockScratchpad,
  createStepwiseBlockingGenerate,
  spyEngine,
  waitForCondition,
  waitForRunState,
} from '../src/test/index';

describe('createMockScratchpad', () => {
  it('creates a scratchpad with initial values', () => {
    const pad = createMockScratchpad({ x: 1, y: 2 });
    expect(pad.get('x')).toBe(1);
    expect(pad.get('y')).toBe(2);
  });

  it('creates an empty scratchpad when no values given', () => {
    const pad = createMockScratchpad();
    expect(pad.toJSON()).toEqual({});
  });
});

describe('createMockRegistryAgent', () => {
  it('creates a mock agent with the given name', () => {
    const agent = createMockRegistryAgent('test');
    expect(agent.name).toBe('test');
  });

  it('run returns mock content', async () => {
    const agent = createMockRegistryAgent('helper');
    const result = await agent.run('Hello');
    expect(result.content).toBe('Mock response from helper');
    expect(result.finishReason).toBe('stop-condition');
  });

  it('applies overrides', async () => {
    const agent = createMockRegistryAgent('custom', {
      run: async () => ({
        conversation: {} as never,
        steps: [],
        content: 'Custom output',
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'stop-condition' as const,
      }),
    });
    const result = await agent.run('Hi');
    expect(result.content).toBe('Custom output');
  });
});

describe('createMockAgentRegistry', () => {
  it('creates an empty registry', () => {
    const registry = createMockAgentRegistry();
    expect(registry.entries()).toEqual([]);
  });

  it('creates a pre-populated registry', () => {
    const agent = createMockRegistryAgent('a');
    const registry = createMockAgentRegistry([
      { agent, description: 'Agent A', capabilities: ['x'] },
    ]);
    expect(registry.has('a')).toBe(true);
    expect(registry.entries()).toHaveLength(1);
  });
});

// ── Promoted durable-test helpers (A2) ──────────────────────────────────────

describe('waitForCondition', () => {
  it('resolves immediately when the condition is already true', async () => {
    await expect(waitForCondition(() => true, 'never fails')).resolves.toBeUndefined();
  });

  it('polls until the condition becomes true', async () => {
    let count = 0;
    const condition = () => {
      count++;
      return count >= 3;
    };
    await waitForCondition(condition, 'should not fail');
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('throws the failure message when the condition is never met', async () => {
    const neverTrue = () => false;
    await expect(
      waitForCondition(neverTrue, 'expected failure message', 3, async () => {}),
    ).rejects.toThrow('expected failure message');
  });

  it('uses a custom yield function between attempts', async () => {
    const customYield = mock(async () => {});
    let count = 0;
    await waitForCondition(
      () => {
        count++;
        return count >= 2;
      },
      'never fails',
      10,
      customYield,
    );
    // At least one yield occurred between attempts
    expect(customYield).toHaveBeenCalled();
  });
});

describe('waitForRunState', () => {
  it('resolves when getRun returns a non-running status', async () => {
    const store = {
      getRun: (_id: string) => ({ status: 'completed' as const }),
    };
    const result = await waitForRunState(store, 'run-1');
    expect(result.status).toBe('completed');
  });

  it('polls until the run reaches a non-running status', async () => {
    let calls = 0;
    const store = {
      getRun: (_id: string) => {
        calls++;
        return calls < 3 ? { status: 'running' as const } : { status: 'completed' as const };
      },
    };
    const result = await waitForRunState(store, 'run-1');
    expect(result.status).toBe('completed');
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('accepts a custom predicate', async () => {
    const store = {
      getRun: (_id: string) => ({ status: 'error' as const }),
    };
    const result = await waitForRunState(store, 'run-1', (r) => r.status === 'error');
    expect(result.status).toBe('error');
  });

  it('throws when the run never reaches the expected state', async () => {
    const store = {
      getRun: (_id: string) => ({ status: 'running' as const }),
    };
    await expect(
      waitForRunState({ getRun: store.getRun }, 'run-never', (r) => r.status === 'completed'),
    ).rejects.toThrow('run-never');
  });
});

describe('createManualDurableEngine', () => {
  it('resolves the result when resolveResult is called', async () => {
    const { engine, resolveResult } = createManualDurableEngine();
    const handle = await engine.start('test', {});
    const resultPromise = handle.result();
    resolveResult();
    await expect(resultPromise).resolves.toMatchObject({ runId: 'manual-run' });
  });

  it('rejects the result when rejectResult is called', async () => {
    const { engine, rejectResult } = createManualDurableEngine();
    const handle = await engine.start('test', {});
    const resultPromise = handle.result();
    rejectResult(new Error('test error'));
    await expect(resultPromise).rejects.toThrow('test error');
  });

  it('cancel rejects the result with Workflow cancelled', async () => {
    const { engine } = createManualDurableEngine();
    const handle = await engine.start('test', {});
    const resultPromise = handle.result();
    await engine.cancel('any-id');
    await expect(resultPromise).rejects.toThrow('Workflow cancelled');
  });
});

describe('spyEngine', () => {
  it('records suspend, resume, and cancel calls', async () => {
    const { engine } = createManualDurableEngine();
    const spy = spyEngine(engine);

    await engine.suspend('run-1');
    await engine.resume('run-1');
    await engine.suspend('run-2');

    expect(spy.suspends).toEqual(['run-1', 'run-2']);
    expect(spy.resumes).toEqual(['run-1']);
    expect(spy.cancels).toHaveLength(0);
  });

  it('still calls through to the real engine methods', async () => {
    const { engine, resolveResult } = createManualDurableEngine();
    const spy = spyEngine(engine);

    // suspend on a manual engine is a no-op but should not throw
    await expect(engine.suspend('run-x')).resolves.toBeUndefined();
    expect(spy.suspends).toContain('run-x');

    // get should still return { status: 'suspended' }
    const state = await engine.get('any');
    expect(state?.status).toBe('suspended');

    resolveResult(); // clean up pending promise
  });
});

describe('createManualCheckpointStore', () => {
  it('loadCheckpoint returns a zero-step cursor for any runId', async () => {
    const store = createManualCheckpointStore();
    const checkpoint = await store.loadCheckpoint('run-xyz');
    expect(checkpoint.runId).toBe('run-xyz');
    expect(checkpoint.cursor.step).toBe(0);
    expect(checkpoint.conversation).toBeNull();
    expect(checkpoint.steps).toEqual([]);
  });

  it('loadCursor returns null', async () => {
    const store = createManualCheckpointStore();
    expect(await store.loadCursor('run-xyz')).toBeNull();
  });

  it('clear returns 0', async () => {
    const store = createManualCheckpointStore();
    expect(await store.clear('run-xyz')).toBe(0);
  });
});

describe('createStepwiseBlockingGenerate', () => {
  it('step 0 returns a tool call immediately', async () => {
    const { generate } = createStepwiseBlockingGenerate();
    const response = await generate({ step: 0, conversation: {} as never, toolbox: {} as never });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.name).toBe('next');
  });

  it('records all step numbers as they are called', async () => {
    const { generate, steps } = createStepwiseBlockingGenerate();
    void generate({ step: 0, conversation: {} as never, toolbox: {} as never });
    expect(steps).toContain(0);
  });

  it('step 1 blocks until releaseStep1 is called', async () => {
    const { generate, releaseStep1 } = createStepwiseBlockingGenerate();
    // Kick off step 1 (it blocks)
    const step1 = generate({ step: 1, conversation: {} as never, toolbox: {} as never });
    // Should still be pending — release it with the expected response
    releaseStep1({ content: 'released', toolCalls: [] });
    const result = await step1;
    expect(result.content).toBe('released');
  });

  it('step 1 resolves with aborted when the abort signal fires', async () => {
    const { generate } = createStepwiseBlockingGenerate();
    const controller = new AbortController();
    const step1 = generate({
      step: 1,
      conversation: {} as never,
      toolbox: {} as never,
      signal: controller.signal,
    });
    controller.abort();
    const result = await step1;
    expect(result.content).toBe('aborted');
  });

  it('steps >= 2 return immediately with a step-numbered marker', async () => {
    const { generate } = createStepwiseBlockingGenerate();
    const result = await generate({ step: 2, conversation: {} as never, toolbox: {} as never });
    expect(result.content).toBe('step 2');
    expect(result.toolCalls).toHaveLength(0);
  });
});
