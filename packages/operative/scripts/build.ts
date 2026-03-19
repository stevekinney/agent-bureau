import { $ } from 'bun';

const entrypoints = [
  './src/index.ts',
  './src/run.ts',
  './src/create-run.ts',
  './src/loop.ts',
  './src/events.ts',
  './src/streaming.ts',
  './src/types.ts',
  './src/define-agent.ts',
  './src/create-subagent-tool.ts',
  './src/conditions/index.ts',
  './src/conditions/predicates.ts',
  './src/test/index.ts',
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
