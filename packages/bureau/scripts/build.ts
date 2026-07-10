import { $ } from 'bun';

const entrypoints = ['./src/index.ts', './src/builder/index.ts', './src/test/index.ts'];

const root = './src';

// Workspace and npm runtime dependencies stay external — never bundled into
// bureau's dist. Two independent reasons:
// 1. They are already published/built packages; bundling them duplicates code
//    across every dist that depends on bureau (mirrors gateway/scripts/build.ts).
// 2. `@lostgradient/weft`'s storage resolver (`resolveStorage`) lazily loads
//    backend adapters via `import('./bun-sql.js')`-style relative dynamic
//    imports resolved against weft's OWN installed module URL. Bundling that
//    code into bureau/dist rewrites its import.meta.url to bureau's bundle,
//    so the relative specifier can no longer find the adapter file at
//    runtime (`Cannot find module './bun-sql.js' from bureau/dist/index.js`).
//    Keeping weft external lets the dynamic import resolve against its own
//    package directory, where the adapter files actually live.
const esmExternal = [
  '@lostgradient/weft',
  '@lostgradient/weft/*',
  'armorer',
  'armorer/*',
  'conversationalist',
  'conversationalist/*',
  'interoperability',
  'interoperability/*',
  'lifecycle',
  'lifecycle/*',
  'memory',
  'memory/*',
  'operative',
  'operative/*',
  'skills',
  'skills/*',
  'zod',
];

// `conversationalist` ships only ESM/"bun"/"browser"/"default" export
// conditions — no `require`. `builder.ts` imports `Conversation` from it as
// a real runtime value (not just types), so if this CJS pass left it
// external, the emitted `require('conversationalist')` would resolve (via
// the "default" condition) to an ES module and throw `ERR_REQUIRE_ESM` in
// any Node < 22 CJS consumer — a real breakage of `bureau`'s own advertised
// `require: './dist/index.cjs'` export. Bundle it into the CJS output
// instead; every other external here (weft, armorer, operative, lifecycle,
// memory, skills, zod) DOES ship a `require` condition of its own, so
// leaving them external is safe for both formats. `interoperability` is
// imported type-only in bureau's source (erased at compile time either
// way), so its presence/absence here has no runtime effect — left in for
// documentation, not because it's load-bearing.
const cjsExternal = esmExternal.filter(
  (specifier) => specifier !== 'conversationalist' && specifier !== 'conversationalist/*',
);

await $`rm -rf dist`;

await Bun.build({
  entrypoints,
  outdir: './dist',
  root,
  target: 'bun',
  format: 'esm',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: true,
  external: esmExternal,
});

await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;

await Bun.build({
  entrypoints,
  outdir: './dist',
  root,
  target: 'node',
  format: 'cjs',
  naming: '[dir]/[name].cjs',
  sourcemap: 'external',
  minify: true,
  external: cjsExternal,
});

console.log('Build complete!');
