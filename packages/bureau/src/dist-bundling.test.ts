import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

// Regression test for a bundling defect (AB-80): `scripts/build.ts` used to
// bundle `@lostgradient/weft` into `dist/index.js` instead of leaving it
// external. Weft's `resolveStorage()` lazily loads backend adapters (sqlite,
// lmdb, ...) via a relative dynamic `import('./bun-sql.js')` resolved against
// its OWN module's `import.meta.url`. Bundled into bureau's dist, that
// specifier resolved against bureau's bundle instead and threw `Cannot find
// module './bun-sql.js' from bureau/dist/index.js` for every persistent
// storage backend the moment a consumer (e.g. `gateway`) ran from the built
// package rather than from source — exactly what a real deploy does.
//
// This test exercises the BUILT dist output, not source, because the source
// import path never reproduces the bug (weft resolves against its own
// installed dist there). It only fails if a future build change re-bundles
// weft into bureau's dist.
describe('dist bundling (built output, not source)', () => {
  it('resolves sqlite storage from the built dist without a bundling error', async () => {
    const databasePath = join(tmpdir(), `bureau-dist-bundling-${process.pid}-${Date.now()}.sqlite`);

    try {
      const { createBureau } = (await import('../dist/index.js')) as typeof import('./index');

      const bureau = await createBureau({
        storage: { type: 'sqlite', path: databasePath },
      });

      expect(bureau.ready).toBe(false);
      bureau.dispose();
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});
