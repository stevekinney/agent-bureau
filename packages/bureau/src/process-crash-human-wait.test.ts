/**
 * COR-1409 — a run parked on `requestHumanInput` survives the real death of
 * the process that parked it, over both durable backends.
 *
 * The in-process human-wait recovery tests (`human-input.test.ts`,
 * `human-wait-replay-park.test.ts`) simulate the crash by never disposing the
 * first Bureau. That leaves a second live engine on the store, which is not a
 * crash and, over LMDB, is a race of its own (COR-118, COR-1408). Here the
 * child SIGKILLs itself once its park is durable, so the recoverer shares
 * nothing with it but the bytes it left on disk.
 *
 * The one real-time wait is the claim-lapse wait, derived from the claim TTL
 * exactly as `process-crash-recovery.test.ts` does. Every other wait is
 * `child.exited`, the marker file, or a bounded condition poll with a tiny real
 * delay, because LMDB's completion callbacks starve under a zero-delay loop.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import {
  CLAIM_TTL_MS,
  HUMAN_WAIT_PROMPT,
  HUMAN_WAIT_SIGNAL,
  createHarnessBureau,
} from './test/process-crash-work-integrity-fixtures';
import type { Bureau } from './types';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');

async function pollUntil(
  check: () => boolean | Promise<boolean>,
  attempts = 1000,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

describe.each(['sqlite', 'lmdb'] as const)(
  'a human-wait park survives SIGKILL over %s',
  (backend) => {
    it('surfaces the recovered review, waits on it, and resumes exactly once when it is approved', async () => {
      const directory = mkdtempSync(
        join(tmpdir(), `corvidae-process-crash-human-wait-${backend}-`),
      );
      const storagePath = join(directory, 'bureau');
      const markerPath = join(directory, 'marker.json');
      let recoverer: Bureau | undefined;

      try {
        // Premise: the child died from SIGKILL and left its marker.
        const child = Bun.spawn(
          ['bun', CHILD, 'human-wait-parked', backend, storagePath, markerPath],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        await child.exited;
        const stderr = await new Response(child.stderr).text();
        expect(child.signalCode ?? stderr).toBe('SIGKILL');
        expect(existsSync(markerPath)).toBe(true);
        const { runId } = JSON.parse(readFileSync(markerPath, 'utf8')) as { runId: string };

        // The dead holder's claim lapses on Weft's own wall clock.
        await new Promise((resolve) => setTimeout(resolve, CLAIM_TTL_MS * 10));

        let generateCalls = 0;
        recoverer = await createHarnessBureau({
          backend,
          storagePath,
          generate: async () => {
            generateCalls += 1;
            return { content: 'resumed after the crash', toolCalls: [] };
          },
          toolbox: createToolbox([]),
          humanInput: true,
        });
        const bureau = recoverer;
        const report = await bureau.waitForRecovery?.();
        if (report === undefined) throw new Error('waitForRecovery is unavailable');
        expect(report.outcome).toBe('clean');
        expect(report.perRunFailures).toEqual([]);

        const reviewsFor = () =>
          bureau.listPendingReviews().filter((review) => review.runId === runId);
        expect(await pollUntil(() => reviewsFor().length > 0)).toBe(true);
        expect(await pollUntil(() => bureau.getRun(runId)?.liveness.status === 'waiting')).toBe(
          true,
        );

        const reviews = reviewsFor();
        expect(reviews).toHaveLength(1);
        const [review] = reviews;
        if (review?.kind !== 'human-wait')
          throw new Error(`expected a human-wait review, got ${review?.kind}`);
        expect(review.signalName).toBe(HUMAN_WAIT_SIGNAL);
        expect(review.prompt).toBe(HUMAN_WAIT_PROMPT);
        const liveness = bureau.getRun(runId)?.liveness;
        expect(liveness?.declaredWait?.reason).toBe('review');
        expect(liveness?.declaredWait?.dependency).toBe(HUMAN_WAIT_SIGNAL);
        // The recovered run is parked, not looping: nothing generated before approval.
        expect(generateCalls).toBe(0);

        await bureau.resolveReview({ id: review.id, decision: 'approve', principal: 'operator' });

        expect(await pollUntil(() => bureau.getRun(runId)?.status === 'completed')).toBe(true);
        expect(generateCalls).toBe(1);
        expect(reviewsFor()).toHaveLength(0);
        expect(bureau.getRun(runId)?.liveness.declaredWait).toBeUndefined();
        expect(
          await pollUntil(async () => {
            const durableRun = await bureau.getDurableRun(runId);
            return durableRun?.status === 'completed';
          }),
        ).toBe(true);
      } finally {
        // allSettled never rejects, so the directory is always removed after shutdown.
        const reports = await Promise.allSettled(
          recoverer === undefined ? [] : [recoverer.shutdown()],
        );
        rmSync(directory, { recursive: true, force: true });
        for (const report of reports) {
          expect(report.status).toBe('fulfilled');
          if (report.status === 'fulfilled') expect(report.value.unresolved).toBe(0);
        }
      }
    }, 120_000);
  },
);
