import { sha256BytesHex, sha256Hex } from '@lostgradient/cryptography';

/**
 * The complete bounded skill artifact: every file a skill bundle carries, not just its `SKILL.md`.
 *
 * A skill is a *directory* in the Agent Skills specification — `scripts/`, `references/` and
 * `assets/` are as much part of it as the instructions. Modelling it as one Markdown string, which
 * is what this package did before, silently drops everything under those directories and cannot
 * represent a bundled image or font at all. Entries here carry raw bytes so text and binary
 * content survive identically, and every entry is digested so a later activation can prove it is
 * looking at the same content an operator admitted.
 */
export interface SkillArtifactEntry {
  /** Normalized POSIX-relative path from the skill root, e.g. `scripts/extract.py`. */
  readonly path: string;
  /** Raw content. Never decoded, so binary assets round-trip byte for byte. */
  readonly bytes: Uint8Array;
  /** Media type resolved from the path's extension. */
  readonly mediaType: string;
  /** SHA-256 hex digest of {@link bytes}. */
  readonly digest: string;
}

/** A complete, bounded, digest-identified skill bundle. */
export interface SkillArtifact {
  /** The skill's name, as declared in `SKILL.md` frontmatter. */
  readonly name: string;
  /** Every admitted file, ordered deterministically by path. */
  readonly entries: readonly SkillArtifactEntry[];
  /**
   * SHA-256 over the ordered `path\0digest` pairs.
   *
   * Derived from paths and content digests rather than from raw bytes so it is stable across
   * directory enumeration order, and so two artifacts are equal exactly when every file at every
   * path is equal.
   */
  readonly digest: string;
  /** Sum of every entry's byte length. */
  readonly totalBytes: number;
}

/**
 * Bounds applied before any content is admitted.
 *
 * Defaults are deliberately modest: a skill is instructions plus supporting material, and an
 * artifact that needs more than this is more likely a mis-rooted scan than a real bundle.
 */
export interface SkillAdmissionLimits {
  /** Largest single file. Default 1 MiB. */
  readonly maximumFileBytes?: number;
  /** Largest artifact in total. Default 8 MiB. */
  readonly maximumTotalBytes?: number;
  /** Most files in one artifact. Default 256. */
  readonly maximumFileCount?: number;
}

/** Resolved limits, with every default applied. */
export interface ResolvedSkillAdmissionLimits {
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
  readonly maximumFileCount: number;
}

export const DEFAULT_SKILL_ADMISSION_LIMITS: ResolvedSkillAdmissionLimits = Object.freeze({
  maximumFileBytes: 1_048_576,
  maximumTotalBytes: 8_388_608,
  maximumFileCount: 256,
});

/** Resolves partial limits against {@link DEFAULT_SKILL_ADMISSION_LIMITS}. */
export function resolveAdmissionLimits(
  limits?: SkillAdmissionLimits,
): ResolvedSkillAdmissionLimits {
  return {
    maximumFileBytes: limits?.maximumFileBytes ?? DEFAULT_SKILL_ADMISSION_LIMITS.maximumFileBytes,
    maximumTotalBytes:
      limits?.maximumTotalBytes ?? DEFAULT_SKILL_ADMISSION_LIMITS.maximumTotalBytes,
    maximumFileCount: limits?.maximumFileCount ?? DEFAULT_SKILL_ADMISSION_LIMITS.maximumFileCount,
  };
}

/** Every reason content can be refused admission into an artifact. */
export type SkillAdmissionCode =
  | 'absolute-path'
  | 'parent-traversal'
  | 'invalid-path'
  | 'duplicate-path'
  | 'symlink-escape'
  | 'special-file'
  | 'file-too-large'
  | 'artifact-too-large'
  | 'too-many-files'
  | 'scan-limit-exceeded'
  | 'missing-skill-file'
  | 'unreadable-file';

/** One admission failure, naming the path that caused it. */
export interface SkillAdmissionDiagnostic {
  readonly code: SkillAdmissionCode;
  readonly message: string;
  /** The offending path as supplied, before normalization. Absent for whole-artifact failures. */
  readonly path?: string;
}

/**
 * The outcome of admitting content. Either an artifact exists or it does not — a partially
 * admitted bundle is never produced, because a caller holding one cannot tell which half of a
 * skill's instructions it is missing.
 */
export type SkillArtifactAdmission =
  | { readonly admitted: true; readonly artifact: SkillArtifact }
  | { readonly admitted: false; readonly diagnostics: readonly SkillAdmissionDiagnostic[] };

/** A file offered for admission. */
export interface SkillArtifactInputFile {
  /** Relative path from the skill root, in any form; normalized during admission. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The canonical instructions file every artifact must carry at its root. */
export const SKILL_MANIFEST_FILENAME = 'SKILL.md';

/**
 * Lowercase alternative the reference parser accepts when locating a skill's instructions.
 * Upstream `find_skill_md` prefers `SKILL.md` and falls back to this.
 */
export const SKILL_MANIFEST_FALLBACK_FILENAME = 'skill.md';

const MEDIA_TYPES_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['css', 'text/css'],
  ['csv', 'text/csv'],
  ['gif', 'image/gif'],
  ['htm', 'text/html'],
  ['html', 'text/html'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['js', 'text/javascript'],
  ['json', 'application/json'],
  ['md', 'text/markdown'],
  ['mjs', 'text/javascript'],
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['py', 'text/x-python'],
  ['sh', 'application/x-sh'],
  ['svg', 'image/svg+xml'],
  ['toml', 'application/toml'],
  ['ts', 'text/typescript'],
  ['txt', 'text/plain'],
  ['webp', 'image/webp'],
  ['woff2', 'font/woff2'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
]);

/** The media type for a normalized artifact path, defaulting to opaque bytes. */
export function resolveMediaType(path: string): string {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = path.lastIndexOf('/');
  if (lastDot <= lastSlash + 1) return 'application/octet-stream';
  const extension = path.slice(lastDot + 1).toLowerCase();
  return MEDIA_TYPES_BY_EXTENSION.get(extension) ?? 'application/octet-stream';
}

/** A successfully normalized path, or the reason it was refused. */
export type NormalizedArtifactPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: SkillAdmissionCode; readonly message: string };

const WINDOWS_DRIVE_PREFIX = /^[a-z]:/iu;

/**
 * Normalizes a bundle-relative path, refusing everything that could reach outside the skill root.
 *
 * Backslashes are rejected outright rather than treated as separators or as literal characters.
 * Treating them as literals is what lets `..\..\secrets` past a POSIX-only `..` check on a host
 * that will later interpret the same string as a Windows path, and treating them as separators
 * would silently rewrite a filename that legitimately contains one on POSIX. Refusing is the only
 * option that cannot be wrong in a way that matters.
 */
export function normalizeArtifactPath(rawPath: string): NormalizedArtifactPath {
  if (rawPath.trim() === '') {
    return { ok: false, code: 'invalid-path', message: 'Artifact path is empty.' };
  }

  if (rawPath.includes('\0')) {
    return {
      ok: false,
      code: 'invalid-path',
      message: 'Artifact path contains a NUL byte.',
    };
  }

  if (rawPath.includes('\\')) {
    return {
      ok: false,
      code: 'invalid-path',
      message: `Artifact path '${rawPath}' contains a backslash, which is ambiguous between a separator and a literal character.`,
    };
  }

  if (rawPath.startsWith('/') || WINDOWS_DRIVE_PREFIX.test(rawPath)) {
    return {
      ok: false,
      code: 'absolute-path',
      message: `Artifact path '${rawPath}' is absolute; skill-local paths must be relative to the skill root.`,
    };
  }

  const segments: string[] = [];
  for (const segment of rawPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      return {
        ok: false,
        code: 'parent-traversal',
        message: `Artifact path '${rawPath}' escapes the skill root with '..'.`,
      };
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return {
      ok: false,
      code: 'invalid-path',
      message: `Artifact path '${rawPath}' resolves to the skill root itself.`,
    };
  }

  return { ok: true, path: segments.join('/') };
}

/**
 * Orders entries by path in code-unit order.
 *
 * Deliberately not `localeCompare`: a locale-sensitive comparison would make the artifact digest
 * depend on the host's locale, so the same bundle would hash differently on two machines.
 */
function compareByPath(left: SkillArtifactEntry, right: SkillArtifactEntry): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

/** Computes the artifact digest over already-ordered entries. */
/**
 * True when admitting one more file of `size` bytes would breach a limit.
 *
 * Exposed so the filesystem reader can refuse a file from its `lstat` result, before reading it.
 * Checking only after the walk meant a 200 MiB file was fully loaded into memory and then
 * reported as too large, which is the opposite of what a limit is for.
 */
export function exceedsAdmissionLimits(
  limits: ResolvedSkillAdmissionLimits,
  running: { readonly fileCount: number; readonly totalBytes: number },
  size: number,
): SkillAdmissionDiagnostic | undefined {
  if (size > limits.maximumFileBytes) {
    return {
      code: 'file-too-large',
      message: `File is ${size} bytes, over the per-file limit of ${limits.maximumFileBytes}.`,
    };
  }
  if (running.fileCount + 1 > limits.maximumFileCount) {
    return {
      code: 'too-many-files',
      message: `Artifact carries more than the limit of ${limits.maximumFileCount} files.`,
    };
  }
  if (running.totalBytes + size > limits.maximumTotalBytes) {
    return {
      code: 'artifact-too-large',
      message: `Artifact is over the limit of ${limits.maximumTotalBytes} bytes.`,
    };
  }
  return undefined;
}

async function computeArtifactDigest(entries: readonly SkillArtifactEntry[]): Promise<string> {
  const canonical = entries.map((entry) => `${entry.path}\0${entry.digest}`).join('\n');
  return sha256Hex(canonical);
}

function checkLimits(
  files: readonly SkillArtifactInputFile[],
  limits: ResolvedSkillAdmissionLimits,
): SkillAdmissionDiagnostic[] {
  const diagnostics: SkillAdmissionDiagnostic[] = [];

  if (files.length > limits.maximumFileCount) {
    diagnostics.push({
      code: 'too-many-files',
      message: `Artifact carries ${files.length} files, over the limit of ${limits.maximumFileCount}.`,
    });
  }

  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.bytes.byteLength;
    if (file.bytes.byteLength > limits.maximumFileBytes) {
      diagnostics.push({
        code: 'file-too-large',
        message: `File is ${file.bytes.byteLength} bytes, over the per-file limit of ${limits.maximumFileBytes}.`,
        path: file.path,
      });
    }
  }

  if (totalBytes > limits.maximumTotalBytes) {
    diagnostics.push({
      code: 'artifact-too-large',
      message: `Artifact is ${totalBytes} bytes, over the limit of ${limits.maximumTotalBytes}.`,
    });
  }

  return diagnostics;
}

function normalizePaths(files: readonly SkillArtifactInputFile[]): {
  readonly normalized: Array<{ path: string; bytes: Uint8Array }>;
  readonly diagnostics: SkillAdmissionDiagnostic[];
} {
  const diagnostics: SkillAdmissionDiagnostic[] = [];
  const normalized: Array<{ path: string; bytes: Uint8Array }> = [];
  const seen = new Set<string>();

  for (const file of files) {
    const result = normalizeArtifactPath(file.path);
    if (!result.ok) {
      diagnostics.push({ code: result.code, message: result.message, path: file.path });
      continue;
    }

    if (seen.has(result.path)) {
      diagnostics.push({
        code: 'duplicate-path',
        message: `Two files normalize to the same artifact path '${result.path}'.`,
        path: file.path,
      });
      continue;
    }

    seen.add(result.path);
    normalized.push({ path: result.path, bytes: file.bytes });
  }

  return { normalized, diagnostics };
}

/** Options for {@link createSkillArtifact}. */
export interface CreateSkillArtifactOptions {
  readonly limits?: SkillAdmissionLimits;
  /**
   * Require a `SKILL.md` (or `skill.md`) at the artifact root. Default `true`. A caller assembling
   * a partial bundle for inspection can turn it off; a caller admitting one for activation must
   * not.
   */
  readonly requireManifest?: boolean;
}

/**
 * Builds a complete bounded artifact from offered files, or refuses the whole bundle.
 *
 * Every check runs before any content is admitted, and every failure is collected rather than
 * thrown at the first one, so a publisher fixing a bundle sees the full list instead of peeling it
 * one error at a time.
 */
export async function createSkillArtifact(
  name: string,
  files: readonly SkillArtifactInputFile[],
  options?: CreateSkillArtifactOptions,
): Promise<SkillArtifactAdmission> {
  const limits = resolveAdmissionLimits(options?.limits);
  const { normalized, diagnostics: pathDiagnostics } = normalizePaths(files);
  const diagnostics: SkillAdmissionDiagnostic[] = [
    ...pathDiagnostics,
    ...checkLimits(files, limits),
  ];

  if (options?.requireManifest !== false) {
    const hasManifest = normalized.some(
      (file) =>
        file.path === SKILL_MANIFEST_FILENAME || file.path === SKILL_MANIFEST_FALLBACK_FILENAME,
    );
    if (!hasManifest) {
      diagnostics.push({
        code: 'missing-skill-file',
        message: `Artifact has no ${SKILL_MANIFEST_FILENAME} at its root.`,
      });
    }
  }

  if (diagnostics.length > 0) return { admitted: false, diagnostics };

  const entries: SkillArtifactEntry[] = await Promise.all(
    normalized.map(async (file) => ({
      path: file.path,
      bytes: file.bytes,
      mediaType: resolveMediaType(file.path),
      digest: await sha256BytesHex(file.bytes),
    })),
  );

  entries.sort(compareByPath);

  return {
    admitted: true,
    artifact: {
      name,
      entries,
      digest: await computeArtifactDigest(entries),
      totalBytes: entries.reduce((total, entry) => total + entry.bytes.byteLength, 0),
    },
  };
}

/** Returns the entry at `path`, or `undefined` when the artifact does not carry one. */
export function findArtifactEntry(
  artifact: SkillArtifact,
  path: string,
): SkillArtifactEntry | undefined {
  const normalized = normalizeArtifactPath(path);
  if (!normalized.ok) return undefined;
  return artifact.entries.find((entry) => entry.path === normalized.path);
}

/** The artifact's instructions file, preferring `SKILL.md` over `skill.md` as upstream does. */
export function findArtifactManifest(artifact: SkillArtifact): SkillArtifactEntry | undefined {
  return (
    artifact.entries.find((entry) => entry.path === SKILL_MANIFEST_FILENAME) ??
    artifact.entries.find((entry) => entry.path === SKILL_MANIFEST_FALLBACK_FILENAME)
  );
}

/**
 * Decodes an entry's bytes as UTF-8 text.
 *
 * Separate from the entry itself on purpose: decoding is the caller's choice, made per resource,
 * so a bundled PNG is never quietly turned into replacement characters on its way through.
 */
export function decodeArtifactText(entry: SkillArtifactEntry): string {
  return new TextDecoder('utf-8').decode(entry.bytes);
}
