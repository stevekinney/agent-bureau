import { $ } from 'bun';

const entrypoints = [
  './src/index.ts',
  './src/run.ts',
  './src/create-run.ts',
  './src/loop.ts',
  './src/errors.ts',
  './src/events.ts',
  './src/streaming.ts',
  './src/types.ts',
  './src/define-agent.ts',
  './src/create-scratchpad.ts',
  './src/create-agent-registry.ts',
  './src/create-supervisor.ts',
  './src/create-subagent-tool.ts',
  './src/create-early-stopping-handler.ts',
  './src/create-handoff-tool.ts',
  './src/cost-estimation.ts',
  './src/cost-budget-monitor.ts',
  './src/agent-session.ts',
  './src/backpressure.ts',
  './src/conditions/index.ts',
  './src/conditions/predicates.ts',
  './src/instrumentation/index.ts',
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
