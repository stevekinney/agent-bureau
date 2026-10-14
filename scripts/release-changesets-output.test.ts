import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { changesetsOutputEvents, writeChangesetsOutput } from './release';

describe('changesetsOutputEvents', () => {
  test('gives each published package the git-tag event `changeset publish` writes', () => {
    expect(
      changesetsOutputEvents([
        { packageName: '@lostgradient/operative', version: '0.16.1' },
        { packageName: 'armorer', version: '1.2.3' },
      ]),
    ).toEqual([
      {
        type: 'git-tag',
        packageName: '@lostgradient/operative',
        tag: '@lostgradient/operative@0.16.1',
      },
      { type: 'git-tag', packageName: 'armorer', tag: 'armorer@1.2.3' },
    ]);
  });
});

describe('writeChangesetsOutput', () => {
  let fixtureDirectory: string | undefined;

  afterEach(async () => {
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
    fixtureDirectory = undefined;
  });

  test('writes one JSON line per published package', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'release-changesets-output-'));
    const outputPath = join(fixtureDirectory, 'changesets-output.ndjson');

    await writeChangesetsOutput([{ packageName: 'armorer', version: '1.2.3' }], outputPath);

    const lines = (await Bun.file(outputPath).text()).split('\n');
    expect(lines).toEqual(['{"type":"git-tag","packageName":"armorer","tag":"armorer@1.2.3"}', '']);
  });

  test('writes an empty file when nothing published, so the action finds the output it reads', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'release-changesets-output-'));
    const outputPath = join(fixtureDirectory, 'changesets-output.ndjson');

    await writeChangesetsOutput([], outputPath);

    expect(await Bun.file(outputPath).exists()).toBe(true);
    expect(await Bun.file(outputPath).text()).toBe('');
  });

  test('does nothing when no output path is set', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'release-changesets-output-'));

    await writeChangesetsOutput([{ packageName: 'armorer', version: '1.2.3' }], undefined);

    expect(await Array.fromAsync(new Bun.Glob('*').scan({ cwd: fixtureDirectory }))).toEqual([]);
  });
});
