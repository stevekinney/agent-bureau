/**
 * Proves the determinism gate's rules (AB-278) work and cannot be bypassed, by running ESLint
 * programmatically (`Linter.verify`) against fixture source text from `scripts/fixtures/
 * determinism/` under controlled, synthetic filenames. The synthetic manifest below matches
 * `scripts/determinism-manifest.json`'s real shape but uses a fixture-only package name so this
 * test is independent of the real manifest's actual entries.
 */
import { describe, expect, test } from 'bun:test';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { createDeterminismConfig, type DeterminismManifest } from '../eslint.config.base.ts';

const FIXTURE_REPO_ROOT = '/repo';

const fixtureManifest: DeterminismManifest = {
  deterministicDirectories: ['packages/fixture-package/src/test/**'],
  realRuntimeExemptions: [
    {
      path: 'packages/fixture-package/src/test/exempted/**',
      reason: 'fixture exemption exercised only by scripts/determinism-gate.test.ts',
      owner: 'Agent Bureau team',
      owningIssue: 'AB-278',
    },
  ],
};

function lintFixture(source: string, absoluteFilename: string): readonly string[] {
  // `cwd` must match FIXTURE_REPO_ROOT: ESLint's flat-config `files` globs are matched against
  // the filename relative to the linter's cwd, so without it an absolute filename outside the
  // real process cwd matches nothing and every rule silently no-ops.
  const linter = new Linter({ cwd: FIXTURE_REPO_ROOT });
  const messages = linter.verify(
    source,
    [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          ecmaVersion: 'latest' as const,
          sourceType: 'module' as const,
        },
        linterOptions: { noInlineConfig: true },
      },
      ...createDeterminismConfig(fixtureManifest, FIXTURE_REPO_ROOT),
    ],
    absoluteFilename,
  );
  return messages
    .map((message) => message.ruleId)
    .filter((ruleId): ruleId is string => ruleId !== null);
}

async function readFixture(name: string): Promise<string> {
  return Bun.file(new URL(`./fixtures/determinism/${name}`, import.meta.url)).text();
}

describe('determinism/no-real-runtime-call', () => {
  test('flags a real setTimeout call inside a deterministic test directory', async () => {
    const source = await readFixture('real-timer-call.ts');
    const ruleIds = lintFixture(
      source,
      `${FIXTURE_REPO_ROOT}/packages/fixture-package/src/test/real-timer-call.ts`,
    );
    expect(ruleIds).toEqual(['determinism/no-real-runtime-call']);
  });

  test('does not flag the same call under a manifested (exempted) path', async () => {
    const source = await readFixture('real-timer-call-under-exempted-path.ts');
    const ruleIds = lintFixture(
      source,
      `${FIXTURE_REPO_ROOT}/packages/fixture-package/src/test/exempted/real-timer-call-under-exempted-path.ts`,
    );
    expect(ruleIds).toEqual([]);
  });

  test('cannot be bypassed with an inline eslint-disable-next-line comment', async () => {
    const source = await readFixture('real-timer-call-with-disable-comment.ts');
    const ruleIds = lintFixture(
      source,
      `${FIXTURE_REPO_ROOT}/packages/fixture-package/src/test/real-timer-call-with-disable-comment.ts`,
    );
    expect(ruleIds).toEqual(['determinism/no-real-runtime-call']);
  });
});

describe('determinism/no-global-transport-mutation', () => {
  test('flags a globalThis.fetch assignment anywhere under packages/', async () => {
    const source = await readFixture('global-transport-assignment.ts');
    const ruleIds = lintFixture(
      source,
      `${FIXTURE_REPO_ROOT}/packages/fixture-package/src/ui/global-transport-assignment.ts`,
    );
    expect(ruleIds).toEqual(['determinism/no-global-transport-mutation']);
  });

  test('does not flag the same assignment under a manifested (exempted) path', async () => {
    const source = await readFixture('global-transport-assignment-under-exempted-path.ts');
    const ruleIds = lintFixture(
      source,
      `${FIXTURE_REPO_ROOT}/packages/fixture-package/src/test/exempted/global-transport-assignment-under-exempted-path.ts`,
    );
    expect(ruleIds).toEqual([]);
  });
});
