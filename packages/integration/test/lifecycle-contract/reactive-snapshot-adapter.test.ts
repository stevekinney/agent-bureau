/**
 * Coordinator ruling on AB-268 (2026-09-03): `toReactiveSourceSubject`
 * (`support.ts`) adapts the real `ActiveRun`/`AgentRun`
 * `subscribeSnapshot(observer, options?) => Subscription` (AB-214) to the
 * `subscribeSnapshot(invalidate) => unsubscribe` shape
 * `ReactiveSourceSubject` (AB-258/tst-02g) expects — skipping the first
 * synchronous delivery (subscribing always delivers the current snapshot
 * once, synchronously, before returning) and forwarding only subsequent
 * deliveries as invalidations. This proves that adapter forwards exactly
 * one invalidation per real change after the initial delivery, against a
 * real `ActiveRun` — not a hand-rolled double.
 */
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import { createManualRuntimeServices } from '@lostgradient/operative/test';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createBlockingGenerate, toReactiveSourceSubject } from './support';

describe('toReactiveSourceSubject', () => {
  it('skips the initial synchronous delivery and forwards exactly one invalidation per subsequent real change', async () => {
    const runtime = createManualRuntimeServices();
    const blocking = createBlockingGenerate();
    const run = createActiveRun({
      generate: blocking.generate,
      toolbox: createToolbox([]),
      conversation: new Conversation(),
      stopWhen: stopWhen.noToolCalls(),
      runtime,
    });
    // A raw, independent subscription counts every REAL delivery
    // (including its own synchronous first one) as the ground truth for how
    // many times this run's revision actually changes end to end.
    let rawDeliveries = 0;
    const rawSubscription = run.subscribeSnapshot(() => {
      rawDeliveries += 1;
    });

    const subject = toReactiveSourceSubject(run);
    let invalidations = 0;
    const unsubscribe = subject.subscribeSnapshot(() => {
      invalidations += 1;
    });
    // The real `subscribeSnapshot` already delivered the current snapshot
    // synchronously above, inside `subscribeSnapshot()` itself — the
    // adapter must have swallowed that one, not counted it.
    expect(invalidations).toBe(0);

    blocking.release();
    await run.result;
    rawSubscription.unsubscribe();
    unsubscribe();

    // Both subscriptions were registered in the same synchronous turn, so
    // both observed the identical sequence of real deliveries — the
    // adapter's own count must be exactly one less than the raw count (its
    // first, swallowed delivery), never more, never less.
    expect(invalidations).toBe(rawDeliveries - 1);
  });

  it('getSnapshot() delegates directly to the real run', () => {
    const runtime = createManualRuntimeServices();
    const run = createActiveRun({
      generate: createBlockingGenerate().generate,
      toolbox: createToolbox([]),
      conversation: new Conversation(),
      stopWhen: stopWhen.noToolCalls(),
      runtime,
    });
    const subject = toReactiveSourceSubject(run);
    expect(subject.getSnapshot()).toBe(run.snapshot());
    run.abort('lifecycle-contract: cleanup');
  });
});
