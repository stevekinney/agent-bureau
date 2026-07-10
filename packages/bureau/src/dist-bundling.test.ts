import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { createBureau as CreateBureau } from './index';

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
//
// The import path below is computed into a variable rather than passed as a
// string literal directly to `import()`. `dist/` is excluded from this
// package's `tsconfig.json` and `check-types` (unlike `test`) does not
// depend on this package's own `build` task — a literal `import('../dist/...')`
// would make `tsc` try to resolve `dist/index.d.ts` for its type, which does
// not exist yet the moment `check-types` runs before `build` in CI's task
// graph. A non-literal specifier is invisible to TypeScript's module
// resolution (the import expression types as `Promise<any>`), so this file
// type-checks independent of build order; the explicit cast below recovers
// the real type for the assertions that follow.
describe('dist bundling (built output, not source)', () => {
  it('resolves sqlite storage from the built dist without a bundling error', async () => {
    const databasePath = join(tmpdir(), `bureau-dist-bundling-${process.pid}-${Date.now()}.sqlite`);

    try {
      const distEntrypoint = '../dist/index.js';
      const distModule = (await import(distEntrypoint)) as { createBureau: typeof CreateBureau };

      const bureau = await distModule.createBureau({
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
