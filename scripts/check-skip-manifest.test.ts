import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  checkSkipManifest,
  evaluateSkipManifest,
  findSkipFindingsInSource,
  formatOrphanedEntry,
  formatViolation,
  parseSkipManifest,
  type SkipManifestEntry,
} from './check-skip-manifest';

const repositoryRoot = resolve(import.meta.dir, '..');
const fixturesDirectory = resolve(repositoryRoot, 'scripts/fixtures/skip-manifest');

async function loadFixture(name: string): Promise<{ filePath: string; sourceText: string }> {
  const filePath = `scripts/fixtures/skip-manifest/${name}`;
  const sourceText = await readFile(resolve(fixturesDirectory, name), 'utf-8');
  return { filePath, sourceText };
}

describe('findSkipFindingsInSource', () => {
  it('flags an unmanifested it.skip', async () => {
    const { filePath, sourceText } = await loadFixture('unmanifested-skip.ts');
    const { findings } = findSkipFindingsInSource(filePath, sourceText);

    expect(findings).toEqual([
      {
        filePath,
        testIdentifier: `${filePath} > a suite with an unmanifested skip > is skipped without a manifest entry`,
        kind: 'skip',
        line: 13,
      },
    ]);
  });

  it('flags an it.only even though it could be manifested', async () => {
    const { filePath, sourceText } = await loadFixture('only-even-manifested.ts');
    const { findings } = findSkipFindingsInSource(filePath, sourceText);

    expect(findings).toEqual([
      {
        filePath,
        testIdentifier: `${filePath} > is the only test that would run if this file were live`,
        kind: 'only',
        line: 9,
      },
    ]);
  });

  it('flags a conditional early return that is the first statement of a test body', async () => {
    const { filePath, sourceText } = await loadFixture('unmanifested-conditional-return.ts');
    const { findings } = findSkipFindingsInSource(filePath, sourceText);

    expect(findings).toEqual([
      {
        filePath,
        testIdentifier: `${filePath} > bails out early under a condition instead of asserting`,
        kind: 'conditional-early-return',
        line: 9,
      },
    ]);
  });

  it('finds no skip-like finding in an ordinary test', async () => {
    const { filePath, sourceText } = await loadFixture('ordinary.ts');
    const { findings, allTestIdentifiers } = findSkipFindingsInSource(filePath, sourceText);

    expect(findings).toEqual([]);
    expect([...allTestIdentifiers]).toEqual([`${filePath} > runs unconditionally and asserts`]);
  });

  it('does not treat a conditional return nested past the first statement as a skip', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { expect, it } from 'bun:test';
      it('asserts something after other work', () => {
        const value = 1;
        if (value > 0) {
          return;
        }
        expect(value).toBe(1);
      });
    `;
    const { findings } = findSkipFindingsInSource(filePath, sourceText);
    expect(findings).toEqual([]);
  });

  it('flags a brace-free conditional early return (if (x) return; with no block)', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { expect, it } from 'bun:test';
      it('bails out early without braces', () => {
        if (Bun.env['SOME_CONDITION'] !== 'set') return;
        expect(true).toBe(true);
      });
    `;
    const { findings } = findSkipFindingsInSource(filePath, sourceText);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('conditional-early-return');
  });

  it('does not flag a brace-free if statement whose branch is not a return', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { expect, it } from 'bun:test';
      it('logs under a condition without braces but always asserts', () => {
        if (Bun.env['VERBOSE']) console.log('verbose mode');
        expect(true).toBe(true);
      });
    `;
    const { findings } = findSkipFindingsInSource(filePath, sourceText);
    expect(findings).toEqual([]);
  });

  it('does not flag an if statement whose braced branch is not a return', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { expect, it } from 'bun:test';
      it('logs under a condition but always asserts', () => {
        if (Bun.env['VERBOSE']) {
          console.log('verbose mode');
        }
        expect(true).toBe(true);
      });
    `;
    const { findings } = findSkipFindingsInSource(filePath, sourceText);
    expect(findings).toEqual([]);
  });

  it('does not scan a describe callback body for a conditional early return', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { describe, expect, it } from 'bun:test';
      describe('a suite', () => {
        if (Bun.env['SKIP_SUITE']) {
          return;
        }
        it('still runs', () => {
          expect(true).toBe(true);
        });
      });
    `;
    const { findings } = findSkipFindingsInSource(filePath, sourceText);
    expect(findings).toEqual([]);
  });

  it('flags a conditional early return inside an .each-chained test callback (regression: PR #437 review)', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { expect, it } from 'bun:test';
      it.each([1, 2, 3])('handles %i', (value) => {
        if (value < 0) {
          return;
        }
        expect(value).toBeGreaterThanOrEqual(0);
      });
    `;
    const { findings } = findSkipFindingsInSource(filePath, sourceText);
    expect(findings).toEqual([
      {
        filePath,
        testIdentifier: `${filePath} > handles %i`,
        kind: 'conditional-early-return',
        line: 3,
      },
    ]);
  });

  it('flags it.skip.each as a skip, not as an ordinary test (regression: PR #437 review)', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { expect, it } from 'bun:test';
      it.skip.each([1, 2])('case %i', (value) => {
        expect(value).toBeGreaterThan(0);
      });
    `;
    const { findings } = findSkipFindingsInSource(filePath, sourceText);
    expect(findings).toEqual([
      {
        filePath,
        testIdentifier: `${filePath} > case %i`,
        kind: 'skip',
        line: 3,
      },
    ]);
  });

  it('does not record a phantom identifier for the intermediate .each(data) factory call, only the real declaration', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { expect, it } from 'bun:test';
      it.each([1, 2])('case %i', (value) => {
        expect(value).toBeGreaterThan(0);
      });
    `;
    const { allTestIdentifiers } = findSkipFindingsInSource(filePath, sourceText);
    expect([...allTestIdentifiers]).toEqual([`${filePath} > case %i`]);
  });

  it('does not treat it.skipIf as a manifestable skip, but does record its identifier and scan its body (regression: PR #437 review)', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { expect, it } from 'bun:test';
      it.skipIf(true)('conditionally skipped by the runtime, not this gate', () => {
        if (Bun.env['NEVER'] === 'set') {
          return;
        }
        expect(true).toBe(true);
      });
    `;
    const { findings, allTestIdentifiers } = findSkipFindingsInSource(filePath, sourceText);
    const testIdentifier = `${filePath} > conditionally skipped by the runtime, not this gate`;
    expect([...allTestIdentifiers]).toEqual([testIdentifier]);
    expect(findings).toEqual([
      { filePath, testIdentifier, kind: 'conditional-early-return', line: 3 },
    ]);
  });

  it('does not record a phantom identifier for an unresolved it.skipIf(cond) factory call by itself', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { it } from 'bun:test';
      const guarded = it.skipIf(true);
    `;
    const { findings, allTestIdentifiers } = findSkipFindingsInSource(filePath, sourceText);
    expect(findings).toEqual([]);
    expect([...allTestIdentifiers]).toEqual([]);
  });

  it('gives two dynamically-titled declarations in the same file distinct identifiers by line', () => {
    const filePath = 'inline.ts';
    const sourceText = `
      import { expect, it } from 'bun:test';
      const titleA = 'first';
      const titleB = 'second';
      it(titleA, () => {
        expect(true).toBe(true);
      });
      it(titleB, () => {
        expect(true).toBe(true);
      });
    `;
    const { allTestIdentifiers } = findSkipFindingsInSource(filePath, sourceText);
    expect([...allTestIdentifiers]).toEqual([
      `${filePath} > <unnamed:5>`,
      `${filePath} > <unnamed:8>`,
    ]);
  });
});

describe('evaluateSkipManifest', () => {
  it('does not flag a skip whose identifier is manifested', async () => {
    const { filePath, sourceText } = await loadFixture('manifested-skip.ts');
    const { findings, allTestIdentifiers } = findSkipFindingsInSource(filePath, sourceText);
    const testIdentifier = `${filePath} > a suite with a manifested skip > is skipped with a manifest entry`;
    const manifest: SkipManifestEntry[] = [
      {
        testIdentifier,
        owner: 'Agent Bureau team',
        reason: 'Fixture proving a manifested skip is not flagged.',
        environmentPredicate: 'none',
        removalCondition: 'This fixture is deleted.',
      },
    ];

    const result = evaluateSkipManifest(findings, allTestIdentifiers, manifest);
    expect(result.violations).toEqual([]);
    expect(result.orphanedEntries).toEqual([]);
  });

  it('still flags an it.only when its identifier is manifested', async () => {
    const { filePath, sourceText } = await loadFixture('only-even-manifested.ts');
    const { findings, allTestIdentifiers } = findSkipFindingsInSource(filePath, sourceText);
    const testIdentifier = `${filePath} > is the only test that would run if this file were live`;
    const manifest: SkipManifestEntry[] = [
      {
        testIdentifier,
        owner: 'Agent Bureau team',
        reason: 'Attempting to manifest an .only, which the gate must reject anyway.',
        environmentPredicate: 'none',
        removalCondition: 'This fixture is deleted.',
      },
    ];

    const result = evaluateSkipManifest(findings, allTestIdentifiers, manifest);
    expect(result.violations).toEqual([
      {
        filePath,
        testIdentifier,
        kind: 'only',
        line: 9,
        reason: 'only-cannot-be-manifested',
      },
    ]);
  });

  it('flags a manifest entry whose testIdentifier matches no discovered test', () => {
    const result = evaluateSkipManifest(
      [],
      new Set(['scripts/fixtures/skip-manifest/ordinary.ts > runs unconditionally and asserts']),
      [
        {
          testIdentifier:
            'scripts/fixtures/skip-manifest/does-not-exist.ts > a test that was deleted',
          owner: 'Agent Bureau team',
          reason: 'Stale entry.',
          environmentPredicate: 'none',
          removalCondition: 'Never — this is the orphan case under test.',
        },
      ],
    );

    expect(result.violations).toEqual([]);
    expect(result.orphanedEntries).toEqual([
      'scripts/fixtures/skip-manifest/does-not-exist.ts > a test that was deleted',
    ]);
  });
});

describe('parseSkipManifest', () => {
  it('accepts an empty array', () => {
    expect(parseSkipManifest([])).toEqual([]);
  });

  it('rejects a non-array value', () => {
    expect(() => parseSkipManifest({})).toThrow(TypeError);
  });

  it('rejects an entry missing a required field', () => {
    expect(() =>
      parseSkipManifest([
        { testIdentifier: 'x', owner: 'y', reason: 'z', environmentPredicate: 'none' },
      ]),
    ).toThrow(TypeError);
  });
});

describe('formatViolation', () => {
  it('names the file, the test, and the remediation sentence for an unmanifested skip', () => {
    const message = formatViolation({
      filePath: 'packages/example/src/thing.test.ts',
      testIdentifier: 'packages/example/src/thing.test.ts > a suite > a skipped test',
      kind: 'skip',
      line: 42,
      reason: 'unmanifested',
    });

    expect(message).toContain('packages/example/src/thing.test.ts:42');
    expect(message).toContain('packages/example/src/thing.test.ts > a suite > a skipped test');
    expect(message).toContain(
      'add an entry to scripts/skip-manifest.json with an owner, reason, environment predicate, and removal condition, or unskip the test',
    );
  });

  it('explains that .only can never be manifested', () => {
    const message = formatViolation({
      filePath: 'packages/example/src/thing.test.ts',
      testIdentifier: 'packages/example/src/thing.test.ts > an only test',
      kind: 'only',
      line: 7,
      reason: 'only-cannot-be-manifested',
    });

    expect(message).toContain('.only cannot be manifested');
  });
});

describe('formatOrphanedEntry', () => {
  it('names the stale testIdentifier', () => {
    expect(formatOrphanedEntry('some/file.test.ts > a deleted test')).toContain(
      'some/file.test.ts > a deleted test',
    );
  });
});

describe('checkSkipManifest against the real repository', () => {
  it('finds zero violations and zero orphaned entries on the current baseline', async () => {
    const result = await checkSkipManifest(repositoryRoot);
    expect(result.violations).toEqual([]);
    expect(result.orphanedEntries).toEqual([]);
  });

  it('actually walked packages/ and scripts/, proving the zero-violation result is not vacuous', async () => {
    const result = await checkSkipManifest(repositoryRoot);
    // Self-referential: this very file is under scripts/, so its presence proves the
    // `scripts/**/*.test.ts` glob ran rather than silently matching nothing.
    expect(result.scannedFiles).toContain('scripts/check-skip-manifest.test.ts');
    expect(result.scannedFiles.some((filePath) => filePath.startsWith('packages/'))).toBe(true);
    expect(result.scannedFiles.every((filePath) => !filePath.includes('node_modules/'))).toBe(true);
    expect(result.scannedFiles.length).toBeGreaterThan(100);
  });

  it('flags a hidden skip introduced under packages/, proving the gate actually runs (AB-100 method)', async () => {
    const { findings, allTestIdentifiers } = findSkipFindingsInSource(
      'packages/example/src/proof.test.ts',
      `
        import { expect, it } from 'bun:test';
        it.skip('a hidden skip the gate must catch', () => {
          expect(true).toBe(true);
        });
      `,
    );
    const result = evaluateSkipManifest(findings, allTestIdentifiers, []);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.reason).toBe('unmanifested');
  });
});
