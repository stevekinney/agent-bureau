import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createRootJail, isPathTraversalError, PathTraversalError } from '../../src/coding/jail';

describe('createRootJail', () => {
  let root: string;
  let outsideDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'jail-root-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'jail-outside-'));

    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'file.txt'), 'inside');
    await writeFile(join(outsideDir, 'secret.txt'), 'outside');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('throws PathTraversalError when the root does not exist', () => {
    let caught: unknown;
    try {
      createRootJail(join(root, 'does-not-exist'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PathTraversalError);
  });

  it('throws PathTraversalError when the root is an empty string', () => {
    let caught: unknown;
    try {
      createRootJail('');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PathTraversalError);
  });

  it('canonicalizes the root', () => {
    const jail = createRootJail(root);
    expect(jail.root.endsWith(sep)).toBe(false);
  });

  it('resolves a nested relative path within the root', async () => {
    const jail = createRootJail(root);
    const resolved = await jail.resolve('nested/file.txt');
    expect(resolved).toBe(join(jail.root, 'nested', 'file.txt'));
  });

  it('resolves "." and harmless ".." segments that stay within the root', async () => {
    const jail = createRootJail(root);
    const resolved = await jail.resolve('nested/../nested/file.txt');
    expect(resolved).toBe(join(jail.root, 'nested', 'file.txt'));
  });

  it('rejects an absolute path', async () => {
    const jail = createRootJail(root);
    let caught: unknown;
    try {
      await jail.resolve(join(outsideDir, 'secret.txt'));
    } catch (error) {
      caught = error;
    }
    expect(isPathTraversalError(caught)).toBe(true);
  });

  it('rejects ".." traversal that escapes the root', async () => {
    const jail = createRootJail(root);
    let caught: unknown;
    try {
      await jail.resolve('../secret.txt');
    } catch (error) {
      caught = error;
    }
    expect(isPathTraversalError(caught)).toBe(true);
  });

  it('rejects a deeply nested ".." traversal that escapes the root', async () => {
    const jail = createRootJail(root);
    let caught: unknown;
    try {
      await jail.resolve('nested/../../../../../../etc/passwd');
    } catch (error) {
      caught = error;
    }
    expect(isPathTraversalError(caught)).toBe(true);
  });

  it('rejects a path containing a null byte', async () => {
    const jail = createRootJail(root);
    let caught: unknown;
    try {
      await jail.resolve('nested/file.txt\0.png');
    } catch (error) {
      caught = error;
    }
    expect(isPathTraversalError(caught)).toBe(true);
  });

  it('rejects an empty relative path', async () => {
    const jail = createRootJail(root);
    let caught: unknown;
    try {
      await jail.resolve('');
    } catch (error) {
      caught = error;
    }
    expect(isPathTraversalError(caught)).toBe(true);
  });

  it('rejects a symlink whose target is outside the root', async () => {
    await symlink(join(outsideDir, 'secret.txt'), join(root, 'escape-link.txt'));

    const jail = createRootJail(root);
    let caught: unknown;
    try {
      await jail.resolve('escape-link.txt');
    } catch (error) {
      caught = error;
    }
    expect(isPathTraversalError(caught)).toBe(true);
  });

  it('rejects a path through a symlinked directory whose target is outside the root', async () => {
    await symlink(outsideDir, join(root, 'escape-dir'), 'dir');

    const jail = createRootJail(root);
    let caught: unknown;
    try {
      await jail.resolve('escape-dir/secret.txt');
    } catch (error) {
      caught = error;
    }
    expect(isPathTraversalError(caught)).toBe(true);
  });

  it('allows a symlink whose target stays within the root', async () => {
    await symlink(join(root, 'nested', 'file.txt'), join(root, 'inside-link.txt'));

    const jail = createRootJail(root);
    const resolved = await jail.resolve('inside-link.txt');
    expect(resolved).toBe(join(jail.root, 'nested', 'file.txt'));
  });
});
