import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  checkRuntimeMatrix,
  findRuntimeMatrixErrors,
  floorIsExercised,
  parseEngineFloors,
  parseExercisedVersions,
  readWorkspaceManifests,
} from './check-runtime-matrix';

describe('parseEngineFloors', () => {
  test('extracts a single floor from a simple lower-bound range', () => {
    expect(parseEngineFloors('>=22')).toEqual(['22']);
  });

  test('extracts a dotted floor', () => {
    expect(parseEngineFloors('>=1.4.0')).toEqual(['1.4.0']);
  });

  test('extracts one floor per || clause', () => {
    expect(parseEngineFloors('^20.16.0 || >=22.3.0')).toEqual(['20.16.0', '22.3.0']);
  });

  test('extracts every floor from a three-way union', () => {
    expect(parseEngineFloors('^20.19.0 || ^22.12.0 || >=24')).toEqual(['20.19.0', '22.12.0', '24']);
  });

  test('returns an empty array when a clause has no version number', () => {
    expect(parseEngineFloors('*')).toEqual([]);
  });
});

describe('floorIsExercised', () => {
  test('matches a major-only floor against a major-only exercised version', () => {
    expect(floorIsExercised('22', new Set(['22']))).toBe(true);
  });

  test('does not match a different major', () => {
    expect(floorIsExercised('18', new Set(['22']))).toBe(false);
  });

  test('treats a coarse major-only exercised pin as satisfying a more precise floor', () => {
    expect(floorIsExercised('22.3.0', new Set(['22']))).toBe(true);
  });

  test('matches a fully dotted floor against an equal exercised version', () => {
    expect(floorIsExercised('1.4.0', new Set(['1.4.0']))).toBe(true);
  });

  test('does not match a fully dotted floor against a different patch', () => {
    expect(floorIsExercised('1.4.0', new Set(['1.4.1']))).toBe(false);
  });

  test('skips a non-numeric exercised token without matching or throwing', () => {
    expect(floorIsExercised('22', new Set(['current']))).toBe(false);
  });

  test('returns false when the floor itself is not numeric', () => {
    expect(floorIsExercised('current', new Set(['22']))).toBe(false);
  });
});

describe('parseExercisedVersions', () => {
  test('collects a plain scalar node-version and bun-version', () => {
    const exercised = parseExercisedVersions(
      [
        'jobs:',
        '  validate:',
        '    steps:',
        '      - node-version: 22',
        '      - bun-version: 1.4.0',
      ].join('\n'),
    );

    expect(exercised.node).toEqual(new Set(['22']));
    expect(exercised.bun).toEqual(new Set(['1.4.0']));
  });

  test('collects every entry from a bracketed matrix-strategy list', () => {
    const exercised = parseExercisedVersions(
      ['strategy:', '  matrix:', '    node-version: [22, current]'].join('\n'),
    );

    expect(exercised.node).toEqual(new Set(['22', 'current']));
  });

  test('strips quotes from a quoted scalar version', () => {
    const exercised = parseExercisedVersions("node-version: '22'");
    expect(exercised.node).toEqual(new Set(['22']));
  });

  test('returns empty sets for a workflow with neither key', () => {
    const exercised = parseExercisedVersions('jobs:\n  lint:\n    steps: []');
    expect(exercised.node.size).toBe(0);
    expect(exercised.bun.size).toBe(0);
  });

  test('ignores a node-version mention inside a YAML comment', () => {
    // Regression: this repository's own ci.yml carries explanatory comments that mention
    // `node-version: current` in prose. A comment must never count as an exercised version — only
    // a real `with:` input does.
    const exercised = parseExercisedVersions(
      [
        '# See node-version: current for context.',
        'jobs:',
        '  validate:',
        '    steps:',
        '      - node-version: 22',
      ].join('\n'),
    );

    expect(exercised.node).toEqual(new Set(['22']));
  });

  test('ignores a bun-version mention inside a YAML comment', () => {
    const exercised = parseExercisedVersions(
      ['# bun-version: 9.9.9 is not actually installed anywhere.', 'bun-version: 1.4.0'].join('\n'),
    );

    expect(exercised.bun).toEqual(new Set(['1.4.0']));
  });

  test('still reads a real key on a line whose comment portion also mentions a key', () => {
    const exercised = parseExercisedVersions('node-version: 22 # not node-version: 99');
    expect(exercised.node).toEqual(new Set(['22']));
  });
});

describe('findRuntimeMatrixErrors', () => {
  const exercised = { node: new Set(['22']), bun: new Set(['1.4.0']) };

  test('returns no errors for a manifest whose declared floors are all exercised', () => {
    const errors = findRuntimeMatrixErrors(
      [
        {
          packageLabel: 'packages/fixture-exercised/package.json',
          engines: { node: '>=22', bun: '>=1.4.0' },
        },
      ],
      exercised,
    );

    expect(errors).toEqual([]);
  });

  test('names the package and the unproven version for an unexercised floor', () => {
    const errors = findRuntimeMatrixErrors(
      [{ packageLabel: 'packages/fixture-unexercised/package.json', engines: { node: '>=18' } }],
      exercised,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('packages/fixture-unexercised/package.json');
    expect(errors[0]).toContain('floor 18');
  });

  test('reports each unproven clause of a multi-range floor independently', () => {
    const errors = findRuntimeMatrixErrors(
      [
        {
          packageLabel: 'packages/fixture-multi/package.json',
          engines: { node: '^20.16.0 || >=22.3.0' },
        },
      ],
      exercised,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('floor 20.16.0');
  });

  test('skips a manifest with no engines field', () => {
    expect(
      findRuntimeMatrixErrors([{ packageLabel: 'packages/no-engines/package.json' }], exercised),
    ).toEqual([]);
  });

  test('skips an engines field with neither node nor bun', () => {
    expect(
      findRuntimeMatrixErrors(
        [{ packageLabel: 'packages/other-engine/package.json', engines: { deno: '>=2' } }],
        exercised,
      ),
    ).toEqual([]);
  });
});

async function writeFixturePackageJson(
  root: string,
  relativePath: string,
  contents: Record<string, unknown>,
): Promise<void> {
  const fullPath = join(root, relativePath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, JSON.stringify(contents, null, 2));
}

describe('readWorkspaceManifests + checkRuntimeMatrix (fixture end-to-end)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'runtime-matrix-fixture-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('readWorkspaceManifests reads the root manifest and every packages/*/package.json, sorted', async () => {
    await writeFixturePackageJson(root, 'package.json', {
      name: 'root-fixture',
      engines: { node: '>=22' },
    });
    await writeFixturePackageJson(root, 'packages/beta/package.json', { name: 'beta' });
    await writeFixturePackageJson(root, 'packages/alpha/package.json', {
      name: 'alpha',
      engines: { bun: '>=1.4.0' },
    });

    const manifests = await readWorkspaceManifests(root);

    expect(manifests).toEqual([
      { packageLabel: 'package.json', engines: { node: '>=22' } },
      { packageLabel: 'packages/alpha/package.json', engines: { bun: '>=1.4.0' } },
      { packageLabel: 'packages/beta/package.json', engines: undefined },
    ]);
  });

  test('the fixture pair: a manifest whose floor the fixture workflow exercises passes', async () => {
    await writeFixturePackageJson(root, 'package.json', {
      name: 'root-fixture',
      engines: { node: '>=22' },
    });
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    await writeFile(
      join(root, '.github/workflows/ci.yml'),
      ['jobs:', '  validate:', '    steps:', '      - node-version: 22'].join('\n'),
    );

    const manifests = await checkRuntimeMatrix(root);

    expect(manifests).toEqual([{ packageLabel: 'package.json', engines: { node: '>=22' } }]);
  });

  test('the fixture pair: a manifest whose floor the fixture workflow does not exercise fails, naming the package and the version', async () => {
    await writeFixturePackageJson(root, 'package.json', {
      name: 'root-fixture',
      engines: { node: '>=18' },
    });
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    await writeFile(
      join(root, '.github/workflows/ci.yml'),
      ['jobs:', '  validate:', '    steps:', '      - node-version: 22'].join('\n'),
    );

    await expect(checkRuntimeMatrix(root)).rejects.toThrow(/package\.json.*floor 18/s);
  });
});
