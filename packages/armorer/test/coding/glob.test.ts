import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createGlobTool, type GlobResult } from '../../src/coding/glob';
import { createRootJail, type RootJail } from '../../src/coding/jail';

describe('createGlobTool', () => {
  let root: string;
  let outsideDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'glob-root-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'glob-outside-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'a');
    await writeFile(join(root, 'src', 'b.ts'), 'b');
    await writeFile(join(root, 'readme.md'), 'r');
    await writeFile(join(outsideDir, 'leak.ts'), 'leak');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('lists paths matching a repository-relative pattern', async () => {
    const jail = createRootJail(root);
    const tool = createGlobTool({ jail });

    const result = (await tool({ pattern: 'src/**/*.ts' })) as GlobResult;

    expect(result.paths.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.truncated).toBe(false);
  });

  it('caps results at maxResults and marks truncated', async () => {
    const jail = createRootJail(root);
    const tool = createGlobTool({ jail });

    const result = (await tool({ pattern: '**/*', maxResults: 1 })) as GlobResult;

    expect(result.paths).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('rejects an absolute pattern', async () => {
    const jail = createRootJail(root);
    const tool = createGlobTool({ jail });

    let caught: unknown;
    try {
      await tool({ pattern: '/etc/**' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  it('rejects a pattern containing a null byte', async () => {
    const jail = createRootJail(root);
    const tool = createGlobTool({ jail });

    let caught: unknown;
    try {
      await tool({ pattern: 'src/\0evil' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  it('rejects a pattern that traverses outside the root', async () => {
    const jail = createRootJail(root);
    const tool = createGlobTool({ jail });

    let caught: unknown;
    try {
      await tool({ pattern: '../**' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  it('does not include a symlinked entry that escapes the root', async () => {
    await symlink(outsideDir, join(root, 'escape-dir'), 'dir');
    const jail = createRootJail(root);
    const tool = createGlobTool({ jail });

    const result = (await tool({ pattern: '**/*' })) as GlobResult;

    expect(result.paths.every((path) => !path.startsWith('escape-dir'))).toBe(true);
  });

  it('skips a matched candidate the jail rejects, deterministically', async () => {
    const realJail = createRootJail(root);
    const rejectingJail: RootJail = {
      root: realJail.root,
      resolve: async (relativePath: string) => {
        if (relativePath === 'src/a.ts') {
          throw new Error('forced rejection for test');
        }
        return realJail.resolve(relativePath);
      },
    };
    const tool = createGlobTool({ jail: rejectingJail });

    const result = (await tool({ pattern: 'src/**/*.ts' })) as GlobResult;

    expect(result.paths).toEqual(['src/b.ts']);
  });
});
