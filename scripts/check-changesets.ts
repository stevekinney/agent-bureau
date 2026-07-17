import { readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import parseChangesetFile from '@changesets/parse';

type ChangesetRelease = {
  name: string;
  type: string;
};

type PendingChangeset = {
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

async function readPendingChangesets(repositoryRoot: string): Promise<PendingChangeset[]> {
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

async function checkChangesets(repositoryRoot: string): Promise<number> {
  const [changesets, policy] = await Promise.all([
    readPendingChangesets(repositoryRoot),
    readChangesetPolicy(repositoryRoot),
  ]);
  const errors = findChangesetTargetErrors(changesets, policy);

  if (errors.length > 0) {
    throw new Error(
      `Changesets must target versioned, publishable workspace packages:\n${errors
        .map((error) => `- ${error}`)
        .join('\n')}`,
    );
  }

  return changesets.length;
}

if (import.meta.main) {
  try {
    const changesetCount = await checkChangesets(resolve(import.meta.dir, '..'));
    console.log(`✓ ${changesetCount} pending changeset(s) target publishable packages.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ ${message}`);
    process.exit(1);
  }
}
