import { rmSync } from 'node:fs';

import { $ } from 'bun';

async function build() {
  console.log('Build');
  console.log('Cleaning dist directory...');
  rmSync('dist', { recursive: true, force: true });

  console.log('Building JavaScript...');
  const buildResult =
    await $`bun build --target=node --outdir=dist --sourcemap=linked ./src/index.ts ./src/embeddings.ts`.quiet();

  if (buildResult.exitCode !== 0) {
    console.error('JavaScript build failed');
    console.error(buildResult.stderr.toString());
    process.exit(1);
  }

  console.log('Generating TypeScript declarations...');
  const tscResult = await $`bunx tsc --emitDeclarationOnly --project tsconfig.build.json`.quiet();

  if (tscResult.exitCode !== 0) {
    console.error('Declaration generation failed');
    console.error(tscResult.stderr.toString());
    process.exit(1);
  }

  console.log('Build completed successfully');
}

build().catch((error) => {
  console.error(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
