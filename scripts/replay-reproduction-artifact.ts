#!/usr/bin/env bun
/**
 * AB-267 — the reproduction-artifact replay command (`bun run
 * test:replay-artifact -- <path>`). A thin CLI over
 * `@lostgradient/operative/test`'s `readReproductionArtifact` and
 * `replayReproductionArtifact`: this file owns argument parsing and process
 * exit status only. Every byte of replay LOGIC — reconstructing the manual
 * runtime, re-running the baseline case, comparing evidence — lives in
 * `packages/operative/src/test/artifact-io.ts`, which is coverage-gated;
 * `scripts/` is not, so a corrupted-field negative belongs in
 * `artifact-io.test.ts`, not here.
 *
 * Usage:
 *   bun run test:replay-artifact -- <path-to-artifact.json>
 *   bun run scripts/replay-reproduction-artifact.ts <path-to-artifact.json>
 */
import {
  InvalidReproductionArtifactError,
  readReproductionArtifact,
  replayReproductionArtifact,
  ReproductionArtifactMismatchError,
} from '@lostgradient/operative/test';

/**
 * `bun run <script-name> -- <args>` forwards everything after `--` as this
 * process's own argv; a caller invoking the underlying file directly
 * (`bun run scripts/replay-reproduction-artifact.ts <path>`) never has a
 * literal `--` to strip. Tolerate both: drop one leading `--` if present,
 * then take the first remaining argument as the path.
 */
function resolveArtifactPath(argv: readonly string[]): string {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const path = args[0];
  if (!path) {
    throw new Error(
      'replay-reproduction-artifact: missing required <path> argument.\n' +
        'Usage: bun run test:replay-artifact -- <path-to-artifact.json>',
    );
  }
  return path;
}

async function main(): Promise<void> {
  const path = resolveArtifactPath(Bun.argv.slice(2));

  const artifact = await readReproductionArtifact(path);
  await replayReproductionArtifact(artifact);

  console.log(`replay-reproduction-artifact: ${path} replayed clean.`);
}

main().catch((error: unknown) => {
  if (
    error instanceof InvalidReproductionArtifactError ||
    error instanceof ReproductionArtifactMismatchError
  ) {
    console.error(`replay-reproduction-artifact: ${error.message}`);
  } else {
    console.error('replay-reproduction-artifact: unexpected failure', error);
  }
  process.exit(1);
});
