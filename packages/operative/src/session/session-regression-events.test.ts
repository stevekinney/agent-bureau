import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { createAgentSession } from '../agent-session';
import { createCheckpointStore } from '../durable/checkpoint-store';
import { createRunEngine } from '../durable/create-run-engine';
import { ToolStartedBubbleEvent } from '../events';
import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import {
  createTestRunOptions,
  fixtureRuntime,
  makeParkingWorkflow,
} from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('regression — tool events and recovered terminal state', () => {
  it('stamps tool.started with the derived sessionId:sequence runId on the in-memory path', async () => {
    // Use an echo tool so the generate can trigger a tool call.
    const echoTool = createTool({
      name: 'echo',
      description: 'Echo the input',
      input: z.object({ message: z.string() }),
      execute: async ({ message }: { message: string }) => message,
    });

    // Two-step generate: first step triggers the tool call, second step returns
    // text so maximumSteps:2 lets the loop finish naturally.
    let step = 0;
    const generate: GenerateFunction = async () => {
      step += 1;
      if (step === 1) {
        return { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'hello' } }] };
      }
      return { content: 'done', toolCalls: [] };
    };

    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const sessionId = 'tool-runid-session';

    const h = createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      // No engine/checkpointStore → forces the in-memory createActiveRun path.
      runOptions: {
        generate,
        toolbox: createToolbox([echoTool]),
        maximumSteps: 2,
      },
    });

    const started: ToolStartedBubbleEvent[] = [];
    const agentRun = h.run('say hello');

    // Collect tool.started events via the async iterator while the run is in-flight.
    const collectEvents = async () => {
      for await (const event of agentRun) {
        if (event.type === 'tool.started') {
          if (!(event instanceof ToolStartedBubbleEvent))
            throw new TypeError('Expected tool.started event');
          started.push(event);
        }
      }
    };
    await Promise.all([agentRun.result(), collectEvents()]);

    // The first run in the session has sequence 0, so its runId is sessionId:0.
    expect(started).toHaveLength(1);
    expect(started[0]?.runId).toBe(`${sessionId}:0`);
    expect(started[0]?.agentName).toBe('test-agent');
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MZozh — recover() persists terminal state
// ---------------------------------------------------------------------------

describe('regression: recover() persists terminal state after recovered run settles (PRRT_kwDORvupsc6MZozh)', () => {
  it('updates the session store from running to completed after a recovered durable run settles', async () => {
    // Mirrors the D2 acceptance test but adds a store-state assertion AFTER the
    // recovered run completes, proving the RunRef transitions from 'running' →
    // 'completed' and conversation history is updated.
    const SLEEP_MS = 50;
    const storage = new MemoryStorage();
    const sessionId = 'recover-persist-session';
    const runId = `${sessionId}:0`;

    // --- First "process" ---
    const firstKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const firstStore = createSessionStore(firstKv);

    const { engine: engine1 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: false,
    });

    // Persist the session with a 'running' run ref (mimics what run() does).
    const session = createAgentSession({
      agentName: 'agent',
      conversationHistory: createConversationHistory(),
      id: sessionId,
      runs: [
        {
          runId,
          sequence: 0,
          status: 'running',
          startedAt: fixtureRuntime.clock.nowISO(),
          agentName: 'agent',
        },
      ],
    });
    await firstStore.save(session);

    // Start the durable workflow and let it park on ctx.sleep.
    const firstHandle = await engine1.start('agentRun', {}, { id: runId });
    for (let i = 0; i < 10; i++) {
      await yieldToPortableEventLoop();
    }
    // "Crash" — dispose the first engine.
    engine1[Symbol.dispose]();
    void firstHandle.result().catch(() => {});

    // --- Second "process" (restart) ---
    const secondKv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const secondStore = createSessionStore(secondKv);
    const secondCheckpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );

    const { engine: engine2 } = await createRunEngine({
      storage,
      runWorkflow: makeParkingWorkflow(SLEEP_MS),
      recover: false,
      startScheduler: true, // fires the ctx.sleep timer
    });

    try {
      await engine2.recoverAll();

      const h = createSessionHandle(sessionId, {
        store: secondStore,
        agentName: 'agent',
        engine: engine2,
        checkpointStore: secondCheckpointStore,
        runOptions: createTestRunOptions(),
      });

      const reattached = await h.recover();
      expect(reattached).not.toBeNull();

      // Await the recovered run so we know the settle handler has fired.
      await reattached!.result();
      // Give the async settle handler a tick to complete the store.save.
      await yieldToPortableEventLoop();

      // The persisted RunRef must have transitioned to a terminal status.
      const storedSession = await secondStore.load(sessionId);
      expect(storedSession).not.toBeNull();
      const storedRun = storedSession!.runs[0];
      expect(storedRun?.status).not.toBe('running');
      // The parking workflow returns finishReason:'stop-condition' → 'completed'.
      expect(storedRun?.status).toBe('completed');
    } finally {
      engine2[Symbol.dispose]();
    }
  });
});
