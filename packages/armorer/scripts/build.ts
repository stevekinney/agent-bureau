import { $ } from 'bun';

const entrypoints = [
  './src/index.ts',
  './src/core/index.ts',
  './src/query/index.ts',
  './src/inspect/index.ts',
  './src/utilities/index.ts',
  './src/tools/index.ts',
  './src/instrumentation/index.ts',
  './src/middleware/index.ts',
  './src/truncation/index.ts',
  './src/test/index.ts',
  './src/integrations/mcp/index.ts',
  './src/adapters/open-ai/agents/index.ts',
  './src/adapters/openai/index.ts',
  './src/adapters/anthropic/index.ts',
  './src/adapters/gemini/index.ts',
  './src/idempotency/index.ts',
  // Internal modules referenced by index.d.ts (needed for Bun resolution)
  './src/events.ts',
  './src/combine-toolboxes.ts',
  './src/core/errors.ts',
  './src/core/registry/embeddings.ts',
  './src/core/registry/registry.ts',
  './src/core/registry/resolve-name.ts',
  './src/core/registry/index.ts',
  './src/core/tool-definition.ts',
  './src/create-tool.ts',
  './src/create-toolbox.ts',
  './src/is-tool.ts',
  './src/tool-materialization.ts',
  './src/types.ts',
  './src/idempotency/types.ts',
  './src/idempotency/key-generators.ts',
  './src/idempotency/create-tool-result-cache.ts',
  './src/idempotency/with-idempotency.ts',
  './src/idempotency/with-toolbox-idempotency.ts',
];

const root = './src';

// Clean dist folder
await $`rm -rf dist`;

// Build with Bun
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

// Generate declaration files
await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;

// Also create a CJS build
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
