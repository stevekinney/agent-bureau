/**
 * Proves the determinism gate's rules (AB-278) work and cannot be bypassed, by running ESLint
 * programmatically (`Linter.verify`) against fixture source text from `scripts/fixtures/
 * determinism/` under controlled, synthetic filenames. The synthetic manifest below matches
 * `scripts/determinism-manifest.json`'s real shape but uses a fixture-only package name so this
 * test is independent of the real manifest's actual entries.
 */
import { describe, expect, test } from 'bun:test';
import { Linter } from 'eslint';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import {
  createDeterminismConfig,
  parseDeterminismManifest,
  toRepoRelativePosixPath,
  type DeterminismManifest,
} from '../eslint.config.base.ts';

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
          // `setTimeout`/`crypto`/`performance` etc. are host globals, not ECMAScript builtins —
          // without this, `isGlobalReference` sees them as unresolved-but-unconfigured and the
          // rules never flag them. Matches the real baseConfig's own globals.
          globals: { ...globals.node, ...globals.browser },
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

function lintSourceInDeterministicDirectory(source: string): readonly string[] {
  return lintFixture(source, `${FIXTURE_REPO_ROOT}/packages/fixture-package/src/test/x.ts`);
}

function lintSourceUnderPackages(source: string): readonly string[] {
  return lintFixture(source, `${FIXTURE_REPO_ROOT}/packages/fixture-package/src/ui/x.ts`);
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

  test('flags a computed-property assignment (globalThis["fetch"] = ...) the same as dot notation', () => {
    const ruleIds = lintSourceUnderPackages("globalThis['fetch'] = fake;\n");
    expect(ruleIds).toEqual(['determinism/no-global-transport-mutation']);
  });

  test('does not flag a non-literal computed property (cannot be resolved statically)', () => {
    const ruleIds = lintSourceUnderPackages('globalThis[propertyName] = fake;\n');
    expect(ruleIds).toEqual([]);
  });

  test('does not flag a local parameter shadowing the name "global"', () => {
    const ruleIds = lintSourceUnderPackages(
      'function install(global) {\n  global.fetch = fake;\n}\n',
    );
    expect(ruleIds).toEqual([]);
  });

  test('flags a TypeScript type-assertion-wrapped target ((globalThis as unknown as Env).fetch = ...)', () => {
    const ruleIds = lintSourceUnderPackages('(globalThis as unknown as Env).fetch = fake;\n');
    expect(ruleIds).toEqual(['determinism/no-global-transport-mutation']);
  });

  test('flags a non-null-asserted target (globalThis!.fetch = ...)', () => {
    const ruleIds = lintSourceUnderPackages('globalThis!.fetch = fake;\n');
    expect(ruleIds).toEqual(['determinism/no-global-transport-mutation']);
  });
});

describe('scope-aware detection (regression coverage for injected-runtime false positives)', () => {
  test('does not flag setTimeout destructured from an injected runtime', () => {
    const ruleIds = lintSourceInDeterministicDirectory(
      'function scheduleRetry(callback) {\n  const { setTimeout } = runtime;\n  setTimeout(callback, 1);\n}\n',
    );
    expect(ruleIds).toEqual([]);
  });

  test('does not flag Date.now() when Date is shadowed by a local binding', () => {
    const ruleIds = lintSourceInDeterministicDirectory(
      'function stamp(Date) {\n  return Date.now();\n}\n',
    );
    expect(ruleIds).toEqual([]);
  });

  test('still flags the real global setTimeout when nothing shadows it', () => {
    const ruleIds = lintSourceInDeterministicDirectory(
      'function scheduleRetry(callback) {\n  setTimeout(callback, 1);\n}\n',
    );
    expect(ruleIds).toEqual(['determinism/no-real-runtime-call']);
  });

  test('flags a host-global-qualified timer call (globalThis.setTimeout)', () => {
    const ruleIds = lintSourceInDeterministicDirectory(
      'function scheduleRetry(callback) {\n  globalThis.setTimeout(callback, 1);\n}\n',
    );
    expect(ruleIds).toEqual(['determinism/no-real-runtime-call']);
  });

  test('flags a host-global-qualified timer call (window.setInterval)', () => {
    const ruleIds = lintSourceInDeterministicDirectory('window.setInterval(callback, 1);\n');
    expect(ruleIds).toEqual(['determinism/no-real-runtime-call']);
  });

  test('does not flag globalThis.setTimeout when globalThis is shadowed by a local parameter', () => {
    const ruleIds = lintSourceInDeterministicDirectory(
      'function scheduleRetry(globalThis, callback) {\n  globalThis.setTimeout(callback, 1);\n}\n',
    );
    expect(ruleIds).toEqual([]);
  });

  test('flags a host-qualified clock call (globalThis.Date.now())', () => {
    const ruleIds = lintSourceInDeterministicDirectory('globalThis.Date.now();\n');
    expect(ruleIds).toEqual(['determinism/no-real-runtime-call']);
  });

  test('flags a host-qualified randomness call (window.crypto.randomUUID())', () => {
    const ruleIds = lintSourceInDeterministicDirectory('window.crypto.randomUUID();\n');
    expect(ruleIds).toEqual(['determinism/no-real-runtime-call']);
  });

  test('flags a type-asserted bare timer callee ((setTimeout as typeof setTimeout)(...))', () => {
    const ruleIds = lintSourceInDeterministicDirectory(
      '(setTimeout as typeof setTimeout)(callback, 1);\n',
    );
    expect(ruleIds).toEqual(['determinism/no-real-runtime-call']);
  });

  test('does not flag globalThis.Date.now() when Date is shadowed inside a destructure', () => {
    const ruleIds = lintSourceInDeterministicDirectory(
      'function stamp() {\n  const { Date } = fakes;\n  return Date.now();\n}\n',
    );
    expect(ruleIds).toEqual([]);
  });
});

describe('parseDeterminismManifest', () => {
  test('rejects an exemption with an empty reason or owningIssue', () => {
    expect(() =>
      parseDeterminismManifest({
        deterministicDirectories: ['packages/*/src/test/**'],
        realRuntimeExemptions: [
          { path: 'packages/x/**', reason: '', owner: 'team', owningIssue: '' },
        ],
      }),
    ).toThrow(/non-empty string/);
  });

  test('rejects an exemption with a whitespace-only reason', () => {
    expect(() =>
      parseDeterminismManifest({
        deterministicDirectories: ['packages/*/src/test/**'],
        realRuntimeExemptions: [
          { path: 'packages/x/**', reason: '   ', owner: 'team', owningIssue: 'AB-1' },
        ],
      }),
    ).toThrow(/non-empty string/);
  });

  test('accepts a well-formed manifest', () => {
    const manifest = parseDeterminismManifest({
      deterministicDirectories: ['packages/*/src/test/**'],
      realRuntimeExemptions: [
        { path: 'packages/x/**', reason: 'real reason', owner: 'team', owningIssue: 'AB-1' },
      ],
    });
    expect(manifest.deterministicDirectories).toEqual(['packages/*/src/test/**']);
  });
});

describe('toRepoRelativePosixPath', () => {
  test('normalizes a Windows-style filename and repo root before removing the prefix', () => {
    expect(
      toRepoRelativePosixPath('C:\\repo\\packages\\memory\\src\\test\\index.ts', 'C:\\repo'),
    ).toBe('packages/memory/src/test/index.ts');
  });

  test('handles a POSIX filename and repo root unchanged', () => {
    expect(toRepoRelativePosixPath('/repo/packages/memory/src/test/index.ts', '/repo')).toBe(
      'packages/memory/src/test/index.ts',
    );
  });
});
