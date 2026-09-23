import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import {
  createInstantGenerate,
  createSessionHandleFixture,
  createTestRunOptions,
} from './session-handle-test-support';
import { MissingRunOptionsError } from './session-handle-types';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('session.run() — startup and settlement', () => {
  it.each([false, true])(
    'persists schema validation classification (success=%s)',
    async (success) => {
      const store = createSessionStore(textValueStore(new MemoryStorage()));
      const handle = createSessionHandle('schema-outcome', {
        store,
        agentName: 'agent',
        runOptions: {
          generate: createInstantGenerate(success ? '{"answer":"valid"}' : '{"answer":42}'),
          toolbox: createToolbox([]),
          output: z.object({ answer: z.string() }),
          stopWhen: () => true,
          schemaRetries: 0,
        },
      });
      const run = handle.run('answer');
      const result = await run.result();
      expect(result.schemaValidation?.success).toBe(success);
      const schemaSession = await store.load('schema-outcome');
      expect(schemaSession?.runs[0]?.outcome).toEqual({
        finishReason: 'stop-condition',
        ...(success ? {} : { error: { kind: 'output', code: 'INVALID_OUTPUT' } }),
      });
      if (!success) expect(run.unwrap()).rejects.toThrow();
    },
  );

  it('returns an AgentRun handle immediately (synchronous)', () => {
    const { handle } = createSessionHandleFixture();
    const run = handle.run('hello');
    expect(run).toBeDefined();
    expect(typeof run.result).toBe('function'); // AgentRun.result() is a method
    expect(typeof run.abort).toBe('function');
    expect(typeof run[Symbol.asyncIterator]).toBe('function');
  });

  it('fails synchronously when run options are absent', () => {
    const { handle } = createSessionHandleFixture({ withoutRunOptions: true });
    expect(() => handle.run('must fail before reservation')).toThrow(MissingRunOptionsError);
  });

  it('closed() resolves not-required for a clean completion — delegated straight through from the inner run, which is itself first asked only once it has already settled (AB-204)', async () => {
    const { handle } = createSessionHandleFixture();

    const run = handle.run('hello');
    const closedAcknowledgement = run.closed();
    await run.result();

    // This wrapper's own `resolveOutcome` only calls the inner run's
    // `closed()` for the first time AFTER the outer `resultPromise` (which
    // itself awaits the inner run's own result) has already settled — so
    // the inner run's own not-required fast path always applies for an
    // uncancelled completion, regardless of when THIS wrapper's closed()
    // was called. `not-required` here is the delegated value, not a
    // different code path from the "already settled" case below.
    expect(await closedAcknowledgement).toEqual({ status: 'not-required' });
  });

  it('closed() resolves not-required when first called after the run already settled with no cancellation (AB-204)', async () => {
    const { handle } = createSessionHandleFixture();

    const run = handle.run('hello');
    await run.result();
    await Promise.resolve();

    expect(await run.closed()).toEqual({ status: 'not-required' });
  });

  it('closed() delegates a non-not-required outcome from the inner run when the run was aborted (AB-204)', async () => {
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const blockingGenerate: GenerateFunction = async ({ signal }) => {
      signalGenerateStarted();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('session run aborted')), {
          once: true,
        });
      });
      throw new Error('abort signal was not delivered');
    };
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const handle = createSessionHandle('closed-delegates-aborted-session', {
      store,
      agentName: 'agent',
      runOptions: createTestRunOptions(blockingGenerate),
    });

    const run = handle.run('abort me');
    await generateStarted;
    run.abort('user stopped it');

    const result = await run.result();
    expect(result.finishReason).toBe('aborted');

    // The wrapper's own cancellation disqualifies ITS not-required fast
    // path (cancelRequested), and the inner run's own cancellation
    // (forwarded via activeInnerRun?.abort()) disqualifies ITS fast path
    // too — so this exercises the real "await the drain, then delegate"
    // path end to end, rather than the trivial not-required short-circuit.
    expect(await run.closed()).toEqual({ status: 'completed' });
  });

  // Regression: a code-review finding on the AB-204 pull request —
  // `cancelRequested` alone misses a cancellation delivered through the
  // session's own configured `runOptions.signal` rather than a direct
  // `run.abort()`/`[Symbol.dispose]()` call.
  it('closed() disqualifies not-required when the run was cancelled through the configured runOptions.signal rather than abort()', async () => {
    let signalGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const blockingGenerate: GenerateFunction = async ({ signal }) => {
      signalGenerateStarted();
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('session run aborted')), {
          once: true,
        });
      });
      throw new Error('abort signal was not delivered');
    };
    const kv = textValueStore(new MemoryStorage());
    const store = createSessionStore(kv);
    const controller = new AbortController();
    const handle = createSessionHandle('closed-configured-signal-session', {
      store,
      agentName: 'agent',
      runOptions: { ...createTestRunOptions(blockingGenerate), signal: controller.signal },
    });

    const run = handle.run('abort me via configured signal');
    await generateStarted;
    controller.abort('configured signal fired');

    const result = await run.result();
    expect(result.finishReason).toBe('aborted');

    expect(await run.closed()).not.toEqual({ status: 'not-required' });
  });

  it('AB-88/AB-214: snapshot()/subscribeSnapshot() read a synthetic created snapshot before the inner run exists and delegate once it does', async () => {
    const { handle } = createSessionHandleFixture();

    const run = handle.run('hello');

    // Synchronous return means `activeInnerRun` cannot exist yet (it's set
    // inside the async reservation IIFE) — this must be the synthetic
    // 'created' snapshot, not a throw.
    const beforeSnapshot = run.snapshot();
    expect(beforeSnapshot.status).toBe('created');
    expect(beforeSnapshot.kind).toBe('agent-run');

    const beforeReceived: string[] = [];
    const beforeSubscription = run.subscribeSnapshot((snapshot) =>
      beforeReceived.push(snapshot.status),
    );
    expect(beforeReceived).toEqual(['created']);
    expect(beforeSubscription.closed).toBe(true);
    expect(() => beforeSubscription.unsubscribe()).not.toThrow();

    await run.result();

    // Once the inner run exists and has settled, this delegates straight
    // through to its own terminal snapshot.
    expect(run.snapshot().status).toBe('terminal');
    const afterReceived: string[] = [];
    run.subscribeSnapshot((snapshot) => afterReceived.push(snapshot.status));
    expect(afterReceived).toEqual(['terminal']);
  });
});
