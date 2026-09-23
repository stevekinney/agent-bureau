/**
 * Thrown whenever a requested path would resolve outside a {@link RootJail}'s
 * root — via `..` traversal, an absolute path outside the root, or a
 * symlink (at any path segment, including the leaf) that dereferences
 * outside the root.
 */
export class PathTraversalError extends Error {
  constructor(
    message: string,
    public readonly context: {
      requestedPath: string;
      root: string;
    },
  ) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

export function isPathTraversalError(error: unknown): error is PathTraversalError {
  return error instanceof PathTraversalError;
}

export interface RootJail {
  /** Real, canonical absolute path to the jail root (symlinks resolved). */
  readonly root: string;
  /**
   * Resolves a repository-relative path to a real, canonical absolute path
   * guaranteed to live within {@link root}.
   *
   * @throws {PathTraversalError} if the path is absolute, escapes the root
   * via `..`, or dereferences (through a symlink anywhere in the path,
   * including the leaf) outside the root.
   */
  resolve(relativePath: string): Promise<string>;
}

/**
 * Creates a jail that constrains all path resolution to a single root
 * directory. The root is canonicalized (symlinks resolved) once here; every
 * subsequent {@link RootJail.resolve} call re-canonicalizes the requested
 * path — including any symlinks along the way, at any segment — before
 * checking it still falls under the canonical root.
 *
 * @throws {PathTraversalError} if `root` is empty or does not exist
 */
export function createRootJail(root: string): RootJail;
export function createRootJail(root: unknown): RootJail {
  const { realpathSync } = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  if (typeof root !== 'string' || root.trim() === '') {
    throw new PathTraversalError('Root jail requires a non-empty root path', {
      requestedPath: String(root),
      root: String(root),
    });
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(path.resolve(root));
  } catch {
    throw new PathTraversalError(`Root path does not exist: ${root}`, {
      requestedPath: root,
      root,
    });
  }

  return {
    root: canonicalRoot,
    resolve: (relativePath: string) => resolveWithinRoot(relativePath, canonicalRoot),
  };
}

function assertWithinRoot(candidate: string, root: string, requestedPath: string): void {
  const { sep } = process.getBuiltinModule('node:path');
  if (candidate === root || candidate.startsWith(root + sep)) return;
  throw new PathTraversalError(`Path "${requestedPath}" escapes root "${root}"`, {
    requestedPath,
    root,
  });
}

async function resolveWithinRoot(relativePath: unknown, root: string): Promise<string> {
  const path = process.getBuiltinModule('node:path');
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new PathTraversalError('Path must be a non-empty string', {
      requestedPath: String(relativePath),
      root,
    });
  }
  if (relativePath.includes('\0')) {
    throw new PathTraversalError(`Path "${relativePath}" contains a null byte`, {
      requestedPath: relativePath,
      root,
    });
  }
  if (path.isAbsolute(relativePath)) {
    throw new PathTraversalError(`Path "${relativePath}" must be relative to the root`, {
      requestedPath: relativePath,
      root,
    });
  }

  const candidate = path.normalize(path.join(root, relativePath));
  assertWithinRoot(candidate, root, relativePath);

  const real = await realpathWithinRoot(candidate, root);
  assertWithinRoot(real, root, relativePath);
  return real;
}

/**
 * Resolves symlinks along `candidate`, walking up to the nearest existing
 * ancestor when the leaf (or an intermediate segment) does not yet exist,
 * then re-appending the missing suffix onto the ancestor's canonical path.
 * This guarantees a symlink anywhere in the path — including a symlinked
 * intermediate directory whose target lies outside the root — is fully
 * dereferenced before the caller checks containment.
 */
async function realpathWithinRoot(candidate: string, root: string): Promise<string> {
  const { realpath } = process.getBuiltinModule('node:fs/promises');
  const path = process.getBuiltinModule('node:path');
  let current = candidate;
  const suffix: string[] = [];

  for (;;) {
    try {
      const real = await realpath(current);
      return suffix.length > 0 ? path.join(real, ...suffix) : real;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (current === root || parent === current) {
        // Hit the jail root (or filesystem root) without finding an
        // existing ancestor to dereference; nothing left to resolve.
        return suffix.length > 0 ? path.join(current, ...suffix) : current;
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = error.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
