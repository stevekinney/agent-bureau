import { describe, expect, it } from 'bun:test';

import { createDefaultRuntimeServices } from '../src/runtime-services';

describe('createDefaultRuntimeServices', () => {
  describe('clock', () => {
    it('now() returns a real, current epoch millisecond value', () => {
      const runtime = createDefaultRuntimeServices();
      const before = Date.now();
      const now = runtime.clock.now();
      const after = Date.now();
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after);
    });

    it('nowISO() returns an ISO-8601 string consistent with now()', () => {
      const runtime = createDefaultRuntimeServices();
      const iso = runtime.clock.nowISO();
      expect(() => new Date(iso)).not.toThrow();
      expect(new Date(iso).toISOString()).toBe(iso);
    });
  });

  describe('monotonic', () => {
    it('now() never decreases across two calls', () => {
      const runtime = createDefaultRuntimeServices();
      const first = runtime.monotonic.now();
      const second = runtime.monotonic.now();
      expect(second).toBeGreaterThanOrEqual(first);
    });
  });

  describe('timers', () => {
    it('setTimeout schedules a real callback and clearTimeout cancels it', async () => {
      const runtime = createDefaultRuntimeServices();
      let fired = false;
      const handle = runtime.timers.setTimeout(() => {
        fired = true;
      }, 0);
      runtime.timers.clearTimeout(handle);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      expect(fired).toBe(false);
    });

    it('setInterval schedules a repeating real callback and clearInterval stops it', async () => {
      const runtime = createDefaultRuntimeServices();
      let calls = 0;
      const handle = runtime.timers.setInterval(() => {
        calls += 1;
      }, 1);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 15));
      runtime.timers.clearInterval(handle);
      const callsAtClear = calls;
      expect(callsAtClear).toBeGreaterThan(0);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 15));
      expect(calls).toBe(callsAtClear);
    });
  });

  describe('identifiers', () => {
    it('mints a distinct id on every call', () => {
      const runtime = createDefaultRuntimeServices();
      const first = runtime.identifiers.next('run');
      const second = runtime.identifiers.next('run');
      expect(first).not.toBe(second);
    });

    it('namespaces the sequence by kind', () => {
      const runtime = createDefaultRuntimeServices();
      const runId = runtime.identifiers.next('run');
      const sessionId = runtime.identifiers.next('session');
      expect(runId.startsWith('run-')).toBe(true);
      expect(sessionId.startsWith('session-')).toBe(true);
    });
  });

  describe('random', () => {
    it('returns a value in [0, 1)', () => {
      const runtime = createDefaultRuntimeServices();
      for (let index = 0; index < 20; index++) {
        const value = runtime.random.next();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });
  });

  describe('deferred', () => {
    it('drain() resolves once every tracked promise has settled, reporting resolved outcomes', async () => {
      const runtime = createDefaultRuntimeServices();
      runtime.deferred.track(Promise.resolve('ok'), 'alpha');
      runtime.deferred.track(Promise.resolve('ok'), 'beta');

      const report = await runtime.deferred.drain();

      expect(report.outstanding).toEqual([]);
      expect(report.settled).toHaveLength(2);
      expect(report.settled.every((entry) => entry.outcome === 'resolved')).toBe(true);
      expect(report.settled.map((entry) => entry.label).sort()).toEqual(['alpha', 'beta']);
    });

    it('reports a rejected tracked promise as { outcome: "rejected" } and never lets it become an unhandled rejection', async () => {
      const runtime = createDefaultRuntimeServices();
      runtime.deferred.track(Promise.reject(new Error('boom')), 'failing');

      const report = await runtime.deferred.drain();

      expect(report.settled).toEqual([{ label: 'failing', outcome: 'rejected' }]);
      expect(report.outstanding).toEqual([]);
    });

    it('reports a promise still pending after every other tracked promise settled under outstanding, without hanging', async () => {
      const runtime = createDefaultRuntimeServices();
      const never = new Promise<void>(() => {
        // Deliberately never settles.
      });
      runtime.deferred.track(never, 'stuck');
      runtime.deferred.track(Promise.resolve(), 'quick');

      const report = await runtime.deferred.drain();

      expect(report.settled).toEqual([{ label: 'quick', outcome: 'resolved' }]);
      expect(report.outstanding).toEqual(['stuck']);
    });

    it('a second drain() call reports a previously-outstanding promise once it settles', async () => {
      const runtime = createDefaultRuntimeServices();
      let resolveLate: () => void = () => {};
      const late = new Promise<void>((resolve) => {
        resolveLate = resolve;
      });
      runtime.deferred.track(late, 'late');

      const firstReport = await runtime.deferred.drain();
      expect(firstReport.outstanding).toEqual(['late']);

      resolveLate();
      const secondReport = await runtime.deferred.drain();
      expect(secondReport.settled).toEqual([{ label: 'late', outcome: 'resolved' }]);
      expect(secondReport.outstanding).toEqual([]);
    });
  });

  it('returns a fresh, independent instance on every call', () => {
    const first = createDefaultRuntimeServices();
    const second = createDefaultRuntimeServices();
    expect(first.identifiers.next('run')).not.toBe(second.identifiers.next('run'));
  });
});
