import { defineConfig } from 'tsdown';

/**
 * Entry map: each public subpath export resolves to its source file. Keys mirror the `exports`
 * targets in package.json (dist paths), values are the corresponding `src` entries. tsdown bundles
 * the JavaScript and the declarations, inlining the monorepo-internal foundation packages
 * (`lifecycle`, `interoperability`, `storage`) so the published artifacts carry no bare workspace
 * imports.
 *
 * Several exports map to non-`index` source files (the traps): `context`, `streaming`, `history`,
 * `schemas` are flat modules; `message` -> utilities/message; `redaction` -> plugins/pii-redaction.
 * The internal-only entry points the old hand-rolled build emitted purely for Bun's deep `.d.ts`
 * resolution are intentionally dropped — bundled declarations no longer need them.
 *
 * conversationalist ships ESM only (no `require` condition in `exports`), matching its prior build.
 */
const entry = {
  index: './src/index.ts',
  'conversation/index': './src/conversation/index.ts',
  context: './src/context.ts',
  streaming: './src/streaming.ts',
  history: './src/history.ts',
  'utilities/message': './src/utilities/message.ts',
  'utilities/index': './src/utilities/index.ts',
  'test/index': './src/test/index.ts',
  'markdown/index': './src/markdown/index.ts',
  'export/index': './src/export/index.ts',
  schemas: './src/schemas.ts',
  'adapters/openai/index': './src/adapters/openai/index.ts',
  'adapters/anthropic/index': './src/adapters/anthropic/index.ts',
  'adapters/gemini/index': './src/adapters/gemini/index.ts',
  'plugins/pii-redaction': './src/plugins/pii-redaction.ts',
  'versioning/index': './src/versioning/index.ts',
  'sort/index': './src/sort/index.ts',
  'composition/index': './src/composition/index.ts',
};

export default defineConfig({
  entry,
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: 'neutral',
  tsconfig: './tsconfig.build.json',
  // Real externals: the peer dependency and the genuine runtime deps. The foundation workspace
  // packages are deliberately NOT listed, so tsdown inlines them into the JS and the declarations.
  external: ['zod', 'gray-matter', /^bun(:|$)/, /^node:/],
});
