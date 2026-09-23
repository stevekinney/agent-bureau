import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import {
  createSkillArtifact,
  exceedsAdmissionLimits,
  resolveAdmissionLimits,
  type CreateSkillArtifactOptions,
  type ResolvedSkillAdmissionLimits,
  type SkillAdmissionDiagnostic,
  type SkillArtifactAdmission,
  type SkillArtifactInputFile,
} from '../artifact';

/** Bounds on the directory walk itself, distinct from bounds on the content it finds. */
export interface ReadSkillArtifactOptions extends CreateSkillArtifactOptions {
  /** Deepest directory level below the skill root. Default 8. */
  readonly maximumDepth?: number;
  /** Most directories visited in one read. Default 512. */
  readonly maximumDirectoryCount?: number;
}

const DEFAULT_MAXIMUM_DEPTH = 8;
const DEFAULT_MAXIMUM_DIRECTORY_COUNT = 512;

interface WalkState {
  readonly canonicalRoot: string;
  readonly maximumDepth: number;
  readonly maximumDirectoryCount: number;
  readonly limits: ResolvedSkillAdmissionLimits;
  directoriesVisited: number;
  totalBytes: number;
  readonly files: SkillArtifactInputFile[];
  readonly diagnostics: SkillAdmissionDiagnostic[];
}

/**
 * True when `candidate` is the root itself or lives beneath it.
 *
 * Compared against the *canonical* root — both sides resolved through `realpath` — because a
 * prefix test against the path as written is defeated by a symlinked ancestor, and appending the
 * separator is what stops `/skills/pdf-evil` from passing a containment check for `/skills/pdf`.
 */
function isContained(canonicalRoot: string, candidate: string): boolean {
  return candidate === canonicalRoot || candidate.startsWith(canonicalRoot + sep);
}

/**
 * Resolves a symbolic link and refuses it when it points outside the skill root.
 *
 * A link that stays inside the bundle is legitimate — a reference file pointing at a shared
 * template, say — so this contains rather than bans.
 */
async function resolveContainedLink(
  state: WalkState,
  fullPath: string,
  relativePath: string,
): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(fullPath);
  } catch {
    state.diagnostics.push({
      code: 'symlink-escape',
      message: `Symbolic link '${relativePath}' does not resolve.`,
      path: relativePath,
    });
    return undefined;
  }

  if (!isContained(state.canonicalRoot, canonical)) {
    state.diagnostics.push({
      code: 'symlink-escape',
      message: `Symbolic link '${relativePath}' resolves outside the skill root.`,
      path: relativePath,
    });
    return undefined;
  }

  return canonical;
}

/**
 * Admits one regular file, refusing it from its size before any of it is read.
 *
 * The size comes from the `lstat` the walk already performed, so an oversized file costs a stat
 * rather than its own length in memory. Checking only after the walk meant a 200 MiB file was
 * fully loaded and then reported as too large, which is the opposite of what a limit is for.
 */
async function readRegularFile(
  state: WalkState,
  fullPath: string,
  relativePath: string,
  size: number,
): Promise<void> {
  const breach = exceedsAdmissionLimits(
    state.limits,
    { fileCount: state.files.length, totalBytes: state.totalBytes },
    size,
  );
  if (breach) {
    state.diagnostics.push({ ...breach, path: relativePath });
    return;
  }

  try {
    const bytes = await readFile(fullPath);
    state.files.push({ path: relativePath, bytes: new Uint8Array(bytes) });
    state.totalBytes += bytes.byteLength;
  } catch {
    state.diagnostics.push({
      code: 'unreadable-file',
      message: `File '${relativePath}' could not be read.`,
      path: relativePath,
    });
  }
}

/**
 * Classifies one directory entry and either admits it, recurses into it, or records why not.
 *
 * `lstat` rather than `stat` so a symbolic link is seen as a link instead of as whatever it points
 * at — the distinction the containment check depends on.
 */
async function visitEntry(
  state: WalkState,
  directoryPath: string,
  relativeDirectory: string,
  name: string,
  depth: number,
): Promise<void> {
  const fullPath = join(directoryPath, name);
  const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;

  let info;
  try {
    info = await lstat(fullPath);
  } catch {
    state.diagnostics.push({
      code: 'unreadable-file',
      message: `Entry '${relativePath}' could not be inspected.`,
      path: relativePath,
    });
    return;
  }

  if (info.isSymbolicLink()) {
    const canonical = await resolveContainedLink(state, fullPath, relativePath);
    if (canonical === undefined) return;

    // Guarded: `realpath` and this `lstat` are two syscalls, and a target deleted or made
    // unreadable between them must produce a diagnostic like every other failure here, not a
    // rejected promise out of an API whose whole contract is to return diagnostics.
    let target;
    try {
      target = await lstat(canonical);
    } catch {
      state.diagnostics.push({
        code: 'unreadable-file',
        message: `Symbolic link '${relativePath}' resolved but its target could not be inspected.`,
        path: relativePath,
      });
      return;
    }

    if (target.isDirectory()) {
      await walkDirectory(state, canonical, relativePath, depth + 1);
      return;
    }
    if (target.isFile()) {
      await readRegularFile(state, canonical, relativePath, target.size);
      return;
    }
    state.diagnostics.push({
      code: 'special-file',
      message: `Entry '${relativePath}' links to something that is neither a regular file nor a directory.`,
      path: relativePath,
    });
    return;
  }

  if (info.isDirectory()) {
    await walkDirectory(state, fullPath, relativePath, depth + 1);
    return;
  }

  if (info.isFile()) {
    await readRegularFile(state, fullPath, relativePath, info.size);
    return;
  }

  // Sockets, FIFOs, block and character devices. Reading one can block forever or return content
  // that was never part of the bundle, so it is refused rather than skipped silently.
  state.diagnostics.push({
    code: 'special-file',
    message: `Entry '${relativePath}' is not a regular file or directory.`,
    path: relativePath,
  });
}

async function walkDirectory(
  state: WalkState,
  directoryPath: string,
  relativeDirectory: string,
  depth: number,
): Promise<void> {
  if (depth > state.maximumDepth) {
    state.diagnostics.push({
      code: 'scan-limit-exceeded',
      message: `Directory '${relativeDirectory}' is deeper than the limit of ${state.maximumDepth}.`,
      path: relativeDirectory,
    });
    return;
  }

  state.directoriesVisited += 1;
  if (state.directoriesVisited > state.maximumDirectoryCount) {
    state.diagnostics.push({
      code: 'scan-limit-exceeded',
      message: `Scan visited more than ${state.maximumDirectoryCount} directories.`,
    });
    return;
  }

  let names: string[];
  try {
    names = await readdir(directoryPath);
  } catch {
    state.diagnostics.push({
      code: 'unreadable-file',
      message: `Directory '${relativeDirectory}' could not be listed.`,
      path: relativeDirectory,
    });
    return;
  }

  // Sorted so the walk itself is deterministic, independent of the order the filesystem happens to
  // report entries in. The artifact's own ordering does not depend on this, but its diagnostics do.
  names.sort();

  for (const name of names) {
    await visitEntry(state, directoryPath, relativeDirectory, name, depth);
  }
}

/**
 * Reads a skill directory into a complete bounded artifact.
 *
 * Unlike the flat top-level resource collection this package used before, the whole tree is
 * walked, so `scripts/`, `references/`, `assets/` and any other skill-local directory are carried
 * with their relative paths intact. Content is read as bytes, never as UTF-8 text, so a bundled
 * binary asset survives the round trip.
 *
 * Nothing found here is executed. Scripts are read exactly like any other resource — they are
 * inert content until some caller outside this package decides otherwise.
 *
 * Two containment limits are worth stating plainly rather than leaving implied. A **hard link**
 * inside the root to a file outside it is admitted: a link carries no record of where it was made
 * from, so it is indistinguishable from an ordinary file. Creating one already requires read
 * access to the target, so this escalates only when ingestion runs with more privilege than
 * whoever wrote the bundle, and it cannot occur at all for a bundle delivered as an archive.
 * Second, resolving a path and then reading it is inherently **time-of-check to time-of-use**: a
 * writer who can mutate the tree during the walk can swap a component for a symbolic link between
 * the two syscalls. Closing that needs descriptor-based traversal; the assumption here is that the
 * skill tree is not under concurrent hostile modification.
 */
export async function readSkillArtifact(
  directoryPath: string,
  options?: ReadSkillArtifactOptions,
): Promise<SkillArtifactAdmission> {
  const absoluteRoot = resolve(directoryPath);

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(absoluteRoot);
  } catch {
    return {
      admitted: false,
      diagnostics: [
        {
          code: 'unreadable-file',
          message: `Skill directory '${directoryPath}' does not exist or cannot be resolved.`,
          path: directoryPath,
        },
      ],
    };
  }

  const state: WalkState = {
    canonicalRoot,
    maximumDepth: options?.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH,
    maximumDirectoryCount: options?.maximumDirectoryCount ?? DEFAULT_MAXIMUM_DIRECTORY_COUNT,
    limits: resolveAdmissionLimits(options?.limits),
    directoriesVisited: 0,
    totalBytes: 0,
    files: [],
    diagnostics: [],
  };

  await walkDirectory(state, canonicalRoot, '', 0);

  if (state.diagnostics.length > 0) {
    return { admitted: false, diagnostics: state.diagnostics };
  }

  // The directory's name as the caller wrote it, not as the filesystem stores it. Upstream uses
  // `Path(skill_dir).name` — the argument, uninterpreted — so taking the canonical spelling would
  // change the name-matches-directory verdict on a case-insensitive filesystem such as macOS.
  //
  // Not the frontmatter's `name` either: strict validation is what reports a disagreement between
  // the two, and deriving the artifact name from frontmatter would make that check unable to fail.
  return createSkillArtifact(basename(absoluteRoot), state.files, options);
}
