import { defineConfig } from 'tsdown';

/**
 * Each entry mirrors a public export in package.json. The foundation workspace packages are
 * intentionally not externalized so lifecycle and interoperability are inlined into both the
 * runtime and declaration output.
 */
const entry = {
  index: './src/index.ts',
  'bureau-types': './src/bureau-types.ts',
  'conditions/index': './src/conditions/index.ts',
  'durable/index': './src/durable/index.ts',
  'guardrails/index': './src/guardrails/index.ts',
  'instrumentation/index': './src/instrumentation/index.ts',
  'retry/index': './src/retry/index.ts',
  'streaming/index': './src/streaming/index.ts',
  'store/index': './src/store/index.ts',
  'test/index': './src/test/index.ts',
  anthropic: './src/anthropic.ts',
  openai: './src/openai.ts',
  gemini: './src/gemini.ts',
  'providers/index': './src/providers/index.ts',
  'providers/anthropic': './src/providers/anthropic.ts',
  'providers/openai': './src/providers/openai.ts',
  'providers/gemini': './src/providers/gemini.ts',
  'providers/fallover/index': './src/providers/fallover/index.ts',
  'providers/routing/index': './src/providers/routing/index.ts',
  'providers/streaming/index': './src/providers/streaming/index.ts',
  'providers/embeddings/index': './src/providers/embeddings/index.ts',
  'providers/embeddings/openai': './src/providers/embeddings/openai.ts',
  'providers/embeddings/gemini': './src/providers/embeddings/gemini.ts',
  'providers/embeddings/voyage': './src/providers/embeddings/voyage.ts',
  'providers/embeddings/ollama': './src/providers/embeddings/ollama.ts',
  'providers/instrumentation/index': './src/providers/instrumentation/index.ts',
  'providers/test/index': './src/providers/test/index.ts',
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
  deps: {
    neverBundle: [
      'armorer',
      'conversationalist',
      '@lostgradient/weft',
      'zod',
      '@anthropic-ai/sdk',
      '@google/generative-ai',
      'openai',
      '@opentelemetry/api',
      /^bun(:|$)/,
      /^node:/,
    ],
  },
});
