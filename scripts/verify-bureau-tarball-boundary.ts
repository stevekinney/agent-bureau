/**
 * Proves the `bureau` tarball boundary (AB-23 / AB-92): `bureau` is
 * `"private": true` and MUST NEVER be packed for a registry-style consumer
 * install — its manifest depends on `lifecycle`, `memory`, and `skills` at
 * their internal workspace versions, and none of those three names is safe
 * to resolve from the public npm registry: `memory` and `skills` are real,
 * unrelated third-party packages there today, and installing bureau's
 * tarball against the public registry would silently pull in someone else's
 * package under those names (a dependency-confusion outcome), not fail
 * loudly. This script never queries the public registry for any of
 * bureau's private siblings — the proof is entirely local tarballs.
 *
 * The proof, per AB-92's packed-consumer tier ("bureau is private, so its
 * proof is bun pack plus path install, never a registry install"):
 *
 *   1. `bun pm pack` bureau AND every one of its own `workspace:*`
 *      dependencies (armorer, conversationalist, @lostgradient/operative,
 *      interoperability, lifecycle, memory, skills) into real tarballs.
 *   2. Install ALL of them together, by absolute `file:` path, into one
 *      isolated consumer outside the workspace — `@lostgradient/weft` and
 *      `zod` (bureau's only genuinely-published/registry-safe dependencies)
 *      are the only names resolved from the registry.
 *   3. Prove the tarball boundary structurally: `lifecycle`, `memory`, and
 *      `skills` are exactly the packages this monorepo's own
 *      `.changeset/config.json` `ignore` list marks as never-published —
 *      i.e. the packages a path install must supply itself, by construction,
 *      because no released version of them exists.
 *   4. `bunx tsc --noEmit` and `bun test` a small consumer proving the
 *      installed tarball's public surface (`createBureau`) and `./test`
 *      subpath both import and run.
 *
 * Usage: `bun run scripts/verify-bureau-tarball-boundary.ts`
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

const root = join(import.meta.dir, '..');

async function run(command: string[], cwd: string): Promise<string> {
  const [executable, ...arguments_] = command;
  const result = await $`${executable} ${arguments_}`.cwd(cwd).nothrow().quiet();
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed:\n${output}`);
  return output;
}

/**
 * Bureau's own `workspace:*` dependencies (private, unpublished) plus
 * bureau itself — every one of these must be packed and installed by local
 * path, never resolved from the registry. Mirrors `packages/bureau/package.json`'s
 * `dependencies`.
 */
const BUREAU_WORKSPACE_SIBLINGS = [
  'armorer',
  'conversationalist',
  'operative', // directory name; package name is @lostgradient/operative
  'interoperability',
  'lifecycle',
  'memory',
  'skills',
] as const;

const PACKAGE_NAME_BY_DIRECTORY: Record<(typeof BUREAU_WORKSPACE_SIBLINGS)[number], string> = {
  armorer: 'armorer',
  conversationalist: 'conversationalist',
  operative: '@lostgradient/operative',
  interoperability: 'interoperability',
  lifecycle: 'lifecycle',
  memory: 'memory',
  skills: 'skills',
};

async function packWorkspacePackage(directoryName: string, staging: string): Promise<string> {
  const packageDirectory = join(root, 'packages', directoryName);
  const output = await run(['bun', 'pm', 'pack', '--destination', staging], packageDirectory);
  const tarballLine = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz') && !line.startsWith('packed '));
  if (!tarballLine) {
    throw new Error(`bun pm pack for ${directoryName} did not report a tarball path:\n${output}`);
  }
  return tarballLine;
}

async function verifyStructuralBoundary(): Promise<void> {
  const changesetConfiguration = JSON.parse(
    await Bun.file(join(root, '.changeset', 'config.json')).text(),
  ) as { ignore?: string[] };
  const ignored = new Set(changesetConfiguration.ignore ?? []);
  const neverPublished = ['lifecycle', 'memory', 'skills'] as const;
  for (const name of neverPublished) {
    if (!ignored.has(name)) {
      throw new Error(
        `Expected .changeset/config.json's ignore list to mark "${name}" as never-published ` +
          `(bureau's tarball boundary depends on this); it does not.`,
      );
    }
  }

  const bureauManifest = JSON.parse(
    await Bun.file(join(root, 'packages', 'bureau', 'package.json')).text(),
  ) as { private?: boolean; dependencies?: Record<string, string> };
  if (bureauManifest.private !== true) {
    throw new Error('bureau must remain "private": true — its manifest boundary depends on it.');
  }
  for (const name of neverPublished) {
    if (!bureauManifest.dependencies?.[name]) {
      throw new Error(`Expected bureau's package.json to depend on "${name}"; it does not.`);
    }
  }
}

async function main(): Promise<void> {
  await run(['turbo', 'run', 'build', '--filter=bureau'], root);
  await verifyStructuralBoundary();

  const staging = await mkdtemp(join(tmpdir(), 'bureau-tarball-pack-'));
  const directory = await mkdtemp(join(tmpdir(), 'bureau-tarball-consumer-'));
  try {
    const tarballs: Record<string, string> = {};
    for (const directoryName of BUREAU_WORKSPACE_SIBLINGS) {
      const packageName = PACKAGE_NAME_BY_DIRECTORY[directoryName];
      tarballs[packageName] = await packWorkspacePackage(directoryName, staging);
    }
    const bureauTarball = await packWorkspacePackage('bureau', staging);

    await Bun.write(
      join(directory, 'package.json'),
      JSON.stringify(
        {
          name: 'bureau-tarball-consumer-check',
          private: true,
          type: 'module',
          dependencies: {
            bureau: `file:${bureauTarball}`,
            ...Object.fromEntries(
              Object.entries(tarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
            ),
            // Bureau's only two genuinely-published, registry-safe
            // dependencies — the ONLY names this manifest lets resolve
            // from the public registry.
            '@lostgradient/weft': '^0.23.1',
            zod: '^4.4.3',
          },
          devDependencies: { typescript: '6.0.3', '@types/bun': '1.3.14' },
          // bureau's OWN packed manifest declares its private siblings at
          // their internal workspace-resolved semver (e.g. "0.0.1") — a
          // version that does not, and never will, exist on the registry.
          // These overrides force every transitive reference to those names
          // (from bureau's packed manifest, or anyone else's) onto the SAME
          // local tarballs declared above, regardless of what version range
          // was requested — the point being proved: nothing here is ever
          // satisfied by a registry lookup.
          overrides: Object.fromEntries(
            Object.entries(tarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
          ),
        },
        null,
        2,
      ),
    );
    await Bun.write(
      join(directory, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            skipLibCheck: false,
            module: 'Preserve',
            moduleResolution: 'bundler',
            target: 'ESNext',
            types: ['bun'],
            noEmit: true,
          },
          include: ['src/**/*.ts', 'test/**/*.ts'],
        },
        null,
        2,
      ),
    );
    await Bun.write(
      join(directory, 'src', 'index.ts'),
      `import { createBureau } from 'bureau';
import { waitForCondition } from 'bureau/test';

export { createBureau, waitForCondition };
`,
    );
    await Bun.write(
      join(directory, 'test', 'smoke.test.ts'),
      `import { createBureau } from 'bureau';
import { waitForCondition } from 'bureau/test';
import { describe, expect, it } from 'bun:test';

describe('bureau tarball boundary — path-installed consumer', () => {
  it('imports and constructs a bureau with no agents from the packed tarball', async () => {
    const bureau = await createBureau({
      agents: {},
      generate: async () => ({ content: 'ok', toolCalls: [] }),
    });
    try {
      expect(bureau.ready).toBe(true);
      expect(bureau.agents.names()).toEqual([]);
      // Exercises the ./test subpath too — waitForCondition is a plain
      // predicate-poll helper, satisfied immediately here.
      await waitForCondition(() => bureau.ready, 'bureau never became ready');
    } finally {
      bureau.dispose();
    }
  });
});
`,
    );

    await run(['bun', 'install'], directory);
    // The lockfile itself is the strongest evidence: it resolves bureau and
    // every one of its private siblings to local file paths, never to a
    // registry entry — there is no registry entry to resolve them to. Each
    // package's OWN "packages" entry is checked individually (rather than a
    // whole-file substring search) so a sibling that slipped through to the
    // registry is caught even when other siblings are correctly local.
    const lockText = await Bun.file(join(directory, 'bun.lock')).text();
    const packagesStart = lockText.indexOf('"packages": {');
    if (packagesStart === -1) throw new Error('bun.lock has no "packages" block');
    const packageLines = lockText
      .slice(packagesStart)
      .split('\n')
      .filter((line) => /^\s*"[^"]+":\s*\[/.test(line));

    const expectedLocalPackages = new Set([
      'bureau',
      ...Object.keys(PACKAGE_NAME_BY_DIRECTORY).map((key) => PACKAGE_NAME_BY_DIRECTORY[key]),
    ]);
    const seen = new Set<string>();
    for (const line of packageLines) {
      const keyMatch = /^\s*"([^"]+)":/.exec(line);
      const key = keyMatch?.[1];
      if (!key) continue;
      // A NESTED resolution of one of our expected packages (a different
      // version resolved beneath a specific importer, e.g. one Bureau
      // sibling depending on another) gets an importer-PREFIXED lock key
      // like "bureau/memory", not the bare "memory" the top-level
      // resolution uses. Match either form — a nested resolution that
      // slipped through to the registry while the top-level one stayed
      // local must still fail this check.
      const matched = [...expectedLocalPackages].find(
        (name) => key === name || key.endsWith(`/${name}`),
      );
      if (!matched) continue;
      seen.add(matched);
      // `bun.lock` embeds a `file:`-installed dependency's resolved spec as
      // `"<name>@<absolute path>.tgz"` — no literal "file:" scheme prefix.
      // The one thing that conclusively distinguishes it from a registry
      // resolution (always a bare semver, e.g. `"<name>@1.2.3"`) is that the
      // path lives inside OUR staging directory.
      if (!line.includes(staging) || !line.includes('.tgz')) {
        throw new Error(
          `${key} did not resolve through this run's local tarball in bun.lock:\n${line}`,
        );
      }
    }
    for (const name of expectedLocalPackages) {
      if (!seen.has(name)) {
        throw new Error(`bun.lock never resolved ${name} at all`);
      }
    }

    await run(['bunx', 'tsc', '--noEmit'], directory);
    await run(['bun', 'test'], directory);

    console.log(
      'Bureau tarball boundary verification passed: bureau and every workspace-private ' +
        'sibling install by local path only, and the public surface + ./test subpath work.',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
