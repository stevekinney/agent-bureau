import { $ } from 'bun';

const entrypoints = [
  './src/index.ts',
  './src/run.ts',
  './src/create-run.ts',
  './src/loop.ts',
  './src/errors.ts',
  './src/events.ts',
  './src/generate-middleware.ts',
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
  './src/create-context-compactor.ts',
  './src/create-identity-hook.ts',
  './src/create-memory-bridge.ts',
  './src/create-policy-enforcement-hook.ts',
  './src/conditions/index.ts',
  './src/conditions/predicates.ts',
  './src/instrumentation/index.ts',
  './src/scheduler/index.ts',
  './src/scheduler/types.ts',
  './src/scheduler/priority-queue.ts',
  './src/scheduler/sleep.ts',
  './src/scheduler/events.ts',
  './src/scheduler/create-scheduler.ts',
  './src/scheduler/create-heartbeat.ts',
  './src/scheduler/create-chunked-task.ts',
  './src/session/index.ts',
  './src/session/types.ts',
  './src/session/create-session-store.ts',
  './src/session/session-resume.ts',
  './src/structured-output/index.ts',
  './src/test/index.ts',
  './src/context/index.ts',
  './src/context/token-budget.ts',
  './src/context/assembly.ts',
  './src/context/compaction-strategies.ts',
  './src/context/subagent-context.ts',
  './src/context/types.ts',
  './src/hooks/index.ts',
  './src/hooks/types.ts',
  './src/hooks/composition.ts',
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
