/**
 * Executable copy of the Quick Start example in this package's README.
 *
 * The example test reproduces the documented example as written. Only the
 * imports (`./index` stands in for `@lostgradient/bureau`), the SQLite path (a
 * per-process temporary file, removed afterwards), and the provider differ: the
 * README resolves a real Anthropic provider, which needs a network connection
 * and an API key, so the test passes a mock `generate` in its place. The test
 * also waits for the run's session save before disposing; see
 * `terminalSessionSaved`. Every result the README claims in a comment is
 * asserted. Change the example and this test together.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { type Bureau, createBureau, type RunSummary } from './index';

const databasePath = join(tmpdir(), `bureau-quick-start-guide-${process.pid}.sqlite`);

afterEach(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${databasePath}${suffix}`, { force: true });
  }
});

/**
 * Stands in for the README's Anthropic provider: answers every step without
 * calling a tool. The example sets no stop condition, so the run keeps
 * stepping until the default step limit.
 */
const answerWithoutTools: GenerateFunction = async () => ({
  content: 'Q3 revenue grew while costs held flat.',
  toolCalls: [],
});

/**
 * Resolves once Bureau has saved the run's terminal status to its session.
 *
 * Bureau starts that save after `run.completed` without tracking it, so
 * `dispose()` does not wait for it. Disposing the moment the run completes can
 * stop the durable event producer before the save's outbox entry is recorded,
 * and Bureau then reports the entry as not durably recorded. That shutdown race
 * is separate from the README's wait, so these tests step around it.
 */
async function terminalSessionSaved(
  bureau: Pick<Bureau, 'getSession'>,
  run: Pick<RunSummary, 'id' | 'sessionId'>,
): Promise<void> {
  for (;;) {
    const session = await bureau.getSession(run.sessionId);
    const metadata = session?.metadata;
    if (metadata?.['lastRunId'] === run.id && metadata['lastRunStatus'] !== 'running') return;
    await Bun.sleep(5);
  }
}

describe('README — Quick Start', () => {
  it('waits for the run to finish through a subscription it closes on the terminal action', async () => {
    const bureau = await createBureau({
      agents: {},
      // The README passes `provider: { provider: 'anthropic', model: 'claude-sonnet-4.5' }`.
      generate: answerWithoutTools,
      storage: { type: 'sqlite', path: databasePath },
    });

    const run = await bureau.createRun({ message: 'Summarize the Q3 report.' });
    expect(run.status).toBe('running');

    // Wait for completion via the live event surface. A run records many actions
    // before it finishes, so keep the subscription open until this run's terminal
    // action arrives, then close it.
    await new Promise<void>((resolve) => {
      const subscription = bureau.subscribe('action', ({ action }) => {
        if (action.runId !== run.id) return;
        if (action.type === 'run.completed' || action.type === 'run.aborted') {
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    const detail = bureau.getRun(run.id);
    // One of the README's `"stop-condition" | "maximum-steps" | …`: with no stop
    // condition, the mock's answers run to the default step limit.
    expect(detail?.finishReason).toBe('maximum-steps');

    await terminalSessionSaved(bureau, run);
    await bureau.dispose();
  });

  it('cannot wait with `once`, because `once` detaches after the first action of any type', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: answerWithoutTools,
      storage: { type: 'sqlite', path: databasePath },
    });
    const everyAction: string[] = [];
    const settled = Promise.withResolvers<void>();
    bureau.addEventListener('action', ({ action }) => {
      everyAction.push(action.type);
      if (action.type === 'run.completed') settled.resolve();
    });
    const heardByOnce: string[] = [];
    bureau.once('action', ({ action }) => heardByOnce.push(action.type));

    const run = await bureau.createRun({ message: 'Summarize the Q3 report.' });
    await settled.promise;

    expect(heardByOnce).toEqual(['run.started']);
    expect(everyAction[0]).toBe('run.started');
    expect(everyAction.at(-1)).toBe('run.completed');

    await terminalSessionSaved(bureau, run);
    await bureau.dispose();
  });
});
