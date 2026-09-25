import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { resolveWorkspaceRange, rewriteWorkspaceDependencies } from './release';

describe('resolveWorkspaceRange', () => {
  test('`workspace:*` becomes the exact version -- matching what `bun pm pack` itself produces', () => {
    // Verified directly against tool-protocol's real packed tarball: `bun pm pack` turned
    // `"@lostgradient/lifecycle": "workspace:*"` into `"@lostgradient/lifecycle": "0.0.1"`, with no
    // operator. This is the only form this workspace's package.json files actually use today.
    expect(resolveWorkspaceRange('workspace:*', '0.0.1')).toBe('0.0.1');
  });

  test('`workspace:^` carries the caret through', () => {
    expect(resolveWorkspaceRange('workspace:^', '2.4.0')).toBe('^2.4.0');
  });

  test('`workspace:~` carries the tilde through', () => {
    expect(resolveWorkspaceRange('workspace:~', '2.4.0')).toBe('~2.4.0');
  });

  test('an explicit version pinned under the workspace: protocol is used as given', () => {
    expect(resolveWorkspaceRange('workspace:1.2.3', '9.9.9')).toBe('1.2.3');
  });
});

describe('rewriteWorkspaceDependencies', () => {
  let fixtureDirectory: string;

  afterEach(async () => {
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
  });

  test('rewrites workspace: specifiers in dependencies/peerDependencies/optionalDependencies, leaves devDependencies and ordinary externals untouched', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'release-workspace-rewrite-'));
    const manifestPath = join(fixtureDirectory, 'package.json');
    const before = {
      name: 'conversationalist',
      version: '1.3.0',
      dependencies: {
        '@lostgradient/lifecycle': 'workspace:*',
        '@lostgradient/tool-protocol': 'workspace:*',
        'gray-matter': '^4.0.3',
      },
      peerDependencies: {
        zod: '^4.4.3',
      },
      optionalDependencies: {
        '@lostgradient/lifecycle': 'workspace:*',
      },
      devDependencies: {
        // Nothing in this workspace actually puts a `workspace:` specifier in devDependencies
        // today (verified by scanning every packages/*/package.json), but the rewrite step must
        // still leave this section alone by design -- npm never installs it for a consumer.
        typescript: '6.0.3',
      },
    };
    await Bun.write(manifestPath, JSON.stringify(before, null, 2));

    await rewriteWorkspaceDependencies(
      fixtureDirectory,
      new Map([
        ['@lostgradient/lifecycle', '0.0.1'],
        ['@lostgradient/tool-protocol', '0.0.0'],
      ]),
    );

    const after = (await Bun.file(manifestPath).json()) as typeof before;

    expect(after.dependencies).toEqual({
      '@lostgradient/lifecycle': '0.0.1',
      '@lostgradient/tool-protocol': '0.0.0',
      'gray-matter': '^4.0.3', // an ordinary external, untouched
    });
    expect(after.optionalDependencies).toEqual({ '@lostgradient/lifecycle': '0.0.1' });
    expect(after.peerDependencies).toEqual({ zod: '^4.4.3' }); // no workspace: specifier, untouched
    expect(after.devDependencies).toEqual({ typescript: '6.0.3' }); // left alone by design
  });

  test('throws with a clear message rather than silently skipping when a workspace: target has no resolvable sibling', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'release-workspace-rewrite-'));
    const manifestPath = join(fixtureDirectory, 'package.json');
    await Bun.write(
      manifestPath,
      JSON.stringify(
        {
          name: 'fixture',
          version: '0.0.0',
          dependencies: { '@lostgradient/nonexistent': 'workspace:*' },
        },
        null,
        2,
      ),
    );

    await expect(rewriteWorkspaceDependencies(fixtureDirectory, new Map())).rejects.toThrow(
      /@lostgradient\/nonexistent/,
    );
  });
});
