/**
 * AB-359 — the LMDB variant of "bureau.eventHistory run ownership survives a
 * process restart" (the SQLite variant lives in `create-bureau.test.ts`,
 * alongside the rest of that suite's recovery tests).
 *
 * Split into its own file, rather than living alongside the SQLite variant,
 * so the real per-iteration poll delay it needs (LMDB completion-callback
 * starvation under a zero-delay macrotask loop — the same root cause
 * `src/test/harness-lmdb-isolation.test.ts`'s `waitForRunCompletion`
 * documents at length) scopes a `determinism-manifest.json` exemption to
 * only this one small file, not the whole `create-bureau.test.ts` suite —
 * exactly the split AB-332 already made for the identical LMDB symptom.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';

let recoveryDatabaseCounter = 0;

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

/**
 * A zero-delay macrotask poll starves LMDB's own async completion callbacks
 * under this suite's load — see this file's own doc comment. A bounded,
 * condition-checked poll with a real (tiny) per-iteration delay, never a
 * blind sleep-then-assume.
 */
async function pollUntilWithRealDelay(
  check: () => boolean | Promise<boolean>,
  attempts = 400,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

function recoveredToolCallId(page: { events: readonly { payload?: unknown }[] }): string {
  const payload = page.events[0]?.payload as
    { steps?: { toolCalls?: { id?: string }[] }[] } | undefined;
  const id = payload?.steps?.[0]?.toolCalls?.[0]?.id;
  if (typeof id !== 'string') throw new Error('recovered page carries no step-0 tool-call id');
  return id;
}

/**
 * The exact page bureau B must reconstruct: bureau A's durable step 0 plus
 * B's own step 1, so the step contents prove recovery resumed from A's saved
 * cursor rather than re-running from step 0. Only the emission time and the
 * generated tool-call id are left loose; the id is checked for internal
 * consistency by the caller.
 */
function expectedRecoveredPage(runId: string, toolCallId: string): unknown {
  const stepZero = {
    step: 0,
    content: 'A step 0',
    toolCalls: [{ id: toolCallId, name: 'next', arguments: {} }],
    results: [
      {
        callId: toolCallId,
        outcome: 'success',
        content: 'ok',
        toolCallId,
        toolName: 'next',
        result: 'ok',
        executedArgumentsEdited: false,
      },
    ],
    final: false,
  };
  const stepOne = {
    step: 1,
    content: 'B recovered step 1',
    toolCalls: [],
    results: [],
    metadata: { __bureauActiveSkills: { version: 2, entries: [] } },
    final: true,
  };
  const usage = { prompt: 0, completion: 0, total: 0 };
  return {
    events: [
      {
        kind: 'run.completed',
        owner: { kind: 'run', id: runId },
        sequence: 1,
        cursor: '1',
        emittedAtMs: expect.any(Number),
        schemaVersion: 1,
        payload: {
          isTrusted: false,
          result: {
            steps: [stepZero, stepOne],
            content: 'B recovered step 1',
            usage,
            finishReason: 'stop-condition',
          },
          steps: [stepZero, stepOne],
          content: 'B recovered step 1',
          usage,
          finishReason: 'stop-condition',
        },
      },
    ],
    hasMore: false,
    nextCursor: '1',
  };
}

describe('bureau.eventHistory run ownership survives a process restart over LMDB (AB-359)', () => {
  it('a run dispatched with a principal, recovered over LMDB in a fresh process, is readable by that principal and denied to another', async () => {
    const databasePath = join(
      tmpdir(),
      `bureau-event-history-owner-recovery-lmdb-${process.pid}-${recoveryDatabaseCounter++}`,
    );

    let bureauAReachedStep1 = false;
    const bureauA = await createBureau({
      agents: {},
      generate: async ({ step }) => {
        if (step === 0) {
          return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        bureauAReachedStep1 = true; // step 0's saveCursor has committed
        return new Promise<never>(() => {}); // the "process" dies here
      },
      toolbox: createToolbox([createNextTool()]),
      storage: { type: 'lmdb', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      stopWhen: stopWhen.noToolCalls(),
    });

    try {
      const run = await bureauA.createRun({
        message: 'Attribute me to alice across a restart',
        principal: 'alice',
      });
      await pollUntilWithRealDelay(() => bureauAReachedStep1);
      expect(bureauAReachedStep1).toBe(true);
      // AB-207: deliberately not disposing bureauA — simulates a real crash
      // (a genuinely non-terminal Weft workflow is what `recoverAll()` needs
      // to surface for `reattachRecoveredRun` to run at all).

      const bureauB = await createBureau({
        agents: {},
        generate: async ({ step }) => ({ content: `B recovered step ${step}`, toolCalls: [] }),
        toolbox: createToolbox([createNextTool()]),
        storage: { type: 'lmdb', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        stopWhen: stopWhen.noToolCalls(),
      });

      try {
        // `undefined` (not yet registered by `reattachRecoveredRun`) is NOT
        // a terminal status — keep polling for it exactly like `'running'`,
        // rather than a bare `!== 'running'` check that would read
        // "not yet recovered" as "already done" (copilot review, PR #564).
        await pollUntilWithRealDelay(() => {
          const status = bureauB.getRun(run.id)?.status;
          return status !== undefined && status !== 'running';
        });

        const recovered = bureauB.getRun(run.id);
        expect(recovered).toMatchObject({
          id: run.id,
          sessionId: run.sessionId,
          status: 'completed',
          principal: 'alice',
          steps: 1,
          finishReason: 'stop-condition',
          usage: { prompt: 0, completion: 0, total: 0 },
        });

        const asOwner = await bureauB.eventHistory(
          { kind: 'run', id: run.id },
          { principal: 'alice' },
        );
        if ('outcome' in asOwner) {
          throw new Error(
            `expected a page for the owning principal, got ${JSON.stringify(asOwner)}`,
          );
        }
        const toolCallId = recoveredToolCallId(asOwner);
        expect(toolCallId).toMatch(/^tool-call-/);
        expect(asOwner as unknown).toEqual(expectedRecoveredPage(run.id, toolCallId));

        const asStranger = await bureauB.eventHistory(
          { kind: 'run', id: run.id },
          { principal: 'mallory' },
        );
        expect(asStranger).toEqual({ outcome: 'not-found' });

        // A trusted caller that omits `principal` entirely still bypasses
        // the check, exactly as it does for a never-restarted run.
        const trusted = await bureauB.eventHistory({ kind: 'run', id: run.id });
        if ('outcome' in trusted) {
          throw new Error(`expected a page for a trusted caller, got ${JSON.stringify(trusted)}`);
        }
        expect(trusted as unknown).toEqual(expectedRecoveredPage(run.id, toolCallId));

        // A run id the recovered bureau never registered has no status;
        // a trusted caller reading it gets an empty page, not another run's
        // events.
        expect(bureauB.getRun('run-that-never-existed')).toBeUndefined();
        expect(await bureauB.eventHistory({ kind: 'run', id: 'run-that-never-existed' })).toEqual({
          events: [],
          hasMore: false,
        });
      } finally {
        bureauB.dispose();
      }
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { recursive: true, force: true });
    }
  });
});
