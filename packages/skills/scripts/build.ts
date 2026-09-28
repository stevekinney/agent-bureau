import { $ } from 'bun';

const entrypoints = ['./src/index.ts', './src/types.ts', './src/test/index.ts'];

const root = './src';

await $`rm -rf dist`;

await Bun.build({
  entrypoints,
  outdir: './dist',
  root,
  target: 'bun',
  format: 'esm',
  packages: 'external',
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
  packages: 'external',
  naming: '[dir]/[name].cjs',
  sourcemap: 'external',
  minify: true,
});

console.log('Build complete!');
