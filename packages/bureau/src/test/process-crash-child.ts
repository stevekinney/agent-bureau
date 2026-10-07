/**
 * COR-1390 — the child half of the process-crash recovery harness.
 *
 * Usage: `bun process-crash-child.ts <scenario> <sqlite|lmdb> <storagePath> <markerPath>`
 *
 * Stands up a real durable Bureau under `workflow-lease` ownership, drives
 * the named scenario, writes the marker file synchronously, and then kills
 * itself with SIGKILL. No `dispose()`, no `shutdown()`: SIGKILL cannot be
 * trapped, so whatever the parent finds afterwards was genuinely on disk
 * before the process died and the claim it held is left to lapse.
 *
 * Not a test file: it is spawned by `process-crash-recovery.test.ts`. Each
 * scenario is a named function below; the `scenarios` table is the extension
 * point for further crash scenarios.
 */
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createCheckpointStore, stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { createBureau } from '../create-bureau';
import {
  chargeStatus,
  chargeToolCalls,
  CLAIM_RENEW_MS,
  CLAIM_TTL_MS,
  createChargeToolbox,
  createHarnessBureau,
  firstUserMessage,
  HUMAN_WAIT_PROMPT,
  HUMAN_WAIT_SIGNAL,
  openGovernedMemory,
  openIdempotencyCache,
  readEffects,
  REMEMBERED_ANSWER,
  requestContext,
  SESSION_ID,
} from './process-crash-work-integrity-fixtures';

const POLL_ATTEMPTS = 2000;
const POLL_DELAY_MS = 5;
const runtime = createDefaultRuntimeServices();

const scenarioName = process.argv[2];
const backend = process.argv[3];
const storagePath = process.argv[4];
const markerPath = process.argv[5];
/** `unwrapped` builds `charge-then-crash` without idempotency (the COR-1391 control). */
const variant = process.argv[6];

if (
  scenarioName === undefined ||
  (backend !== 'sqlite' && backend !== 'lmdb') ||
  storagePath === undefined ||
  markerPath === undefined
) {
  process.stderr.write(
    'usage: process-crash-child <scenario> <sqlite|lmdb> <storagePath> <markerPath> [variant]\n',
  );
  process.exit(2);
}

/** Bounded condition poll with a tiny real delay (LMDB starves a zero-delay loop). */
async function pollUntil(description: string, check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (await check()) return;
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, POLL_DELAY_MS));
  }
  process.stderr.write(`child: timed out waiting for ${description}\n`);
  process.exit(3);
}

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

/**
 * Commits step 0, parks mid-step-1, records what the child has durably
 * observed, then returns so the caller can kill the process.
 */
async function parkAfterStepZero(): Promise<void> {
  let reachedStepOne = false;
  const bureau = await createBureau({
    agents: {},
    generate: async ({ step }) => {
      if (step === 0) {
        return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      // Step 0's cursor has committed once step 1 is requested.
      reachedStepOne = true;
      return new Promise<never>(() => {});
    },
    toolbox: createToolbox([createNextTool()]),
    storage: { type: backend as 'sqlite' | 'lmdb', path: storagePath as string },
    durableExecution: true,
    stopWhen: stopWhen.noToolCalls(),
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });

  const auditTrail = bureau.auditTrail;
  if (auditTrail === undefined) {
    process.stderr.write('child: the bureau has no audit trail\n');
    process.exit(4);
  }

  const run = await bureau.createRun({ message: 'crash harness run', principal: 'alice' });
  const session = { kind: 'session', id: run.sessionId } as const;

  await pollUntil('generate to be invoked at step 1', () => reachedStepOne);
  await pollUntil('the step-0 step.completed audit record', async () => {
    const records = await auditTrail.query({ runId: run.id, type: 'step.completed' });
    return records.length > 0;
  });
  await pollUntil('a non-empty session event page', async () => {
    const page = await bureau.eventHistory(session);
    return !('outcome' in page) && page.events.length > 0;
  });

  const records = await auditTrail.query({ runId: run.id });
  const maxAuditSequence = Math.max(...records.map((record) => record.sequence ?? -1));
  const page = await bureau.eventHistory(session);
  if ('outcome' in page) {
    process.stderr.write(`child: expected an event page, got ${JSON.stringify(page)}\n`);
    process.exit(4);
  }
  const last = page.events[page.events.length - 1];
  if (last === undefined) {
    process.stderr.write('child: session event page was empty\n');
    process.exit(4);
  }

  // Written synchronously so it is on disk before the kill.
  writeFileSync(
    markerPath as string,
    JSON.stringify({
      runId: run.id,
      sessionId: run.sessionId,
      maxAuditSequence,
      sessionCursor: last.cursor,
      sessionLastSequence: last.sequence,
    }),
    'utf8',
  );
}

function writeMarker(marker: Record<string, unknown>): void {
  writeFileSync(markerPath as string, JSON.stringify(marker), 'utf8');
}

function killSelf(): never {
  // No `dispose()` / `shutdown()`, deliberately.
  process.kill(process.pid, 'SIGKILL');
  return undefined as never;
}

/** COR-1391: step 0's tools ran and the idempotency cache recorded them, then SIGKILL. */
async function chargeThenCrash(): Promise<void> {
  const directory = dirname(markerPath as string);
  const { cache, store } = await openIdempotencyCache(directory);
  const runState: { id?: string } = {};
  const toolbox = createChargeToolbox(
    directory,
    async () => {
      await pollUntil('one charge effect and its completed cache entry', async () => {
        if (readEffects(directory).length !== 1) return false;
        return variant === 'unwrapped' ? true : (await chargeStatus(store, cache)) === 'completed';
      });
      await pollUntil('the run id', () => runState.id !== undefined);
      writeMarker({ runId: runState.id });
      return killSelf();
    },
    { cache, wrap: variant !== 'unwrapped' },
  );
  const bureau = await createHarnessBureau({
    backend: backend as 'sqlite' | 'lmdb',
    storagePath: storagePath as string,
    generate: async () => ({ content: 'charging', toolCalls: chargeToolCalls }),
    toolbox,
  });
  const run = await bureau.createRun({
    message: 'crash harness charge',
    principal: 'alice',
    sessionId: SESSION_ID,
    requestContext: requestContext(),
  });
  runState.id = run.id;
  await new Promise<never>(() => {});
}

/** COR-1391: the governed-memory record write resolves, then SIGKILL before the memo commits. */
async function memoryWriteThenCrash(): Promise<void> {
  const directory = dirname(markerPath as string);
  const runState: { id?: string } = {};
  const { memory } = await openGovernedMemory(directory, (storage) => {
    const original = storage.conditionalBatch?.bind(storage);
    if (original === undefined) throw new Error('child: memory storage lacks conditionalBatch');
    return new Proxy(storage, {
      get(target, property) {
        if (property === 'conditionalBatch') {
          return async (...args: Parameters<typeof original>) => {
            const applied = await original(...args);
            if (applied && args[1].some((operation) => operation.type === 'put')) {
              await pollUntil('the run id', () => runState.id !== undefined);
              writeMarker({ runId: runState.id, sessionId: SESSION_ID });
              killSelf();
            }
            return applied;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  const bureau = await createHarnessBureau({
    backend: backend as 'sqlite' | 'lmdb',
    storagePath: storagePath as string,
    generate: async () => ({ content: REMEMBERED_ANSWER, toolCalls: [] }),
    toolbox: createToolbox([createNextTool()]),
    memory,
  });
  const run = await bureau.createRun({
    message: 'crash harness memory',
    principal: 'alice',
    sessionId: SESSION_ID,
    requestContext: requestContext(),
  });
  runState.id = run.id;
  await new Promise<never>(() => {});
}

/** COR-1391: two runs park mid-step-1; both ids are recorded, then SIGKILL. */
async function twoParkedRuns(): Promise<void> {
  const reachedStepOne = new Set<string>();
  const bureau = await createHarnessBureau({
    backend: backend as 'sqlite' | 'lmdb',
    storagePath: storagePath as string,
    generate: async (context) => {
      if (context.step === 0) {
        return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      reachedStepOne.add(firstUserMessage(context));
      return new Promise<never>(() => {});
    },
    toolbox: createToolbox([createNextTool()]),
  });
  const x = await bureau.createRun({ message: 'crash harness run X', principal: 'alice' });
  const y = await bureau.createRun({ message: 'crash harness run Y', principal: 'alice' });
  await pollUntil('both runs to invoke generate at step 1', () => reachedStepOne.size === 2);
  writeMarker({ xRunId: x.id, yRunId: y.id });
}

/**
 * COR-1409: a run parks on `requestHumanInput`, and the process dies once the
 * park is durable.
 *
 * The review becomes visible as soon as the tool dispatches its park event,
 * which happens while the step memo carrying the pending wait is still being
 * committed. A process killed in that window was never durably parked: its
 * successor rightly re-runs the step. So the child waits until the run's cursor
 * has advanced past step 0, which the workflow commits only after that memo and
 * the step record. COR-121's in-process test covers the narrower window where
 * the memo landed and the step record did not.
 */
async function humanWaitParked(): Promise<void> {
  const bureau = await createHarnessBureau({
    backend: backend as 'sqlite' | 'lmdb',
    storagePath: storagePath as string,
    generate: async () => ({
      content: '',
      toolCalls: [
        {
          id: 'call-park',
          name: 'requestHumanInput',
          arguments: { signalName: HUMAN_WAIT_SIGNAL, prompt: HUMAN_WAIT_PROMPT },
        },
      ],
    }),
    toolbox: createToolbox([]),
    humanInput: true,
  });
  const run = await bureau.createRun({ message: 'crash harness park', principal: 'alice' });
  await pollUntil('the run to surface its human-wait review', () =>
    bureau.listPendingReviews().some((review) => review.runId === run.id),
  );
  // Read through the Bureau's own store: a second handle on a live LMDB path
  // can deadlock against the Bureau's (see `storage-fixtures.ts`).
  if (bureau.kv === undefined) {
    process.stderr.write('child: the bureau has no durable key-value store\n');
    process.exit(4);
  }
  const checkpoints = createCheckpointStore(bureau.kv);
  await pollUntil('the run cursor to advance past the parked step', async () => {
    const cursor = await checkpoints.loadCursor(run.id);
    return cursor !== null && cursor.step >= 1;
  });
  writeMarker({ runId: run.id });
}

/** COR-1391: a non-crashing boot over the recovered, shut-down store. */
async function verify(): Promise<void> {
  const directory = dirname(markerPath as string);
  const { cache, close } = await openIdempotencyCache(directory);
  const governed = await openGovernedMemory(directory);
  const bureau = await createHarnessBureau({
    backend: backend as 'sqlite' | 'lmdb',
    storagePath: storagePath as string,
    generate: async () => ({ content: 'verify', toolCalls: [] }),
    toolbox: createChargeToolbox(directory, async () => 'ok', { cache, wrap: true }),
    memory: governed.memory,
  });
  const report = await bureau.waitForRecovery?.();
  const runningRuns = await bureau.listDurableRuns({ status: 'running' });
  const running = runningRuns?.items.length;
  writeMarker({ recoveryOutcome: report?.outcome, running });
  await bureau.shutdown();
  governed.close();
  await close();
  process.exit(0);
}

const scenarios: Record<string, () => Promise<void>> = {
  'park-after-step-0': parkAfterStepZero,
  'charge-then-crash': chargeThenCrash,
  'memory-write-then-crash': memoryWriteThenCrash,
  'two-parked-runs': twoParkedRuns,
  'human-wait-parked': humanWaitParked,
  verify,
};

const scenario = scenarios[scenarioName];
if (scenario === undefined) {
  process.stderr.write(`child: unknown scenario "${scenarioName}"\n`);
  process.exit(2);
}

await scenario();

// No `bureau.dispose()` / `shutdown()`, deliberately.
process.kill(process.pid, 'SIGKILL');
