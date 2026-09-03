import { describe, expect, it } from 'bun:test';

import { createManualRuntimeServices } from '../src/manual-runtime-services';

describe('createManualRuntimeServices', () => {
  describe('clock and monotonic', () => {
    it('starts at the supplied origin and never touches the real clock', () => {
      const runtime = createManualRuntimeServices({ origin: '2024-01-01T00:00:00.000Z' });
      expect(runtime.clock.nowISO()).toBe('2024-01-01T00:00:00.000Z');
      expect(runtime.clock.now()).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
      expect(runtime.monotonic.now()).toBe(0);
    });

    it('advance() moves both the monotonic clock and the wall clock forward together', async () => {
      const runtime = createManualRuntimeServices({ origin: '2024-01-01T00:00:00.000Z' });
      await runtime.advance(1000);
      expect(runtime.monotonic.now()).toBe(1000);
      expect(runtime.clock.nowISO()).toBe('2024-01-01T00:00:01.000Z');
    });

    it('setTime() moves the wall clock without moving the monotonic clock or firing timers', async () => {
      const runtime = createManualRuntimeServices({ origin: '2024-01-01T00:00:00.000Z' });
      let fired = false;
      runtime.timers.setTimeout(() => {
        fired = true;
      }, 1000);

      runtime.setTime(Date.parse('2030-06-15T00:00:00.000Z'));

      expect(runtime.clock.nowISO()).toBe('2030-06-15T00:00:00.000Z');
      expect(runtime.monotonic.now()).toBe(0);
      expect(fired).toBe(false);

      // The wall clock keeps advancing from its new offset, in lockstep with
      // the monotonic clock, once `advance()` runs.
      await runtime.advance(1000);
      expect(runtime.clock.nowISO()).toBe('2030-06-15T00:00:01.000Z');
      expect(fired).toBe(true);
    });
  });

  describe('advance()', () => {
    it('fires a timer whose deadline the advance crosses', async () => {
      const runtime = createManualRuntimeServices();
      let fired = false;
      runtime.timers.setTimeout(() => {
        fired = true;
      }, 100);

      await runtime.advance(50);
      expect(fired).toBe(false);

      await runtime.advance(50);
      expect(fired).toBe(true);
    });

    it('fires multiple timers in deadline order', async () => {
      const runtime = createManualRuntimeServices();
      const order: string[] = [];
      runtime.timers.setTimeout(() => order.push('second'), 200);
      runtime.timers.setTimeout(() => order.push('first'), 100);
      runtime.timers.setTimeout(() => order.push('third'), 300);

      await runtime.advance(300);

      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('a callback that schedules another timer inside the advanced window still fires within the same advance() call', async () => {
      const runtime = createManualRuntimeServices();
      const order: string[] = [];
      runtime.timers.setTimeout(() => {
        order.push('outer');
        runtime.timers.setTimeout(() => {
          order.push('inner');
        }, 10);
      }, 50);

      await runtime.advance(100);

      expect(order).toEqual(['outer', 'inner']);
    });

    it('never fires a timer scheduled outside the advanced window', async () => {
      const runtime = createManualRuntimeServices();
      let fired = false;
      runtime.timers.setTimeout(() => {
        fired = true;
      }, 500);

      await runtime.advance(100);

      expect(fired).toBe(false);
      expect(runtime.pendingTimers()).toEqual([{ handle: 0, dueAt: 500 }]);
    });

    it('pendingTimers() lists every still-armed timer sorted by deadline', async () => {
      const runtime = createManualRuntimeServices();
      runtime.timers.setTimeout(() => {}, 500);
      runtime.timers.setTimeout(() => {}, 100);
      runtime.timers.setTimeout(() => {}, 300);

      expect(runtime.pendingTimers()).toEqual([
        { handle: 1, dueAt: 100 },
        { handle: 2, dueAt: 300 },
        { handle: 0, dueAt: 500 },
      ]);
    });

    it('an interval re-arms at its own period inside the advanced window rather than firing once', async () => {
      const runtime = createManualRuntimeServices();
      let calls = 0;
      runtime.timers.setInterval(() => {
        calls += 1;
      }, 100);

      await runtime.advance(350);

      expect(calls).toBe(3);
    });

    it('clearTimeout prevents a not-yet-due timer from firing', async () => {
      const runtime = createManualRuntimeServices();
      let fired = false;
      const handle = runtime.timers.setTimeout(() => {
        fired = true;
      }, 100);
      runtime.timers.clearTimeout(handle);

      await runtime.advance(200);

      expect(fired).toBe(false);
    });

    it('clearInterval stops future firings', async () => {
      const runtime = createManualRuntimeServices();
      let calls = 0;
      const handle = runtime.timers.setInterval(() => {
        calls += 1;
        if (calls === 2) runtime.timers.clearInterval(handle);
      }, 100);

      await runtime.advance(500);

      expect(calls).toBe(2);
    });

    it('never calls a real timer — advance() settles synchronously with respect to wall-clock time', async () => {
      const runtime = createManualRuntimeServices();
      let fired = false;
      runtime.timers.setTimeout(() => {
        fired = true;
      }, 60_000);

      const started = performance.now();
      await runtime.advance(60_000);
      const elapsed = performance.now() - started;

      expect(fired).toBe(true);
      // A 60-second virtual advance must not take anywhere close to 60
      // real seconds — proves no real timer is backing it.
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('identifiers', () => {
    it('returns `${kind}-${n}` with a per-kind counter starting at 1', () => {
      const runtime = createManualRuntimeServices();
      expect(runtime.identifiers.next('run')).toBe('run-1');
      expect(runtime.identifiers.next('run')).toBe('run-2');
      expect(runtime.identifiers.next('session')).toBe('session-1');
    });

    it('produces byte-identical identifiers across two runs of the same scripted case', () => {
      const runFirst = () => {
        const runtime = createManualRuntimeServices();
        return [runtime.identifiers.next('run'), runtime.identifiers.next('child')];
      };
      expect(runFirst()).toEqual(runFirst());
    });
  });

  describe('random', () => {
    it('the same randomSeed produces the same sequence', () => {
      const a = createManualRuntimeServices({ randomSeed: 'seed-a' });
      const b = createManualRuntimeServices({ randomSeed: 'seed-a' });
      const sequenceA = [a.random.next(), a.random.next(), a.random.next()];
      const sequenceB = [b.random.next(), b.random.next(), b.random.next()];
      expect(sequenceA).toEqual(sequenceB);
    });

    it('two instances constructed with different seeds diverge', () => {
      const a = createManualRuntimeServices({ randomSeed: 'seed-a' });
      const b = createManualRuntimeServices({ randomSeed: 'seed-b' });
      expect(a.random.next()).not.toBe(b.random.next());
    });

    it('returns a value in [0, 1)', () => {
      const runtime = createManualRuntimeServices();
      for (let index = 0; index < 20; index++) {
        const value = runtime.random.next();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });
  });

  describe('deferred', () => {
    it('outstandingDeferred() lists a not-yet-settled tracked promise', () => {
      const runtime = createManualRuntimeServices();
      const never = new Promise<void>(() => {});
      runtime.deferred.track(never, 'stuck');
      expect(runtime.outstandingDeferred()).toEqual(['stuck']);
    });

    it('drain() reports settled and outstanding promises', async () => {
      const runtime = createManualRuntimeServices();
      runtime.deferred.track(Promise.resolve(), 'quick');
      const never = new Promise<void>(() => {});
      runtime.deferred.track(never, 'stuck');

      const report = await runtime.deferred.drain();

      expect(report.settled).toEqual([{ label: 'quick', outcome: 'resolved' }]);
      expect(report.outstanding).toEqual(['stuck']);
    });

    it('reports a rejected tracked promise as { outcome: "rejected" } and never lets it become an unhandled rejection', async () => {
      const runtime = createManualRuntimeServices();
      runtime.deferred.track(Promise.reject(new Error('boom')), 'failing');

      const report = await runtime.deferred.drain();

      expect(report.settled).toEqual([{ label: 'failing', outcome: 'rejected' }]);
      expect(report.outstanding).toEqual([]);
    });
  });

  describe('instance isolation', () => {
    it("two ManualRuntimeServices instances share no state: advancing one never fires the other's timers, and identifier counters are independent", async () => {
      const runtimeA = createManualRuntimeServices();
      const runtimeB = createManualRuntimeServices();

      let firedA = false;
      let firedB = false;
      runtimeA.timers.setTimeout(() => {
        firedA = true;
      }, 100);
      runtimeB.timers.setTimeout(() => {
        firedB = true;
      }, 100);

      await runtimeA.advance(100);

      expect(firedA).toBe(true);
      expect(firedB).toBe(false);

      expect(runtimeA.identifiers.next('run')).toBe('run-1');
      expect(runtimeA.identifiers.next('run')).toBe('run-2');
      expect(runtimeB.identifiers.next('run')).toBe('run-1');
    });

    it('drives two concurrent createActiveRun-shaped consumers independently via two instances', async () => {
      // Simulates two concurrent "createActiveRun" callers, each pinned to
      // its own ManualRuntimeServices: minting a run id and scheduling a
      // per-run timeout must never cross-fire or share identifier state.
      function startFakeRun(runtime: ReturnType<typeof createManualRuntimeServices>) {
        const runId = runtime.identifiers.next('run');
        let timedOut = false;
        runtime.timers.setTimeout(() => {
          timedOut = true;
        }, 1000);
        return {
          runId,
          isTimedOut: () => timedOut,
        };
      }

      const runtimeA = createManualRuntimeServices();
      const runtimeB = createManualRuntimeServices();
      const runA = startFakeRun(runtimeA);
      const runB = startFakeRun(runtimeB);

      expect(runA.runId).toBe('run-1');
      expect(runB.runId).toBe('run-1');

      await runtimeA.advance(1000);

      expect(runA.isTimedOut()).toBe(true);
      expect(runB.isTimedOut()).toBe(false);

      await runtimeB.advance(1000);
      expect(runB.isTimedOut()).toBe(true);
    });
  });
});
