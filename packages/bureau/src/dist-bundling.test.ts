import { readFile, rm } from 'node:fs/promises';
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
  it('keeps the scoped Operative root and subpaths external', async () => {
    const buildSource = await readFile(new URL('../scripts/build.ts', import.meta.url), 'utf-8');

    expect(buildSource).toContain("'@lostgradient/operative',");
    expect(buildSource).toContain("'@lostgradient/operative/*',");
    expect(buildSource).not.toContain("'operative',");
  });

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

  // Second regression test in this file, same class of bug: `scripts/build.ts`
  // externalized `conversationalist` for BOTH the ESM and CJS build passes.
  // `conversationalist` ships only "bun"/"browser"/"import"/"default" export
  // conditions — no `require` — but `builder.ts` imports `Conversation` from
  // it as a real runtime value. A CJS consumer of bureau's advertised
  // `require: './dist/builder/index.cjs'` export would get an emitted
  // `require('conversationalist')` that resolves (via the "default"
  // condition) to an ES module, which `require()` cannot load synchronously
  // in a CJS module under Node < 22 (`ERR_REQUIRE_ESM`).
  //
  // This is a STATIC check on the emitted output, not a dynamic `require()`
  // call — verified NOT to work as a dynamic check: Bun's own `require()`
  // and modern Node (25, installed on the machine this test was written on)
  // both transparently interop CJS-requiring-ESM and do not throw, so a
  // runtime `require()` call here would pass whether or not the bug is
  // present and give false confidence. The actual failure only reproduces
  // on Node < 22 without an available runtime to exercise it locally, so
  // this test instead encodes the invariant the fix depends on: the built
  // CJS output must never contain `require("conversationalist")`.
  it('does not require() conversationalist from the built CJS builder entrypoint', async () => {
    const cjsSource = await readFile(
      new URL('../dist/builder/index.cjs', import.meta.url),
      'utf-8',
    );
    expect(cjsSource).not.toContain('require("conversationalist")');
    expect(cjsSource).not.toContain("require('conversationalist')");
  });
});
