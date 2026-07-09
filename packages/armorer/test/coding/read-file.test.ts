import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createRootJail, isPathTraversalError } from '../../src/coding/jail';
import { createReadFileTool, type ReadFileResult } from '../../src/coding/read-file';

describe('createReadFileTool', () => {
  let root: string;
  let outsideDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'read-file-root-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'read-file-outside-'));
    await writeFile(join(outsideDir, 'secret.txt'), 'top secret');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('reads the full contents of a small file', async () => {
    await writeFile(join(root, 'notes.txt'), 'line0\nline1\nline2');
    const jail = createRootJail(root);
    const tool = createReadFileTool({ jail });

    const result = (await tool({ path: 'notes.txt' })) as ReadFileResult;

    expect(result.content).toBe('line0\nline1\nline2');
    expect(result.totalLines).toBe(3);
    expect(result.startLine).toBe(0);
    expect(result.endLine).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('applies an offset/limit window over the file', async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line${index}`);
    await writeFile(join(root, 'lines.txt'), lines.join('\n'));
    const jail = createRootJail(root);
    const tool = createReadFileTool({ jail });

    const result = (await tool({ path: 'lines.txt', offset: 3, limit: 2 })) as ReadFileResult;

    expect(result.content).toBe('line3\nline4');
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(5);
    expect(result.totalLines).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('line-limit');
  });

  it('caps the read at maxBytes and marks the result as byte-capped', async () => {
    const content = 'x'.repeat(1000);
    await writeFile(join(root, 'big.txt'), content);
    const jail = createRootJail(root);
    const tool = createReadFileTool({ jail, maxBytes: 100 });

    const result = (await tool({ path: 'big.txt' })) as ReadFileResult;

    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('byte-cap');
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(100);
  });

  it('throws for a file that does not exist', async () => {
    const jail = createRootJail(root);
    const tool = createReadFileTool({ jail });

    let caught: unknown;
    try {
      await tool({ path: 'missing.txt' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  it('rejects an absolute path', async () => {
    const jail = createRootJail(root);
    const tool = createReadFileTool({ jail });

    let caught: unknown;
    try {
      await tool({ path: join(outsideDir, 'secret.txt') });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  it('rejects a ".." traversal path', async () => {
    const jail = createRootJail(root);
    const tool = createReadFileTool({ jail });

    let caught: unknown;
    try {
      await tool({ path: '../secret.txt' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  it('rejects reading through a symlink that escapes the root', async () => {
    await symlink(join(outsideDir, 'secret.txt'), join(root, 'escape.txt'));
    const jail = createRootJail(root);
    const tool = createReadFileTool({ jail });

    let caught: unknown;
    try {
      await tool({ path: 'escape.txt' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  it('is jailed even when reading from a nested directory', async () => {
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'c.txt'), 'nested');
    const jail = createRootJail(root);
    const tool = createReadFileTool({ jail });

    const result = (await tool({ path: 'a/b/c.txt' })) as ReadFileResult;
    expect(result.content).toBe('nested');
  });

  it('the underlying jail still rejects escapes directly', async () => {
    const jail = createRootJail(root);
    let caught: unknown;
    try {
      await jail.resolve('../../etc/passwd');
    } catch (error) {
      caught = error;
    }
    expect(isPathTraversalError(caught)).toBe(true);
  });
});
