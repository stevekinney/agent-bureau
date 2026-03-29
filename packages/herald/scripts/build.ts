import { $ } from 'bun';

const entrypoints = [
  './src/index.ts',
  './src/types.ts',
  './src/errors.ts',
  './src/anthropic.ts',
  './src/openai.ts',
  './src/gemini.ts',
  './src/embeddings/index.ts',
  './src/embeddings/openai.ts',
  './src/embeddings/gemini.ts',
  './src/embeddings/voyage.ts',
  './src/embeddings/ollama.ts',
  './src/instrumentation/index.ts',
  './src/structured-output/index.ts',
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
