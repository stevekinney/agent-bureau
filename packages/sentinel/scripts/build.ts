import { $ } from 'bun';

// Only the subpath-exported modules need their own entrypoint; everything else (events, types) is
// re-exported through index.ts and bundled transitively. See package.json `exports`.
const entrypoints = ['./src/index.ts', './src/test/index.ts'];

const root = './src';

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
});

console.log('Build complete!');
