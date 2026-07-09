import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createGrepTool, type GrepResult } from '../../src/coding/grep';
import { createRootJail, type RootJail } from '../../src/coding/jail';

describe('createGrepTool', () => {
  let root: string;
  let outsideDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'grep-root-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'grep-outside-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const needle = 1;\nconst other = 2;\n');
    await writeFile(join(root, 'src', 'b.ts'), 'no match here\n');
    await writeFile(join(root, 'readme.md'), 'needle in the readme too\n');
    await writeFile(join(outsideDir, 'secret.ts'), 'needle should never be found here\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('finds matches across the root by default', async () => {
    const jail = createRootJail(root);
    const tool = createGrepTool({ jail });

    const result = (await tool({ pattern: 'needle' })) as GrepResult;

    expect(result.matches.length).toBe(2);
    expect(result.matches.map((match) => match.path).sort()).toEqual(['readme.md', 'src/a.ts']);
    expect(result.truncated).toBe(false);
  });

  it('narrows scope using the glob filter', async () => {
    const jail = createRootJail(root);
    const tool = createGrepTool({ jail });

    const result = (await tool({ pattern: 'needle', glob: 'src/**/*.ts' })) as GrepResult;

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/a.ts');
    expect(result.matches[0]?.line).toBe(1);
  });

  it('caps results at maxMatches and marks truncated', async () => {
    const many = Array.from({ length: 20 }, (_, index) => `needle-${index}`).join('\n');
    await writeFile(join(root, 'many.txt'), many);
    const jail = createRootJail(root);
    const tool = createGrepTool({ jail });

    const result = (await tool({ pattern: 'needle', maxMatches: 5 })) as GrepResult;

    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('accepts a safe regex flag', async () => {
    const jail = createRootJail(root);
    const tool = createGrepTool({ jail });

    const result = (await tool({ pattern: 'NEEDLE', flags: 'i' })) as GrepResult;

    expect(result.matches.length).toBe(2);
  });

  it('rejects an unsupported regex flag', async () => {
    const jail = createRootJail(root);
    const tool = createGrepTool({ jail });

    let caught: unknown;
    try {
      await tool({ pattern: 'needle', flags: 'g' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  it('rejects an invalid regular expression', async () => {
    const jail = createRootJail(root);
    const tool = createGrepTool({ jail });

    let caught: unknown;
    try {
      await tool({ pattern: '(unterminated' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  it('does not follow a symlink that escapes the root', async () => {
    await symlink(join(outsideDir, 'secret.ts'), join(root, 'escape.ts'));
    const jail = createRootJail(root);
    const tool = createGrepTool({ jail });

    const result = (await tool({ pattern: 'never be found' })) as GrepResult;

    expect(result.matches).toHaveLength(0);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'skips a file it cannot read rather than throwing',
    async () => {
      await writeFile(join(root, 'unreadable.ts'), 'needle inside an unreadable file\n');
      await chmod(join(root, 'unreadable.ts'), 0o000);

      const jail = createRootJail(root);
      const tool = createGrepTool({ jail });

      try {
        const result = (await tool({ pattern: 'needle', glob: 'unreadable.ts' })) as GrepResult;
        expect(result.matches).toHaveLength(0);
      } finally {
        await chmod(join(root, 'unreadable.ts'), 0o644);
      }
    },
  );

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
    const tool = createGrepTool({ jail: rejectingJail });

    const result = (await tool({ pattern: 'needle', glob: 'src/**/*.ts' })) as GrepResult;

    expect(result.matches).toHaveLength(0);
  });
});
