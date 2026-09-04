/**
 * Runtime-matrix gate (AB-283).
 *
 * AB-92's decision record requires that a package's declared runtime support surface be proved,
 * not asserted: the runtimes CI actually exercises must match the runtimes the workspace's
 * `package.json` manifests claim to support. Before this gate existed, the root manifest declared
 * `engines.node: ">=18"` while `.github/workflows/ci.yml` installed only Node 22 — nothing ever
 * proved Node 18, 19, 20, or 21 worked. AB-283 closed that gap by raising every declared Node
 * floor to `>=22` (the version CI actually installs) rather than adding a Node 18 lane; this
 * script is the gate that keeps that claim honest going forward — a manifest that declares a
 * runtime no CI job exercises fails the check.
 *
 * HOW A "DECLARED FLOOR" IS READ. An `engines` range can combine alternatives with `||` (for
 * example `"^20.16.0 || >=22.3.0"`), and each `||`-separated clause makes its own floor claim —
 * the package claims both "the 20.16.x line works" and "22.3.0-and-up works", and each of those
 * needs its own exercised runtime, not just the lowest one overall. `parseEngineFloors` extracts
 * one floor version per clause via the first numeric run in the clause; `findRuntimeMatrixErrors`
 * checks every floor independently.
 *
 * HOW AN "EXERCISED VERSION" IS READ. `parseExercisedVersions` regex-scans
 * `.github/workflows/ci.yml` for every `node-version:`/`bun-version:` key, in both the plain
 * scalar form (`node-version: 22`) and the bracketed matrix-strategy form
 * (`node-version: [22, current]`), and collects the tokens (quotes stripped). A regex is enough
 * here — unlike `scripts/check-skip-manifest.ts`'s AST-based scan of test *code* (where a matching
 * substring inside an unrelated string or comment is a real false-positive risk), a
 * `node-version:`/`bun-version:` key only ever appears as an actual `actions/setup-node`/
 * `oven-sh/setup-bun` `with:` input in this repository's own workflow files, not inside string
 * literals or comments the gate would otherwise need to filter out.
 *
 * HOW A FLOOR IS MATCHED AGAINST AN EXERCISED VERSION. `floorIsExercised` compares dotted-numeric
 * components (major, then minor, then patch) up to however many components the SHORTER of the two
 * sides specifies. A coarse CI pin like `node-version: 22` (major only) is treated as satisfying
 * any floor whose major is 22, regardless of the floor's own minor/patch precision — the workflow
 * only pins a major, so it says nothing more granular either way, and treating that as a mismatch
 * would make the gate reject the entire fleet's real precise floors (`operative`'s
 * `>=20.19.0`, `conversationalist`'s `^20.19.0 || ^22.12.0 || >=24`) for a precision gap the CI
 * config itself introduced, not a real unproven claim. A non-numeric exercised token (`current`)
 * cannot be parsed into components and is skipped — it does not itself satisfy any numeric floor,
 * but it also cannot cause a false failure.
 *
 * Usage: `bun run scripts/check-runtime-matrix.ts` (wired to `bun run check-runtime-matrix`, and
 * from there into `bun run validate`).
 * Exit code 0 = every declared engines floor is exercised in `.github/workflows/ci.yml`;
 * 1 = at least one manifest declares a runtime nothing exercises.
 */
import { resolve } from 'node:path';

export type EngineRuntime = 'node' | 'bun';

export type WorkspaceManifest = {
  /** Path (relative to the repository root) or other human-readable label for error messages. */
  packageLabel: string;
  engines?: Record<string, string>;
};

export type ExercisedVersions = {
  node: ReadonlySet<string>;
  bun: ReadonlySet<string>;
};

/**
 * Extracts one floor version per `||`-separated clause of an `engines` range string. Each clause
 * is its own claim (`"^20.16.0 || >=22.3.0"` claims both the 20.16.x line and 22.3.0-and-up), so
 * this returns every clause's floor rather than collapsing to a single minimum.
 */
export function parseEngineFloors(range: string): string[] {
  return range
    .split('||')
    .map((clause) => clause.match(/\d+(?:\.\d+){0,2}/)?.[0])
    .filter((floor): floor is string => Boolean(floor));
}

function versionComponents(version: string): number[] | null {
  const components = version.split('.').map((part) => Number.parseInt(part, 10));
  return components.some((component) => Number.isNaN(component)) ? null : components;
}

/**
 * True when some exercised version matches `floor` on every component the SHORTER side
 * specifies — see the module doc for why a coarse CI pin (major only) is treated as satisfying a
 * more precise floor rather than as a mismatch.
 */
export function floorIsExercised(floor: string, exercisedVersions: ReadonlySet<string>): boolean {
  const floorComponents = versionComponents(floor);
  if (!floorComponents) return false;

  for (const exercised of exercisedVersions) {
    const exercisedComponents = versionComponents(exercised);
    if (!exercisedComponents) continue;

    const compareLength = Math.min(floorComponents.length, exercisedComponents.length);
    let matches = true;
    for (let index = 0; index < compareLength; index += 1) {
      if (floorComponents[index] !== exercisedComponents[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }

  return false;
}

/**
 * Pure comparison, no filesystem access: returns one error message per declared floor that no
 * exercised version backs, naming the manifest and the unproven floor.
 */
export function findRuntimeMatrixErrors(
  manifests: readonly WorkspaceManifest[],
  exercised: ExercisedVersions,
): string[] {
  const errors: string[] = [];

  for (const manifest of manifests) {
    if (!manifest.engines) continue;

    for (const runtime of ['node', 'bun'] satisfies EngineRuntime[]) {
      const range = manifest.engines[runtime];
      if (!range) continue;

      const exercisedSet = runtime === 'node' ? exercised.node : exercised.bun;
      for (const floor of parseEngineFloors(range)) {
        if (!floorIsExercised(floor, exercisedSet)) {
          errors.push(
            `${manifest.packageLabel} declares engines.${runtime} "${range}" (floor ${floor}), ` +
              'which no job in .github/workflows/ci.yml exercises',
          );
        }
      }
    }
  }

  return errors;
}

function collectVersionTokens(raw: string, target: Set<string>): void {
  const tokens = raw.startsWith('[') ? raw.slice(1, -1).split(',') : [raw];
  for (const token of tokens) {
    const cleaned = token.trim().replace(/^['"]|['"]$/g, '');
    if (cleaned.length > 0) target.add(cleaned);
  }
}

/**
 * Regex-scans a workflow file's text for every `node-version:`/`bun-version:` key (scalar or
 * bracketed matrix-strategy list) and returns the distinct version tokens for each. See the
 * module doc for why a regex, rather than a full YAML parse, is sufficient here.
 */
export function parseExercisedVersions(workflowText: string): ExercisedVersions {
  const node = new Set<string>();
  const bun = new Set<string>();

  for (const match of workflowText.matchAll(/node-version:\s*(\[[^\]]*\]|\S+)/g)) {
    collectVersionTokens(match[1] ?? '', node);
  }
  for (const match of workflowText.matchAll(/bun-version:\s*(\[[^\]]*\]|\S+)/g)) {
    collectVersionTokens(match[1] ?? '', bun);
  }

  return { node, bun };
}

type PackageManifestFile = { engines?: Record<string, string> };

/** Reads the root manifest and every `packages/<name>/package.json` manifest from disk. */
export async function readWorkspaceManifests(repositoryRoot: string): Promise<WorkspaceManifest[]> {
  const manifests: WorkspaceManifest[] = [];

  const rootManifest = (await Bun.file(
    resolve(repositoryRoot, 'package.json'),
  ).json()) as PackageManifestFile;
  manifests.push({ packageLabel: 'package.json', engines: rootManifest.engines });

  const packageManifestGlob = new Bun.Glob('packages/*/package.json');
  const packagePaths: string[] = [];
  for await (const packageManifestPath of packageManifestGlob.scan({
    cwd: repositoryRoot,
    onlyFiles: true,
  })) {
    packagePaths.push(packageManifestPath);
  }
  packagePaths.sort();

  for (const packageManifestPath of packagePaths) {
    const manifest = (await Bun.file(
      resolve(repositoryRoot, packageManifestPath),
    ).json()) as PackageManifestFile;
    manifests.push({ packageLabel: packageManifestPath, engines: manifest.engines });
  }

  return manifests;
}

/**
 * End-to-end check for a repository root: reads every workspace manifest and
 * `.github/workflows/ci.yml`, then throws naming every declared engines floor that CI does not
 * exercise. Exported so tests can run it against a fixture workspace on disk.
 */
export async function checkRuntimeMatrix(repositoryRoot: string): Promise<WorkspaceManifest[]> {
  const [manifests, workflowText] = await Promise.all([
    readWorkspaceManifests(repositoryRoot),
    Bun.file(resolve(repositoryRoot, '.github/workflows/ci.yml')).text(),
  ]);

  const exercised = parseExercisedVersions(workflowText);
  const errors = findRuntimeMatrixErrors(manifests, exercised);

  if (errors.length > 0) {
    throw new Error(
      `Declared runtime floors must be exercised in .github/workflows/ci.yml:\n${errors
        .map((error) => `- ${error}`)
        .join('\n')}`,
    );
  }

  return manifests.filter((manifest) => manifest.engines !== undefined);
}

if (import.meta.main) {
  try {
    const checkedManifests = await checkRuntimeMatrix(resolve(import.meta.dir, '..'));
    console.log(
      `✓ ${checkedManifests.length} manifest(s) declare engines floors that CI exercises.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ ${message}`);
    process.exit(1);
  }
}
