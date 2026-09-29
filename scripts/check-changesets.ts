import { readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import parseChangesetFile from '@changesets/parse';

export type ChangesetRelease = {
  name: string;
  type: string;
};

export type PendingChangeset = {
  id: string;
  releases: readonly ChangesetRelease[];
};

type WorkspacePackage = {
  private: boolean;
};

type ChangesetPolicy = {
  ignoredPackageNames: ReadonlySet<string>;
  workspacePackages: ReadonlyMap<string, WorkspacePackage>;
};

type ChangesetConfiguration = {
  ignore?: string[];
};

type PackageManifest = {
  name: string;
  private?: boolean;
};

type VersionedManifest = {
  name: string;
  version: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function findWorkspaceLockVersionErrors(
  manifests: ReadonlyMap<string, VersionedManifest>,
  lockfile: unknown,
): string[] {
  if (!isRecord(lockfile) || !isRecord(lockfile['workspaces'])) {
    return ['bun.lock has no workspace records'];
  }

  const workspaces = lockfile['workspaces'];
  const errors: string[] = [];
  for (const [path, manifest] of manifests) {
    const locked = workspaces[path];
    if (!isRecord(locked)) {
      errors.push(`bun.lock is missing ${path}`);
      continue;
    }
    if (locked['name'] !== manifest.name) {
      errors.push(
        `bun.lock ${path} name ${String(locked['name'])} does not match package.json ${manifest.name}`,
      );
    }
    if (locked['version'] !== manifest.version) {
      errors.push(
        `bun.lock ${path} version ${String(locked['version'])} does not match package.json ${manifest.version}`,
      );
    }
  }
  for (const path of Object.keys(workspaces)) {
    if (path !== '' && !manifests.has(path)) errors.push(`bun.lock has orphaned workspace ${path}`);
  }
  return errors;
}

export function synchronizeWorkspaceLockVersions(
  lockfileText: string,
  manifests: ReadonlyMap<string, VersionedManifest>,
): string {
  const lines = lockfileText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const updatedPaths = new Set<string>();
  let inWorkspaces = false;
  let workspacePath = '';

  const updated = lines.map((line) => {
    if (line === '  "workspaces": {\n') {
      inWorkspaces = true;
      return line;
    }
    if (inWorkspaces && /^  },?\r?\n$/.test(line)) {
      inWorkspaces = false;
      workspacePath = '';
      return line;
    }
    if (!inWorkspaces) return line;

    const heading = /^    "([^"]+)": \{\r?\n$/.exec(line);
    if (heading) {
      workspacePath = heading[1] ?? '';
      return line;
    }
    const manifest = manifests.get(workspacePath);
    const versionLine = /^(      "version": )"[^"]*"(,?\r?\n)$/.exec(line);
    if (!manifest || !versionLine) return line;
    updatedPaths.add(workspacePath);
    return `${versionLine[1]}${JSON.stringify(manifest.version)}${versionLine[2]}`;
  });

  for (const path of manifests.keys()) {
    if (!updatedPaths.has(path)) {
      throw new Error(`bun.lock ${path} has no version line to update`);
    }
  }

  const result = updated.join('');
  const errors = findWorkspaceLockVersionErrors(manifests, Bun.JSONC.parse(result));
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return result;
}

export function findChangesetTargetErrors(
  changesets: readonly PendingChangeset[],
  policy: ChangesetPolicy,
): string[] {
  const errors: string[] = [];

  for (const ignoredPackageName of [...policy.ignoredPackageNames].sort()) {
    if (!policy.workspacePackages.has(ignoredPackageName)) {
      errors.push(
        `.changeset/config.json ignores unknown workspace package "${ignoredPackageName}"`,
      );
    }
  }

  for (const changeset of changesets) {
    if (changeset.releases.length === 0) {
      errors.push(`${changeset.id} does not target a publishable package`);
      continue;
    }

    for (const release of changeset.releases) {
      const workspacePackage = policy.workspacePackages.get(release.name);

      if (!workspacePackage) {
        errors.push(`${changeset.id} targets unknown workspace package "${release.name}"`);
        continue;
      }

      const reasons: string[] = [];
      if (policy.ignoredPackageNames.has(release.name)) reasons.push('ignored');
      if (workspacePackage.private) reasons.push('private');
      if (release.type === 'none') reasons.push('configured with no version bump');

      if (reasons.length > 0) {
        errors.push(`${changeset.id} targets "${release.name}", which is ${reasons.join(' and ')}`);
      }
    }
  }

  return errors;
}

export async function readPendingChangesets(repositoryRoot: string): Promise<PendingChangeset[]> {
  const changesetDirectory = resolve(repositoryRoot, '.changeset');
  const entries = await readdir(changesetDirectory, { withFileTypes: true });
  const changesetPaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => resolve(changesetDirectory, entry.name))
    .sort();

  return Promise.all(
    changesetPaths.map(async (changesetPath) => {
      const id = basename(changesetPath, '.md');
      try {
        const changeset = parseChangesetFile(await Bun.file(changesetPath).text());
        return { id, releases: changeset.releases };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid changeset ${id}: ${message}`, { cause: error });
      }
    }),
  );
}

async function readChangesetPolicy(repositoryRoot: string): Promise<ChangesetPolicy> {
  const configuration = (await Bun.file(
    resolve(repositoryRoot, '.changeset/config.json'),
  ).json()) as ChangesetConfiguration;
  const workspacePackages = new Map<string, WorkspacePackage>();
  const packageManifestGlob = new Bun.Glob('packages/*/package.json');

  for await (const packageManifestPath of packageManifestGlob.scan({
    cwd: repositoryRoot,
    onlyFiles: true,
  })) {
    const manifest = (await Bun.file(
      resolve(repositoryRoot, packageManifestPath),
    ).json()) as PackageManifest;
    workspacePackages.set(manifest.name, { private: manifest.private === true });
  }

  return {
    ignoredPackageNames: new Set(configuration.ignore ?? []),
    workspacePackages,
  };
}

async function readWorkspaceManifests(
  repositoryRoot: string,
): Promise<Map<string, VersionedManifest>> {
  const manifests = new Map<string, VersionedManifest>();
  const packageManifestGlob = new Bun.Glob('packages/*/package.json');
  for await (const path of packageManifestGlob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
    const manifest: unknown = await Bun.file(resolve(repositoryRoot, path)).json();
    if (
      !isRecord(manifest) ||
      typeof manifest['name'] !== 'string' ||
      typeof manifest['version'] !== 'string'
    ) {
      throw new Error(`${path} needs a package name and version`);
    }
    manifests.set(path.replace(/\/package\.json$/, ''), {
      name: manifest['name'],
      version: manifest['version'],
    });
  }
  return manifests;
}

async function checkChangesets(repositoryRoot: string): Promise<number> {
  const [changesets, policy, manifests, lockfileText] = await Promise.all([
    readPendingChangesets(repositoryRoot),
    readChangesetPolicy(repositoryRoot),
    readWorkspaceManifests(repositoryRoot),
    Bun.file(resolve(repositoryRoot, 'bun.lock')).text(),
  ]);
  const errors = [
    ...findChangesetTargetErrors(changesets, policy),
    ...findWorkspaceLockVersionErrors(manifests, Bun.JSONC.parse(lockfileText)),
  ];

  if (errors.length > 0) {
    throw new Error(
      `Release metadata must match versioned, publishable workspace packages:\n${errors
        .map((error) => `- ${error}`)
        .join('\n')}`,
    );
  }

  return changesets.length;
}

if (import.meta.main) {
  try {
    const repositoryRoot = resolve(import.meta.dir, '..');
    if (process.argv.includes('--synchronize-lockfile')) {
      const lockfilePath = resolve(repositoryRoot, 'bun.lock');
      const original = await Bun.file(lockfilePath).text();
      const manifests = await readWorkspaceManifests(repositoryRoot);
      const updated = synchronizeWorkspaceLockVersions(original, manifests);
      if (updated !== original) await Bun.write(lockfilePath, updated);
      console.log('✓ bun.lock workspace versions match package manifests.');
    } else {
      const changesetCount = await checkChangesets(repositoryRoot);
      console.log(`✓ ${changesetCount} pending changeset(s) target publishable packages.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ ${message}`);
    process.exit(1);
  }
}
