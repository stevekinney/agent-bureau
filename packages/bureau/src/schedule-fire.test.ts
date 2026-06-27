import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { getMessages } from 'conversationalist';
import type { GenerateContext, GenerateFunction, Toolbox } from 'operative';
import { stopWhen } from 'operative';
import { z } from 'zod';

import { createBureau } from './create-bureau';

// ---------------------------------------------------------------------------
// D6 scheduled-fire E2E (#109)
//
// These are the assertions that were missing: every prior scheduling test only
// checked that a schedule was *registered*, never that a native timer tick
// actually *ran an agent*. Here we register a real weft schedule, let the engine
// poller fire it on real elapsed time, and assert an `agentRun` body executed
// with the right prompt and the right session semantics.
//
// TIMING: weft's scheduler poll interval defaults to 1000ms and there is no
// fake-timer path for `engine.schedule` ticks — the poller runs on real wall
// clock. So these tests use a real-time poll and a raised per-test timeout. This
// is real elapsed time, NOT a masked hang.
// ---------------------------------------------------------------------------

const FIRE_TIMEOUT_MS = 20_000;

/** Real-wall-clock poll — `engine.schedule` ticks fire on actual elapsed time. */
async function waitForReal(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

interface RecordedCall {
  conversationId: string;
  messageCount: number;
  roles: string[];
  userPrompts: string[];
  systemPrompts: string[];
}

/**
 * A generate that records what each fire's agent body saw (conversation id +
 * messages), then returns a final assistant turn so the run stops at step 0.
 */
function createRecordingGenerate(calls: RecordedCall[]): GenerateFunction {
  return async (context: GenerateContext) => {
    const messages = context.conversation.getMessages();
    calls.push({
      conversationId: context.conversation.current.id,
      messageCount: messages.length,
      roles: messages.map((message) => message.role),
      userPrompts: messages
        .filter((message) => message.role === 'user' && typeof message.content === 'string')
        .map((message) => message.content as string),
      systemPrompts: messages
        .filter((message) => message.role === 'system' && typeof message.content === 'string')
        .map((message) => message.content as string),
    });
    return { content: 'acknowledged', toolCalls: [] };
  };
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([], { context: {} }) as unknown as Toolbox;
}

describe('D6 scheduled-fire path (#109)', () => {
  it(
    'fires a stateless interval schedule and runs the agent with a fresh session per fire',
    async () => {
      const calls: RecordedCall[] = [];
      const bureau = await createBureau({
        generate: createRecordingGenerate(calls),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
        systemPrompt: 'You are a scheduled agent.',
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        // A bare duration shorthand ('1s') is registered as an interval
        // ({ every: '1s' }), not cron — see toScheduleSpec.
        const summary = await bureau.createSchedule({
          agentName: 'researcher',
          input: 'stateless tick prompt',
          spec: '1s',
        });
        expect(summary).toBeDefined();

        const fired = await waitForReal(() => calls.length >= 1, FIRE_TIMEOUT_MS);
        // Stop further fires before asserting so the count is stable.
        await bureau.cancelSchedule(summary!.id);

        expect(fired).toBe(true);
        // The agent body actually ran with the scheduled prompt.
        expect(calls[0]!.userPrompts).toContain('stateless tick prompt');
        // A fresh per-fire session still seeds the bureau systemPrompt, exactly as
        // a normal run into a new session does: [system, user].
        expect(calls[0]!.systemPrompts).toContain('You are a scheduled agent.');
        expect(calls[0]!.roles).toEqual(['system', 'user']);
        // Each stateless fire mints its own session id, so no two fires collide.
        const ids = calls.map((call) => call.conversationId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids[0]!.startsWith('sched-')).toBe(true);
      } finally {
        bureau.dispose();
      }
    },
    FIRE_TIMEOUT_MS,
  );

  it(
    'fires a recurring schedule into a fixed session and accumulates conversation across fires',
    async () => {
      const sessionId = 'daily-digest';
      const calls: RecordedCall[] = [];
      const bureau = await createBureau({
        generate: createRecordingGenerate(calls),
        toolbox: createEmptyToolbox(),
        storage: { type: 'memory' },
        durableExecution: true,
        systemPrompt: 'You are a scheduled agent.',
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        const summary = await bureau.createSchedule({
          agentName: 'researcher',
          input: 'digest prompt',
          spec: '1s',
          sessionId,
        });
        expect(summary).toBeDefined();

        const recurringCalls = () => calls.filter((call) => call.conversationId === sessionId);
        const firedTwice = await waitForReal(() => recurringCalls().length >= 2, FIRE_TIMEOUT_MS);
        await bureau.cancelSchedule(summary!.id);

        expect(firedTwice).toBe(true);

        // The FIRST fire into a not-yet-existing recurring session seeds the bureau
        // systemPrompt, exactly as a normal run into a new session does.
        const fires = recurringCalls();
        expect(fires[0]!.systemPrompts).toContain('You are a scheduled agent.');
        // Fire 2's agent body saw fire 1's turn — context accumulated, proving the
        // recurring (session-given) semantics, not a fresh session per fire.
        expect(fires[1]!.messageCount).toBeGreaterThan(fires[0]!.messageCount);

        // The durable proof: the session itself accumulated both fires' user turns,
        // and the systemPrompt was seeded ONCE (not re-appended on the second fire).
        const session = await bureau.getSession(sessionId);
        expect(session).not.toBeNull();
        const messages = getMessages(session!.conversationHistory);
        const userTurns = messages.filter((message) => message.role === 'user');
        expect(userTurns.length).toBeGreaterThanOrEqual(2);
        expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
      } finally {
        bureau.dispose();
      }
    },
    FIRE_TIMEOUT_MS,
  );

  it(
    'persists a fire that ends on maximum-steps (no final step) so the digest is not lost',
    async () => {
      // A generate that ALWAYS emits a tool call never satisfies noToolCalls, so the
      // fire runs until it exhausts maximumSteps — its last StepResult.final is
      // false. The session-persist hook must still save (it persists on every
      // completed step, not only the final one), or the fire vanishes from the
      // recurring digest (review: codex Mn69a).
      const sessionId = 'maxsteps-digest';
      const calls: RecordedCall[] = [];
      const recording = createRecordingGenerate(calls);
      const bureau = await createBureau({
        generate: async (context: GenerateContext) => {
          await recording(context);
          // Always call the tool → the run never stops on noToolCalls and instead
          // terminates on maximumSteps.
          return { content: '', toolCalls: [{ name: 'noop', arguments: {} }] };
        },
        toolbox: createToolbox([
          createTool({
            name: 'noop',
            description: 'no-op',
            input: z.object({}),
            execute: async () => 'ok',
          }),
        ]) as unknown as Toolbox,
        storage: { type: 'memory' },
        durableExecution: true,
        maximumSteps: 1,
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        const summary = await bureau.createSchedule({
          agentName: 'researcher',
          input: 'maxsteps prompt',
          spec: '1s',
          sessionId,
        });
        expect(summary).toBeDefined();

        // Wait for at least one fire to have run a step (it will hit maximum-steps).
        const fired = await waitForReal(
          () => calls.some((call) => call.conversationId === sessionId),
          FIRE_TIMEOUT_MS,
        );
        await bureau.cancelSchedule(summary!.id);
        expect(fired).toBe(true);

        // Despite the fire ending on maximum-steps (no final step), its transcript
        // was persisted to the session — the user turn is durably recorded.
        const session = await bureau.getSession(sessionId);
        expect(session).not.toBeNull();
        const userTurns = getMessages(session!.conversationHistory).filter(
          (message) => message.role === 'user',
        );
        expect(userTurns.some((message) => message.content === 'maxsteps prompt')).toBe(true);
      } finally {
        bureau.dispose();
      }
    },
    FIRE_TIMEOUT_MS,
  );
});
