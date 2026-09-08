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

        const asOwner = await bureauB.eventHistory(
          { kind: 'run', id: run.id },
          { principal: 'alice' },
        );
        if ('outcome' in asOwner) {
          throw new Error(
            `expected a page for the owning principal, got ${JSON.stringify(asOwner)}`,
          );
        }
        expect(asOwner.events.map((event) => event.kind)).toContain('run.completed');

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
        expect(trusted.events.map((event) => event.kind)).toContain('run.completed');
      } finally {
        bureauB.dispose();
      }
      await bureauA.dispose();
    } finally {
      await rm(databasePath, { recursive: true, force: true });
    }
  });
});
