import { rmSync } from 'node:fs';

import { $ } from 'bun';

async function build() {
  console.log('Build');

  // Clean dist directory
  console.log('Cleaning dist directory...');
  rmSync('dist', { recursive: true, force: true });

  // Entry points to build
  const entryPoints = [
    { entry: './src/index.ts', outdir: 'dist' },
    { entry: './src/conversation/index.ts', outdir: 'dist/conversation' },
    { entry: './src/context.ts', outdir: 'dist' },
    { entry: './src/streaming.ts', outdir: 'dist' },
    { entry: './src/history.ts', outdir: 'dist' },
    { entry: './src/message.ts', outdir: 'dist' },
    { entry: './src/utilities.ts', outdir: 'dist' },
    { entry: './src/test/index.ts', outdir: 'dist/test' },
    { entry: './src/markdown/index.ts', outdir: 'dist/markdown' },
    { entry: './src/export/index.ts', outdir: 'dist/export' },
    { entry: './src/schemas/index.ts', outdir: 'dist/schemas' },
    { entry: './src/adapters/openai/index.ts', outdir: 'dist/adapters/openai' },
    { entry: './src/adapters/anthropic/index.ts', outdir: 'dist/adapters/anthropic' },
    { entry: './src/adapters/gemini/index.ts', outdir: 'dist/adapters/gemini' },
    { entry: './src/redaction/index.ts', outdir: 'dist/redaction' },
    { entry: './src/versioning/index.ts', outdir: 'dist/versioning' },
    { entry: './src/sort/index.ts', outdir: 'dist/sort' },
  ];

  // Build JavaScript with Bun (target node for npm compatibility)
  console.log('Building JavaScript...');
  for (const { entry, outdir } of entryPoints) {
    console.log(`  Building ${entry}...`);
    const buildResult =
      await $`bun build --target=node --outdir=${outdir} --sourcemap=linked --external=zod ${entry}`.quiet();

    if (buildResult.exitCode !== 0) {
      console.error(`JavaScript build failed for ${entry}`);
      console.error(buildResult.stderr.toString());
      process.exit(1);
    }
  }

  // Generate TypeScript declarations
  console.log('Generating TypeScript declarations...');
  const tscResult =
    await $`bunx tsc --emitDeclarationOnly --project tsconfig.build.json`.quiet();

  if (tscResult.exitCode !== 0) {
    console.error('Declaration generation failed');
    console.error(tscResult.stderr.toString());
    process.exit(1);
  }

  console.log('Build completed successfully');
}

build().catch((err) => {
  console.error(`Build failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
