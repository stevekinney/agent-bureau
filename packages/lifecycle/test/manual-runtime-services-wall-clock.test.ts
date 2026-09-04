import { describe, expect, it } from 'bun:test';

import { createManualRuntimeServices } from '../src/manual-runtime-services';

/**
 * Split out of `manual-runtime-services.test.ts` (AB-292) so the
 * `scripts/determinism-manifest.json` `realRuntimeExemptions` entry this
 * file needs — measuring real `performance.now()` to prove `advance()`
 * consumes no real wall-clock time — covers only this one assertion rather
 * than the whole `createManualRuntimeServices` suite. A future real-timer
 * regression anywhere else in that suite still gets caught by the gate.
 */
describe('createManualRuntimeServices', () => {
  describe('timers', () => {
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
});
