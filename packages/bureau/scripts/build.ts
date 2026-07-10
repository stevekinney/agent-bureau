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
const external = [
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
  external,
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
  external,
});

console.log('Build complete!');
