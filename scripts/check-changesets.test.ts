import { describe, expect, test } from 'bun:test';

import {
  findChangesetTargetErrors,
  findWorkspaceLockVersionErrors,
  synchronizeWorkspaceLockVersions,
} from './check-changesets';

const workspacePackages = new Map([
  ['armorer', { private: false }],
  ['conversationalist', { private: false }],
  ['@lostgradient/operative', { private: false }],
  ['gateway', { private: true }],
]);

const policy = {
  ignoredPackageNames: new Set(['gateway']),
  workspacePackages,
};

describe('findChangesetTargetErrors', () => {
  test('rejects a changeset targeting an ignored, private package', () => {
    const errors = findChangesetTargetErrors(
      [
        {
          id: 'phase-f-durable-multi-agent',
          releases: [{ name: 'gateway', type: 'minor' }],
        },
      ],
      policy,
    );

    expect(errors).toEqual([
      'phase-f-durable-multi-agent targets "gateway", which is ignored and private',
    ]);
  });

  test('rejects an invalid target even when a publishable target is also present', () => {
    const errors = findChangesetTargetErrors(
      [
        {
          id: 'mixed-release',
          releases: [
            { name: 'armorer', type: 'patch' },
            { name: 'gateway', type: 'minor' },
          ],
        },
      ],
      policy,
    );

    expect(errors).toEqual(['mixed-release targets "gateway", which is ignored and private']);
  });

  test('accepts changesets for publishable packages', () => {
    const errors = findChangesetTargetErrors(
      [
        {
          id: 'publish-armorer',
          releases: [{ name: 'armorer', type: 'patch' }],
        },
      ],
      policy,
    );

    expect(errors).toEqual([]);
  });

  test('accepts changesets targeting the newly wired operative package', () => {
    const errors = findChangesetTargetErrors(
      [
        {
          id: 'publish-operative',
          releases: [{ name: '@lostgradient/operative', type: 'minor' }],
        },
      ],
      policy,
    );

    expect(errors).toEqual([]);
  });

  test('accepts a repository with no pending changesets', () => {
    expect(findChangesetTargetErrors([], policy)).toEqual([]);
  });

  test('rejects empty changesets because they cannot produce a version commit', () => {
    const errors = findChangesetTargetErrors([{ id: 'empty-release', releases: [] }], policy);

    expect(errors).toEqual(['empty-release does not target a publishable package']);
  });

  test('rejects stale ignored package names that are no longer in the workspace', () => {
    const errors = findChangesetTargetErrors([], {
      ignoredPackageNames: new Set(['herald']),
      workspacePackages,
    });

    expect(errors).toEqual(['.changeset/config.json ignores unknown workspace package "herald"']);
  });

  test('rejects changesets that target unknown workspace packages', () => {
    const errors = findChangesetTargetErrors(
      [
        {
          id: 'unknown-package',
          releases: [{ name: 'missing-package', type: 'patch' }],
        },
      ],
      policy,
    );

    expect(errors).toEqual(['unknown-package targets unknown workspace package "missing-package"']);
  });

  test('rejects changesets configured with no version bump', () => {
    const errors = findChangesetTargetErrors(
      [
        {
          id: 'no-version-bump',
          releases: [{ name: 'armorer', type: 'none' }],
        },
      ],
      policy,
    );

    expect(errors).toEqual([
      'no-version-bump targets "armorer", which is configured with no version bump',
    ]);
  });
});

describe('findWorkspaceLockVersionErrors', () => {
  const manifests = new Map([
    ['packages/conversationalist', { name: 'conversationalist', version: '2.1.0' }],
    ['packages/operative', { name: '@lostgradient/operative', version: '0.13.0' }],
  ]);

  test('accepts lockfile workspace labels matching both manifests', () => {
    expect(
      findWorkspaceLockVersionErrors(manifests, {
        workspaces: {
          '': { name: 'agent-bureau' },
          'packages/conversationalist': { name: 'conversationalist', version: '2.1.0' },
          'packages/operative': { name: '@lostgradient/operative', version: '0.13.0' },
        },
      }),
    ).toEqual([]);
  });

  test('rejects the stale version labels that Changesets left in bun.lock', () => {
    expect(
      findWorkspaceLockVersionErrors(manifests, {
        workspaces: {
          'packages/conversationalist': { name: 'conversationalist', version: '2.0.0' },
          'packages/operative': { name: '@lostgradient/operative', version: '0.12.3' },
        },
      }),
    ).toEqual([
      'bun.lock packages/conversationalist version 2.0.0 does not match package.json 2.1.0',
      'bun.lock packages/operative version 0.12.3 does not match package.json 0.13.0',
    ]);
  });

  test('rejects missing and orphaned workspace records', () => {
    expect(
      findWorkspaceLockVersionErrors(manifests, {
        workspaces: {
          'packages/conversationalist': { name: 'conversationalist', version: '2.1.0' },
          'packages/retired': { name: 'retired', version: '1.0.0' },
        },
      }),
    ).toEqual([
      'bun.lock is missing packages/operative',
      'bun.lock has orphaned workspace packages/retired',
    ]);
  });
});

describe('synchronizeWorkspaceLockVersions', () => {
  const manifests = new Map([
    ['packages/conversationalist', { name: 'conversationalist', version: '2.1.1' }],
    ['packages/operative', { name: '@lostgradient/operative', version: '0.13.1' }],
  ]);
  const lockfile = `{
  "workspaces": {
    "": {
      "name": "agent-bureau",
    },
    "packages/conversationalist": {
      "name": "conversationalist",
      "version": "2.1.0",
      "dependencies": {
        "@lostgradient/operative": "workspace:*",
      },
    },
    "packages/operative": {
      "name": "@lostgradient/operative",
      "version": "0.13.0",
    },
  },
  "packages": {
    "other": ["other@1.0.0"],
  },
}\n`;

  test('updates only stale workspace labels and preserves the rest of the lockfile', () => {
    const updated = synchronizeWorkspaceLockVersions(lockfile, manifests);
    expect(updated).toBe(
      lockfile
        .replace('"version": "2.1.0"', '"version": "2.1.1"')
        .replace('"version": "0.13.0"', '"version": "0.13.1"'),
    );
    expect(findWorkspaceLockVersionErrors(manifests, Bun.JSONC.parse(updated))).toEqual([]);
  });

  test('rejects a missing workspace version line instead of reporting success', () => {
    expect(() =>
      synchronizeWorkspaceLockVersions(
        lockfile.replace('      "version": "0.13.0",\n', ''),
        manifests,
      ),
    ).toThrow('bun.lock packages/operative has no version line to update');
  });
});
