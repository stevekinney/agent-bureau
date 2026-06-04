import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import type { AgentSession } from '../src/agent-session';
import { createAgentSession, saveAgentSession } from '../src/agent-session';
import { noToolCalls } from '../src/conditions/predicates';
import { defineAgent } from '../src/define-agent';
import type { GenerateResponse } from '../src/types';

/** In-memory text-value store for tests, backed by Weft's MemoryStorage. */
const createMockKeyValueStore = () => textValueStore(new MemoryStorage());

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [], usage: { prompt: 10, completion: 5, total: 15 } };
}

describe('session lifecycle via defineAgent', () => {
  it('onSessionLoad fires when session is loaded', async () => {
    const store = createMockKeyValueStore();
    const history = createConversationHistory({ id: 'session-1' });
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: history,
      id: 'session-1',
      metadata: { loaded: true },
    });
    await saveAgentSession(store, session);

    const loadedSessions: AgentSession[] = [];

    const agent = defineAgent({
      name: 'test-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      sessionId: 'session-1',
      onSessionLoad: (loaded) => {
        loadedSessions.push(loaded);
      },
    });

    await agent.run('Hello');

    expect(loadedSessions).toHaveLength(1);
    expect(loadedSessions[0]!.id).toBe('session-1');
    expect(loadedSessions[0]!.agentName).toBe('test-agent');
  });

  it('onSessionSave fires on completion', async () => {
    const store = createMockKeyValueStore();
    const savedSessions: AgentSession[] = [];

    const agent = defineAgent({
      name: 'save-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      onSessionSave: (saved) => {
        savedSessions.push(saved);
      },
    });

    await agent.run('Hello');

    expect(savedSessions).toHaveLength(1);
    expect(savedSessions[0]!.agentName).toBe('save-agent');
  });

  it('autoSave: completion saves after run', async () => {
    const store = createMockKeyValueStore();

    const agent = defineAgent({
      name: 'completion-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      sessionId: 'completion-session',
      autoSave: 'completion',
    });

    await agent.run('Hello');

    const keys = await store.list('agent-session:');
    expect(keys.length).toBeGreaterThan(0);
  });

  it('autoSave: false does not save', async () => {
    const store = createMockKeyValueStore();

    const agent = defineAgent({
      name: 'no-save-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      autoSave: false,
    });

    await agent.run('Hello');

    const keys = await store.list('agent-session:');
    expect(keys).toHaveLength(0);
  });

  it('autoSave: step saves after each step', async () => {
    const store = createMockKeyValueStore();
    const savedSessions: AgentSession[] = [];
    let callCount = 0;

    const agent = defineAgent({
      name: 'step-agent',
      generate: async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            content: `step ${callCount}`,
            toolCalls: [{ name: 'mock', arguments: {} }],
            usage: { prompt: 10, completion: 5, total: 15 },
          };
        }
        return textResponse('final');
      },
      toolbox: createTestToolbox([
        {
          name: 'mock',
          description: 'A mock tool',
          input: {},
          execute: async () => 'ok',
        },
      ]),
      stopWhen: noToolCalls(),
      persistence: store,
      autoSave: 'step',
      onSessionSave: (saved) => {
        savedSessions.push(saved);
      },
    });

    await agent.run('Hello');

    // Each step triggers a save via onStep
    expect(savedSessions.length).toBeGreaterThanOrEqual(3);
  });

  it('session.loaded and session.saved events are emitted via createRun result', async () => {
    const store = createMockKeyValueStore();
    const history = createConversationHistory({ id: 'event-session' });
    const session = createAgentSession({
      agentName: 'event-agent',
      conversationHistory: history,
      id: 'event-session',
    });
    await saveAgentSession(store, session);

    const loadedSessions: AgentSession[] = [];
    const savedSessions: AgentSession[] = [];

    const agent = defineAgent({
      name: 'event-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      sessionId: 'event-session',
      onSessionLoad: (loaded) => {
        loadedSessions.push(loaded);
      },
      onSessionSave: (saved) => {
        savedSessions.push(saved);
      },
    });

    const activeRun = agent.createRun('Hello');
    await activeRun.result;

    expect(loadedSessions).toHaveLength(1);
    expect(savedSessions).toHaveLength(1);
  });

  it('error propagation from lifecycle hooks', async () => {
    const store = createMockKeyValueStore();
    const history = createConversationHistory({ id: 'error-session' });
    const session = createAgentSession({
      agentName: 'error-agent',
      conversationHistory: history,
      id: 'error-session',
    });
    await saveAgentSession(store, session);

    const agent = defineAgent({
      name: 'error-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      sessionId: 'error-session',
      onSessionLoad: () => {
        throw new Error('Load hook error');
      },
    });

    await expect(agent.run('Hello')).rejects.toThrow('Load hook error');
  });

  it('createRun without sessionId still saves on completion when persistence is provided', async () => {
    const store = createMockKeyValueStore();
    const savedSessions: AgentSession[] = [];

    const agent = defineAgent({
      name: 'no-id-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      onSessionSave: (saved) => {
        savedSessions.push(saved);
      },
    });

    const activeRun = agent.createRun('Hello');
    await activeRun.result;

    expect(savedSessions).toHaveLength(1);
    expect(savedSessions[0]!.agentName).toBe('no-id-agent');
  });

  it('run loads existing session and uses its conversation history', async () => {
    const store = createMockKeyValueStore();
    const history = createConversationHistory({ id: 'reuse-session' });

    const session = createAgentSession({
      agentName: 'reuse-agent',
      conversationHistory: history,
      id: 'reuse-session',
      metadata: { resuming: true },
    });
    await saveAgentSession(store, session);

    let loadedSession: AgentSession | undefined;
    const agent = defineAgent({
      name: 'reuse-agent',
      generate: async () => textResponse('resumed'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      sessionId: 'reuse-session',
      onSessionLoad: (loaded) => {
        loadedSession = loaded;
      },
    });

    const result = await agent.run('Continue');

    expect(loadedSession).toBeDefined();
    expect(loadedSession!.metadata).toEqual({ resuming: true });
    expect(result.content).toBe('resumed');
  });

  it('auto-save errors do not crash the run', async () => {
    const store = createMockKeyValueStore();

    const agent = defineAgent({
      name: 'save-error-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      onSessionSave: () => {
        throw new Error('Save hook error');
      },
    });

    const result = await agent.run('Hello');
    expect(result.finishReason).toBe('stop-condition');
  });

  it('createRun auto-save errors do not crash the run', async () => {
    const store = createMockKeyValueStore();

    const agent = defineAgent({
      name: 'save-error-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      onSessionSave: () => {
        throw new Error('Save hook error in createRun');
      },
    });

    const activeRun = agent.createRun('Hello');
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
  });

  it('createRun error propagation from onSessionLoad hook', async () => {
    const store = createMockKeyValueStore();
    const history = createConversationHistory({ id: 'load-error-session' });
    const session = createAgentSession({
      agentName: 'load-error-agent',
      conversationHistory: history,
      id: 'load-error-session',
    });
    await saveAgentSession(store, session);

    const agent = defineAgent({
      name: 'load-error-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      sessionId: 'load-error-session',
      onSessionLoad: () => {
        throw new Error('Load hook error in createRun');
      },
    });

    const activeRun = agent.createRun('Hello');
    await expect(activeRun.result).rejects.toThrow('Load hook error in createRun');
  });

  it('autoSave defaults to completion when not specified', async () => {
    const store = createMockKeyValueStore();
    const savedSessions: AgentSession[] = [];

    const agent = defineAgent({
      name: 'default-save-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      onSessionSave: (saved) => {
        savedSessions.push(saved);
      },
    });

    await agent.run('Hello');

    expect(savedSessions).toHaveLength(1);
  });

  it('autoSave: step via createRun saves after each step', async () => {
    const store = createMockKeyValueStore();
    const savedSessions: AgentSession[] = [];
    let callCount = 0;

    const agent = defineAgent({
      name: 'step-create-run-agent',
      generate: async () => {
        callCount++;
        if (callCount <= 1) {
          return {
            content: `step ${callCount}`,
            toolCalls: [{ name: 'mock', arguments: {} }],
            usage: { prompt: 10, completion: 5, total: 15 },
          };
        }
        return textResponse('final');
      },
      toolbox: createTestToolbox([
        {
          name: 'mock',
          description: 'A mock tool',
          input: {},
          execute: async () => 'ok',
        },
      ]),
      stopWhen: noToolCalls(),
      persistence: store,
      autoSave: 'step',
      onSessionSave: (saved) => {
        savedSessions.push(saved);
      },
    });

    const activeRun = agent.createRun('Hello');
    await activeRun.result;

    expect(savedSessions.length).toBeGreaterThanOrEqual(2);
  });

  it('createRun with sessionId and autoSave: false does not save', async () => {
    const store = createMockKeyValueStore();
    const history = createConversationHistory({ id: 'no-save-cr' });
    const session = createAgentSession({
      agentName: 'no-save-cr-agent',
      conversationHistory: history,
      id: 'no-save-cr',
    });
    await saveAgentSession(store, session);

    const savedSessions: AgentSession[] = [];
    const loadedSessions: AgentSession[] = [];

    const agent = defineAgent({
      name: 'no-save-cr-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      sessionId: 'no-save-cr',
      autoSave: false,
      onSessionLoad: (loaded) => {
        loadedSessions.push(loaded);
      },
      onSessionSave: (saved) => {
        savedSessions.push(saved);
      },
    });

    const activeRun = agent.createRun('Hello');
    await activeRun.result;

    // Session was loaded but not saved
    expect(loadedSessions).toHaveLength(1);
    expect(savedSessions).toHaveLength(0);
  });

  it('autoSave: step preserves existing onStep hook in run()', async () => {
    const store = createMockKeyValueStore();
    const stepLog: number[] = [];
    let callCount = 0;

    const agent = defineAgent({
      name: 'step-with-hook-agent',
      generate: async () => {
        callCount++;
        if (callCount <= 1) {
          return {
            content: `step ${callCount}`,
            toolCalls: [{ name: 'mock', arguments: {} }],
            usage: { prompt: 10, completion: 5, total: 15 },
          };
        }
        return textResponse('final');
      },
      toolbox: createTestToolbox([
        {
          name: 'mock',
          description: 'A mock tool',
          input: {},
          execute: async () => 'ok',
        },
      ]),
      stopWhen: noToolCalls(),
      persistence: store,
      autoSave: 'step',
      onStep: async (stepResult) => {
        stepLog.push(stepResult.step);
      },
    });

    await agent.run('Hello');

    expect(stepLog.length).toBeGreaterThanOrEqual(2);
  });

  it('autoSave: step preserves existing onStep hook in createRun()', async () => {
    const store = createMockKeyValueStore();
    const stepLog: number[] = [];
    let callCount = 0;

    const agent = defineAgent({
      name: 'step-hook-create-run-agent',
      generate: async () => {
        callCount++;
        if (callCount <= 1) {
          return {
            content: `step ${callCount}`,
            toolCalls: [{ name: 'mock', arguments: {} }],
            usage: { prompt: 10, completion: 5, total: 15 },
          };
        }
        return textResponse('final');
      },
      toolbox: createTestToolbox([
        {
          name: 'mock',
          description: 'A mock tool',
          input: {},
          execute: async () => 'ok',
        },
      ]),
      stopWhen: noToolCalls(),
      persistence: store,
      autoSave: 'step',
      onStep: async (stepResult) => {
        stepLog.push(stepResult.step);
      },
    });

    const activeRun = agent.createRun('Hello');
    await activeRun.result;

    expect(stepLog.length).toBeGreaterThanOrEqual(2);
  });

  it('createRun with sessionId but no existing session creates a new session on completion', async () => {
    const store = createMockKeyValueStore();
    const savedSessions: AgentSession[] = [];

    const agent = defineAgent({
      name: 'new-session-agent',
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      stopWhen: noToolCalls(),
      persistence: store,
      sessionId: 'new-session-id',
      onSessionSave: (saved) => {
        savedSessions.push(saved);
      },
    });

    const activeRun = agent.createRun('Hello');
    await activeRun.result;

    expect(savedSessions).toHaveLength(1);
    expect(savedSessions[0]!.agentName).toBe('new-session-agent');
  });
});
