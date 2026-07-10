import { defineConfig } from 'tsdown';

/**
 * Entry map: each public subpath export resolves to its source file. Keys mirror the `exports`
 * targets in package.json (dist paths), values are the corresponding `src` entries. tsdown bundles
 * the JavaScript and the declarations, inlining the monorepo-internal foundation packages
 * (`lifecycle`, `interoperability`) so the published artifacts carry no bare workspace imports.
 *
 * Non-`index` and remapped entries (the traps): `lazy` -> create-tool, `registry` ->
 * core/registry, `mcp` -> integrations/mcp. The internal-only entry points the old hand-rolled
 * build emitted purely for Bun's deep `.d.ts` resolution are intentionally dropped — bundled
 * declarations no longer need them.
 */
const entry = {
  index: './src/index.ts',
  'core/index': './src/core/index.ts',
  'query/index': './src/query/index.ts',
  'inspect/index': './src/inspect/index.ts',
  'utilities/index': './src/utilities/index.ts',
  'tools/index': './src/tools/index.ts',
  'instrumentation/index': './src/instrumentation/index.ts',
  'middleware/index': './src/middleware/index.ts',
  'truncation/index': './src/truncation/index.ts',
  'test/index': './src/test/index.ts',
  'idempotency/index': './src/idempotency/index.ts',
  'coding/index': './src/coding/index.ts',
  'create-tool': './src/create-tool.ts',
  'core/registry/index': './src/core/registry/index.ts',
  'integrations/mcp/index': './src/integrations/mcp/index.ts',
  'integrations/openapi/index': './src/integrations/openapi/index.ts',
  'adapters/openai/index': './src/adapters/openai/index.ts',
  'adapters/anthropic/index': './src/adapters/anthropic/index.ts',
  'adapters/gemini/index': './src/adapters/gemini/index.ts',
  'adapters/open-ai/agents/index': './src/adapters/open-ai/agents/index.ts',
};

export default defineConfig({
  entry,
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  platform: 'neutral',
  tsconfig: './tsconfig.build.json',
  // Real externals: peer dependencies and the runtime. The foundation workspace packages are
  // deliberately NOT listed here, so tsdown inlines them into both the JS and the declarations.
  external: [
    'zod',
    '@modelcontextprotocol/sdk',
    '@openai/agents',
    '@opentelemetry/api',
    /^bun(:|$)/,
    /^node:/,
  ],
});
