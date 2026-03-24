import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createRun, type GenerateResponse, stopWhen } from 'operative';
import { createMockGenerate } from 'operative/test';
import { z } from 'zod';

import { createStore } from '../src/store';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function createActiveRun(responses: GenerateResponse[] = [textResponse('response')]) {
  const toolbox = createTestToolbox([weatherTool]);
  const conversation = new Conversation();
  conversation.appendUserMessage('test');
  const generate = createMockGenerate(responses);
  return createRun({ generate, toolbox, conversation, stopWhen: stopWhen.noToolCalls() });
}

describe('run lifecycle and cleanup', () => {
  describe('completed runs', () => {
    it('sets status to completed after a successful run', async () => {
      const store = createStore();
      const activeRun = createActiveRun([textResponse('done')]);
      const id = store.register(activeRun);

      await activeRun.result;

      const run = store.getRun(id);
      expect(run).toBeDefined();
      expect(run!.status).toBe('completed');

      store.dispose();
    });

    it('captures finishReason from the run result', async () => {
      const store = createStore();
      const activeRun = createActiveRun([textResponse('done')]);
      const id = store.register(activeRun);

      await activeRun.result;

      const run = store.getRun(id);
      expect(run!.finishReason).toBe('stop-condition');

      store.dispose();
    });

    it('remains in state after completion and is not removed', async () => {
      const store = createStore();
      const activeRun = createActiveRun([textResponse('done')]);
      const id = store.register(activeRun);

      await activeRun.result;

      expect(store.getState().runs.has(id)).toBe(true);
      expect(store.getState().runs.size).toBe(1);

      const run = store.getRun(id);
      expect(run!.status).toBe('completed');
      expect(run!.id).toBe(id);

      store.dispose();
    });

    it('captures steps and snapshots for completed runs', async () => {
      const store = createStore();
      const activeRun = createActiveRun([
        toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
        textResponse('The weather is 72F'),
      ]);
      const id = store.register(activeRun);

      await activeRun.result;

      const run = store.getRun(id);
      expect(run!.status).toBe('completed');
      expect(run!.steps.length).toBeGreaterThan(0);
      expect(run!.snapshots.length).toBeGreaterThan(0);

      store.dispose();
    });
  });

  describe('error runs', () => {
    it('sets status to error when generate throws', async () => {
      const store = createStore();
      const failingGenerate = async () => {
        throw new Error('test error');
      };

      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      const activeRun = createRun({
        generate: failingGenerate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });
      const id = store.register(activeRun);

      await activeRun.result;

      const run = store.getRun(id);
      expect(run).toBeDefined();
      expect(run!.status).toBe('error');

      store.dispose();
    });

    it('captures the error from the run.error event', async () => {
      const store = createStore();
      const failingGenerate = async () => {
        throw new Error('something went wrong');
      };

      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      const activeRun = createRun({
        generate: failingGenerate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });
      const id = store.register(activeRun);

      await activeRun.result;

      const run = store.getRun(id);
      expect(run!.status).toBe('error');
      expect(run!.error).toBeInstanceOf(Error);
      expect((run!.error as Error).message).toBe('something went wrong');

      store.dispose();
    });

    it('error runs remain in state and are not removed', async () => {
      const store = createStore();
      const failingGenerate = async () => {
        throw new Error('test error');
      };

      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      const activeRun = createRun({
        generate: failingGenerate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });
      const id = store.register(activeRun);

      await activeRun.result;

      expect(store.getState().runs.has(id)).toBe(true);
      expect(store.getRun(id)!.status).toBe('error');

      store.dispose();
    });

    it('records a run.error action in the action log', async () => {
      const store = createStore();
      const failingGenerate = async () => {
        throw new Error('tracked error');
      };

      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      const activeRun = createRun({
        generate: failingGenerate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });
      const id = store.register(activeRun);

      await activeRun.result;

      const run = store.getRun(id);
      const errorActions = run!.actions.filter((action) => action.type === 'run.error');
      expect(errorActions.length).toBe(1);
      expect((errorActions[0].detail as { error: Error }).error.message).toBe('tracked error');

      store.dispose();
    });
  });

  describe('aborted runs', () => {
    it('sets status to aborted when the run is aborted', async () => {
      const store = createStore();
      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      const generate = createMockGenerate([
        toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
        toolCallResponse([{ name: 'get_weather', arguments: { location: 'Seattle' } }]),
        textResponse('Done'),
      ]);

      const activeRun = createRun({
        generate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
        onStep: async ({ step }) => {
          if (step === 0) {
            activeRun.abort('user cancelled');
          }
        },
      });
      const id = store.register(activeRun);

      await activeRun.result;

      const run = store.getRun(id);
      expect(run).toBeDefined();
      expect(run!.status).toBe('aborted');

      store.dispose();
    });

    it('aborted runs remain in state and are not removed', async () => {
      const store = createStore();
      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      const generate = createMockGenerate([
        toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
        textResponse('Done'),
      ]);

      const activeRun = createRun({
        generate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
        onStep: async () => {
          activeRun.abort('cancelled');
        },
      });
      const id = store.register(activeRun);

      await activeRun.result;

      expect(store.getState().runs.has(id)).toBe(true);
      expect(store.getRun(id)!.status).toBe('aborted');

      store.dispose();
    });

    it('records a run.aborted action in the action log', async () => {
      const store = createStore();
      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      const generate = createMockGenerate([
        toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]),
        textResponse('Done'),
      ]);

      const activeRun = createRun({
        generate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
        onStep: async () => {
          activeRun.abort('test abort');
        },
      });
      const id = store.register(activeRun);

      await activeRun.result;

      const run = store.getRun(id);
      const abortedActions = run!.actions.filter((action) => action.type === 'run.aborted');
      expect(abortedActions.length).toBe(1);

      store.dispose();
    });
  });

  describe('deregister', () => {
    it('preserves final state after deregistering a completed run', async () => {
      const store = createStore();
      const activeRun = createActiveRun([textResponse('preserved')]);
      const id = store.register(activeRun);

      await activeRun.result;

      const runBeforeDeregister = store.getRun(id);
      expect(runBeforeDeregister!.status).toBe('completed');

      store.deregister(id);

      const runAfterDeregister = store.getRun(id);
      expect(runAfterDeregister).toBeDefined();
      expect(runAfterDeregister!.status).toBe('completed');
      expect(runAfterDeregister!.id).toBe(id);

      store.dispose();
    });

    it('preserves final state after deregistering an error run', async () => {
      const store = createStore();
      const failingGenerate = async () => {
        throw new Error('preserved error');
      };

      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      const activeRun = createRun({
        generate: failingGenerate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });
      const id = store.register(activeRun);

      await activeRun.result;

      store.deregister(id);

      const run = store.getRun(id);
      expect(run).toBeDefined();
      expect(run!.status).toBe('error');
      expect(run!.error).toBeInstanceOf(Error);

      store.dispose();
    });

    it('is a no-op when called with an unknown id', () => {
      const store = createStore();

      expect(() => store.deregister('nonexistent-id')).not.toThrow();

      store.dispose();
    });

    it('is a no-op when called twice on the same id', async () => {
      const store = createStore();
      const activeRun = createActiveRun([textResponse('done')]);
      const id = store.register(activeRun);

      await activeRun.result;

      store.deregister(id);
      expect(() => store.deregister(id)).not.toThrow();

      const run = store.getRun(id);
      expect(run).toBeDefined();
      expect(run!.status).toBe('completed');

      store.dispose();
    });

    it('stops recording new events from the observable after deregister', async () => {
      const store = createStore();
      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      // Use a slow generate so we can deregister mid-run
      let step = 0;
      const generate = async () => {
        const current = step++;
        if (current === 0) {
          return toolCallResponse([{ name: 'get_weather', arguments: { location: 'Denver' } }]);
        }
        // Small delay to allow deregister to take effect
        await Bun.sleep(50);
        return textResponse('final');
      };

      const activeRun = createRun({
        generate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });
      const id = store.register(activeRun);

      // Wait for the first step to complete, then deregister
      await new Promise<void>((resolve) => {
        store.subscribe((_state, action) => {
          if (action.runId === id && action.type === 'step.completed') {
            store.deregister(id);
            resolve();
          }
        });
      });

      const actionsAtDeregister = store.getRun(id)!.actions.length;

      await activeRun.result;

      // After deregister, new events should not have been recorded
      const actionsAfterResult = store.getRun(id)!.actions.length;
      expect(actionsAfterResult).toBe(actionsAtDeregister);

      store.dispose();
    });
  });

  describe('dispose', () => {
    it('prevents new events from being recorded for previously registered runs', async () => {
      const store = createStore();
      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');

      // Use a slow generate so the loop doesn't complete before dispose
      const generate = async () => {
        await Bun.sleep(50);
        return textResponse('after dispose');
      };

      const activeRun = createRun({
        generate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });
      const id = store.register(activeRun);

      // Dispose immediately, before the microtask-deferred loop starts
      store.dispose();

      await activeRun.result;

      const run = store.getRun(id);
      expect(run).toBeDefined();
      // The run state should still be at its initial 'running' status
      // because dispose() unsubscribed before any events were recorded
      expect(run!.status).toBe('running');

      // No actions should have been recorded after dispose
      expect(run!.actions).toHaveLength(0);
    });

    it('clears all store listeners so they receive no further notifications', async () => {
      const store = createStore();
      const received: string[] = [];

      store.subscribe((_state, action) => {
        received.push(action.type);
      });

      const activeRunA = createActiveRun([textResponse('first')]);
      store.register(activeRunA);
      await activeRunA.result;

      const countBeforeDispose = received.length;
      expect(countBeforeDispose).toBeGreaterThan(0);

      store.dispose();

      // Register a new run after dispose -- listeners should not fire
      const activeRunB = createActiveRun([textResponse('second')]);
      store.register(activeRunB);
      await activeRunB.result;

      expect(received.length).toBe(countBeforeDispose);

      store.dispose();
    });

    it('does not throw when called multiple times', () => {
      const store = createStore();

      expect(() => {
        store.dispose();
        store.dispose();
      }).not.toThrow();
    });

    it('preserves existing run state snapshots after dispose', async () => {
      const store = createStore();
      const activeRun = createActiveRun([textResponse('preserved')]);
      const id = store.register(activeRun);

      await activeRun.result;

      const runBeforeDispose = store.getRun(id);
      expect(runBeforeDispose!.status).toBe('completed');
      const actionCount = runBeforeDispose!.actions.length;

      store.dispose();

      // Run state is still accessible after dispose
      const runAfterDispose = store.getRun(id);
      expect(runAfterDispose).toBeDefined();
      expect(runAfterDispose!.status).toBe('completed');
      expect(runAfterDispose!.actions.length).toBe(actionCount);
    });
  });

  describe('removeRun', () => {
    it('removes a completed run from the runs map', async () => {
      const store = createStore();
      const activeRun = createActiveRun([textResponse('done')]);
      const id = store.register(activeRun);

      await activeRun.result;

      expect(store.getRun(id)).toBeDefined();
      expect(store.getRun(id)!.status).toBe('completed');

      store.removeRun(id);

      expect(store.getRun(id)).toBeUndefined();
      expect(store.getState().runs.has(id)).toBe(false);

      store.dispose();
    });

    it('deregisters the subscription before removing the run', async () => {
      const store = createStore();
      const activeRun = createActiveRun([textResponse('done')]);
      const id = store.register(activeRun);

      await activeRun.result;

      const actionsBeforeRemove = store.getRun(id)!.actions.length;
      expect(actionsBeforeRemove).toBeGreaterThan(0);

      store.removeRun(id);

      // Run is gone from the map
      expect(store.getRun(id)).toBeUndefined();

      store.dispose();
    });

    it('is a no-op when called with an unknown id', () => {
      const store = createStore();

      expect(() => store.removeRun('nonexistent')).not.toThrow();

      store.dispose();
    });

    it('does not affect other runs when one is removed', async () => {
      const store = createStore();
      const activeRunA = createActiveRun([textResponse('A')]);
      const activeRunB = createActiveRun([textResponse('B')]);

      const idA = store.register(activeRunA);
      const idB = store.register(activeRunB);

      await Promise.all([activeRunA.result, activeRunB.result]);

      store.removeRun(idA);

      expect(store.getRun(idA)).toBeUndefined();
      expect(store.getRun(idB)).toBeDefined();
      expect(store.getRun(idB)!.status).toBe('completed');

      store.dispose();
    });
  });

  describe('mixed lifecycle scenarios', () => {
    it('tracks completed and error runs concurrently in the same store', async () => {
      const store = createStore();

      const successRun = createActiveRun([textResponse('success')]);
      const successId = store.register(successRun);

      const failingGenerate = async () => {
        throw new Error('failure');
      };
      const toolbox = createTestToolbox([weatherTool]);
      const conversation = new Conversation();
      conversation.appendUserMessage('test');
      const failureRun = createRun({
        generate: failingGenerate,
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });
      const failureId = store.register(failureRun);

      await Promise.all([successRun.result, failureRun.result]);

      expect(store.getState().runs.size).toBe(2);
      expect(store.getRun(successId)!.status).toBe('completed');
      expect(store.getRun(failureId)!.status).toBe('error');

      store.dispose();
    });

    it('deregistering one run does not affect other runs', async () => {
      const store = createStore();

      const activeRunA = createActiveRun([textResponse('run A')]);
      const activeRunB = createActiveRun([textResponse('run B')]);

      const idA = store.register(activeRunA);
      const idB = store.register(activeRunB);

      await Promise.all([activeRunA.result, activeRunB.result]);

      store.deregister(idA);

      // Run A should still be in state
      expect(store.getRun(idA)).toBeDefined();
      expect(store.getRun(idA)!.status).toBe('completed');

      // Run B should be unaffected
      expect(store.getRun(idB)).toBeDefined();
      expect(store.getRun(idB)!.status).toBe('completed');

      store.dispose();
    });
  });
});
