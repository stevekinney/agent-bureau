import { $ } from 'bun';

const entrypoints = [
  './src/index.ts',
  './src/types.ts',
  './src/matchers.ts',
  './src/metrics.ts',
  './src/create-agent-evaluation.ts',
  './src/comparison.ts',
  // Separate subpath: pulls in `operative/test` fixtures, which production
  // consumers of the main `evaluation` entrypoint (e.g. gateway) should not
  // eagerly load.
  './src/prompt-injection-benchmark.ts',
];

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
