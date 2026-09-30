/**
 * COR-1390 — a durable run survives the real death of the process that owned
 * it, recovers in exactly one of two racing successors, and keeps its event
 * streams continuous.
 *
 * A child process runs a durable Bureau under `workflow-lease` ownership,
 * commits step 0, records what it observed, and SIGKILLs itself. This test
 * then boots two fresh Bureaus (B and C) over the same storage at once.
 *
 * The one real-time wait is the claim-lapse wait: Weft's claim clock is not
 * injectable through `createRunEngine`, so it is derived from the claim TTL
 * exactly as `create-run-engine-crash-and-adopt.test.ts` does. Every other
 * wait is `child.exited`, the marker file, or a bounded condition poll. The
 * poll carries a tiny real delay because LMDB's completion callbacks starve
 * under a zero-delay macrotask loop (see
 * `event-history-run-ownership-recovery-lmdb.test.ts`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import type { Bureau } from './types';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');

/** Must match the constants in `test/process-crash-child.ts`. */
const CLAIM_TTL_MS = 200;
const CLAIM_RENEW_MS = 50;

interface CrashMarker {
  readonly runId: string;
  readonly sessionId: string;
  readonly maxAuditSequence: number;
  readonly sessionCursor: string;
  readonly sessionLastSequence: number;
}

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

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

interface Racer {
  readonly bureau: Bureau;
  readonly stepsAtOrAfterOne: () => number;
  readonly stepZeroCalls: () => number;
}

async function startRacer(backend: 'sqlite' | 'lmdb', storagePath: string): Promise<Racer> {
  let stepsAtOrAfterOne = 0;
  let stepZeroCalls = 0;
  const bureau = await createBureau({
    agents: {},
    generate: async ({ step }) => {
      if (step === 0) stepZeroCalls += 1;
      else stepsAtOrAfterOne += 1;
      return { content: `recovered step ${step}`, toolCalls: [] };
    },
    toolbox: createToolbox([createNextTool()]),
    storage: { type: backend, path: storagePath },
    durableExecution: true,
    stopWhen: stopWhen.noToolCalls(),
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });
  return {
    bureau,
    stepsAtOrAfterOne: () => stepsAtOrAfterOne,
    stepZeroCalls: () => stepZeroCalls,
  };
}

function stepIndexOf(detail: unknown): number {
  const step = (detail as { step?: unknown } | null)?.step;
  if (typeof step !== 'number') {
    throw new Error(`step.completed detail carries no numeric step: ${JSON.stringify(detail)}`);
  }
  return step;
}

describe.each(['sqlite', 'lmdb'] as const)('process crash recovery over %s', (backend) => {
  it('recovers in exactly one racer, fences the other, and keeps event streams continuous', async () => {
    const directory = mkdtempSync(join(tmpdir(), `corvidae-process-crash-${backend}-`));
    const storagePath = join(directory, 'bureau');
    const markerPath = join(directory, 'marker.json');
    const racers: Racer[] = [];

    try {
      // Premise: the child died from SIGKILL and left its marker.
      const child = Bun.spawn(
        ['bun', CHILD, 'park-after-step-0', backend, storagePath, markerPath],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      await child.exited;
      const crashedAt = Date.now();
      const stderr = await new Response(child.stderr).text();
      expect(child.signalCode ?? stderr).toBe('SIGKILL');
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as CrashMarker;
      expect(typeof marker.maxAuditSequence).toBe('number');
      expect(typeof marker.sessionLastSequence).toBe('number');

      // The dead holder's claim lapses on Weft's own wall clock.
      await new Promise((resolve) => setTimeout(resolve, CLAIM_TTL_MS * 10));

      const started = await Promise.allSettled([
        startRacer(backend, storagePath),
        startRacer(backend, storagePath),
      ]);
      for (const outcome of started) {
        if (outcome.status === 'fulfilled') racers.push(outcome.value);
      }
      for (const outcome of started) {
        if (outcome.status === 'rejected') throw outcome.reason;
      }
      const [b, c] = racers as [Racer, Racer];

      for (const racer of racers) {
        const report = await racer.bureau.waitForRecovery?.();
        if (report === undefined) throw new Error('waitForRecovery is unavailable');
        expect(report.outcome).toBe('clean');
        expect(report.perRunFailures).toEqual([]);
      }

      // Recovery: exactly one racer completes the run locally.
      await pollUntil(() =>
        racers.some((racer) => racer.bureau.getRun(marker.runId)?.status === 'completed'),
      );
      const winners = racers.filter(
        (racer) => racer.bureau.getRun(marker.runId)?.status === 'completed',
      );
      expect(winners).toHaveLength(1);
      const winner = winners[0] as Racer;

      for (const racer of racers) {
        await pollUntil(async () => {
          const durable = await racer.bureau.getDurableRun(marker.runId);
          return durable?.status === 'completed';
        });
        const durableRun = await racer.bureau.getDurableRun(marker.runId);
        expect(durableRun?.status).toBe('completed');
      }

      const asOwner = await winner.bureau.eventHistory(
        { kind: 'run', id: marker.runId },
        { principal: 'alice' },
      );
      if ('outcome' in asOwner) {
        throw new Error(`expected a page for alice, got ${JSON.stringify(asOwner)}`);
      }
      const kinds = asOwner.events.map((event) => event.kind);
      expect(kinds.filter((kind) => kind === 'run.completed')).toHaveLength(1);
      expect(kinds).not.toContain('run.error');
      expect(kinds).not.toContain('run.aborted');
      expect(
        await winner.bureau.eventHistory(
          { kind: 'run', id: marker.runId },
          { principal: 'mallory' },
        ),
      ).toEqual({ outcome: 'not-found' });

      // Fencing: the post-crash step ran once across both racers; step 0 never reran.
      expect(b.stepsAtOrAfterOne() + c.stepsAtOrAfterOne()).toBe(1);
      expect(b.stepZeroCalls() + c.stepZeroCalls()).toBe(0);

      const auditTrail = winner.bureau.auditTrail;
      if (auditTrail === undefined) throw new Error('the bureau has no audit trail');

      // Continuity: audit sequence numbers are never reused.
      const records = await auditTrail.query({ runId: marker.runId });
      const sequences = records.map((record) => record.sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(typeof record.sequence).toBe('number');
        // Every record above the marker was written after the crash, and none below it was.
        expect((record.sequence as number) > marker.maxAuditSequence).toBe(
          record.timestampMs > crashedAt,
        );
      }
      expect(
        records.filter((record) => (record.sequence as number) > marker.maxAuditSequence).length,
      ).toBeGreaterThan(0);

      // Continuity: no duplicate step record.
      const stepRecords = await auditTrail.query({
        runId: marker.runId,
        type: 'step.completed',
      });
      const indices = stepRecords.map((record) => stepIndexOf(record.detail));
      expect(indices.length).toBeGreaterThanOrEqual(2);
      expect(indices).toEqual(indices.map((_, position) => position));

      // Continuity: the pre-crash cursor still resumes without a gap.
      const resumed = await winner.bureau.eventHistory(
        { kind: 'session', id: marker.sessionId },
        { since: marker.sessionCursor },
      );
      if ('outcome' in resumed) {
        throw new Error(`expected a resumable page, got ${JSON.stringify(resumed)}`);
      }
      expect(resumed.events.length).toBeGreaterThan(0);
      let previous = marker.sessionLastSequence;
      for (const event of resumed.events) {
        expect(event.sequence).toBeGreaterThan(previous);
        previous = event.sequence;
      }
    } finally {
      // allSettled never rejects, so the directory is always removed after both shutdowns.
      const reports = await Promise.allSettled(racers.map((racer) => racer.bureau.shutdown()));
      rmSync(directory, { recursive: true, force: true });
      for (const report of reports) {
        expect(report.status).toBe('fulfilled');
        if (report.status === 'fulfilled') expect(report.value.unresolved).toBe(0);
      }
    }
  }, 120_000);
});
