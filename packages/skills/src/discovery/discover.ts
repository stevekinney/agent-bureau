import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { sha256Hex } from '@lostgradient/cryptography';
import type { TextValueStore } from '@lostgradient/weft';

import {
  decodeArtifactText,
  findArtifactManifest,
  type SkillAdmissionLimits,
  type SkillArtifact,
} from '../artifact';
import { readSkillArtifact } from '../ingestion/read-skill-artifact';
import { importSkillMarkdown, SkillParseError } from '../parse-skill-markdown';
import type {
  SkillCatalogRecord,
  SkillCatalogRevision,
  SkillCompatibility,
  SkillDiscoveryOutcome,
  SkillSourceDiagnostic,
  SkillUnavailableReason,
} from './catalog';
import { deepCloneAndFreeze } from './catalog';
import {
  materializeRemoteSource,
  type MaterializeRemoteSourceOptions,
  type RemoteSkillSource,
} from './remote';
import { resolveTrust, type SkillSource, type SkillTrustPolicy } from './source';
import { readStoredSkillArtifacts } from './storage-source';

/** Options for {@link discoverSkills}. */
export interface DiscoverSkillsOptions {
  /** Where to look, in the caller's own order. Precedence comes from each source, not this order. */
  readonly sources: readonly SkillSource[];
  /** Decides which sources may contribute. Omit to use the defaults for each source kind. */
  readonly trustPolicy?: SkillTrustPolicy;
  /** Bounds on each discovered skill's bundle. */
  readonly limits?: SkillAdmissionLimits;
  /** Cancels the pass. A cancelled pass still produces a revision, marked `cancelled`. */
  readonly signal?: AbortSignal;
  /** The revision number to stamp. Callers holding a catalog pass the next one. */
  readonly revision?: number;
  /** Timestamp for the revision. Injectable so a test need not read a real clock. */
  readonly now?: () => string;
  /** Most skill directories to consider per source. Default 512. */
  readonly maximumSkillsPerSource?: number;
  /**
   * How to reach remote sources. Required before a `remote` source can contribute anything.
   *
   * Absent, a remote source is reported unavailable rather than quietly skipped: a catalog that
   * silently omitted a configured source would be indistinguishable from one whose source was
   * empty.
   */
  readonly remote?: Pick<MaterializeRemoteSourceOptions, 'fetch' | 'verifySignature'>;
  /**
   * The durable store backing `storage` sources.
   *
   * Required before a `storage` source can contribute, for the same reason a remote source needs a
   * transport: a configured source with no way to reach it is reported unavailable rather than
   * silently skipped.
   */
  readonly storage?: TextValueStore;
}

/**
 * Builds catalog records from artifacts already in hand.
 *
 * Shared by the remote and storage paths, which differ only in how the bytes arrive. Writing this
 * twice is how the two would drift on trust, compatibility or availability — the sort of
 * divergence that is invisible until one path admits something the other refuses.
 */
function recordsFromArtifacts(
  source: SkillSource,
  artifacts: ReadonlyMap<string, SkillArtifact>,
  trust: ReturnType<typeof resolveTrust>,
  defaultBundleSupport: 'complete' | 'manifest-only',
): { discovered: Discovered[]; diagnostics: SkillSourceDiagnostic[] } {
  const discovered: Discovered[] = [];
  const diagnostics: SkillSourceDiagnostic[] = [];

  for (const [name, artifact] of [...artifacts].toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const manifest = findArtifactManifest(artifact);
    if (manifest === undefined) continue;

    let imported;
    try {
      imported = importSkillMarkdown(decodeArtifactText(manifest), { directoryName: name });
    } catch {
      diagnostics.push({
        sourceId: source.id,
        code: 'admission-failed',
        message: `Skill '${name}' from source '${source.id}' could not be parsed.`,
      });
      continue;
    }

    const compatibility = compatibilityFrom(imported);
    const usable = isUsable(compatibility);
    const trusted = trust.state === 'trusted';
    const unavailableReason: SkillUnavailableReason | undefined = !trusted
      ? trust.state === 'revoked'
        ? 'source-revoked'
        : 'source-untrusted'
      : usable
        ? undefined
        : 'invalid';

    discovered.push({
      precedence: source.precedence,
      record: {
        name: imported.content.metadata.name,
        description: imported.content.metadata.description,
        directoryName: name,
        sourceId: source.id,
        sourceKind: source.kind,
        sourceLocation: source.location,
        bundleSupport: source.bundleSupport ?? defaultBundleSupport,
        trust: trust.state,
        trustReason: trust.reason,
        artifactDigest: artifact.digest,
        compatibility,
        available: unavailableReason === undefined,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
      },
    });
  }

  return { discovered, diagnostics };
}

/** True when a source is a remote one, by its own declared kind. */
function isRemote(source: SkillSource): source is RemoteSkillSource {
  return source.kind === 'remote';
}

const DEFAULT_MAXIMUM_SKILLS_PER_SOURCE = 512;

/**
 * How many raw directory entries may be examined per admitted skill before a source is considered
 * unreasonably noisy. Generous enough that a normal root with a README and a `.gitignore` is
 * unaffected.
 */
const MAXIMUM_ENTRIES_PER_ADMITTED_SKILL = 8;

/**
 * Reads an abort signal through a function call.
 *
 * `AbortSignal.aborted` is declared `readonly boolean`, so TypeScript narrows it after the first
 * check and treats every later read in the same scope as a comparison that cannot change — which
 * is exactly wrong for a flag whose entire purpose is to flip underneath a running loop.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

interface Candidate {
  readonly source: SkillSource;
  readonly directoryName: string;
  readonly directoryPath: string;
}

/**
 * Lists a source's immediate skill directories.
 *
 * Only one level deep, which is the specification's own layout: a discovery root contains skill
 * directories, and a skill directory contains `SKILL.md`. Recursing further would make a skill's
 * own `references/` directory look like another skill root.
 */
async function listCandidates(
  source: SkillSource,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ candidates: Candidate[]; diagnostics: SkillSourceDiagnostic[]; cancelled: boolean }> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(source.location));
  } catch {
    return {
      candidates: [],
      cancelled: false,
      diagnostics: [
        {
          sourceId: source.id,
          code: 'unavailable',
          message: `Source '${source.id}' root '${source.location}' could not be resolved.`,
        },
      ],
    };
  }

  let names: readonly string[];
  try {
    names = await readdir(canonicalRoot);
  } catch {
    return {
      candidates: [],
      cancelled: false,
      diagnostics: [
        {
          sourceId: source.id,
          code: 'unavailable',
          message: `Source '${source.id}' root '${source.location}' could not be listed.`,
        },
      ],
    };
  }

  // Sorted so a pass is identical whatever order the filesystem reports entries in. Without this
  // the catalog's collision outcomes would depend on directory enumeration order, which is exactly
  // the determinism this issue is about.
  names = names.toSorted();

  const candidates: Candidate[] = [];
  const diagnostics: SkillSourceDiagnostic[] = [];
  const seenTargets = new Set<string>();
  let cancelled = false;
  let examined = 0;

  for (const name of names) {
    // Bounded two ways, because each alone is wrong. Counting only admitted directories lets a root
    // full of stray files cost an unbounded number of syscalls; counting only raw entries lets
    // those same files hide every real skill behind them.
    if (candidates.length >= limit) break;
    if (examined >= limit * MAXIMUM_ENTRIES_PER_ADMITTED_SKILL) {
      diagnostics.push({
        sourceId: source.id,
        code: 'unavailable',
        message: `Source '${source.id}' root holds more entries than the scan is allowed to examine.`,
      });
      break;
    }

    // Checked inside the walk, not only around it: enumerating a large directory is exactly the
    // slow part a caller wants to be able to cancel, and an abort that is only honoured between
    // sources leaves the scan unresponsive for the whole of it.
    if (isAborted(signal)) {
      cancelled = true;
      diagnostics.push({
        sourceId: source.id,
        code: 'cancelled',
        message: `Enumeration of source '${source.id}' stopped after ${examined} entries.`,
      });
      break;
    }

    examined += 1;
    const directoryPath = join(canonicalRoot, name);

    let entry;
    try {
      entry = await lstat(directoryPath);
    } catch {
      continue;
    }

    // `lstat`, then an explicit containment check on the resolved target. Using `stat` here
    // followed the link silently, and because the artifact reader canonicalizes the path it is
    // given, containment was then enforced relative to the link's *target* — so a skill directory
    // that was itself a symbolic link read content from anywhere on the filesystem and was
    // catalogued as living at the configured root.
    let resolvedTarget = directoryPath;
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(directoryPath);
      } catch {
        diagnostics.push({
          sourceId: source.id,
          code: 'containment-refused',
          message: `Skill directory '${name}' is a symbolic link that does not resolve.`,
        });
        continue;
      }
      if (!target.startsWith(canonicalRoot + sep)) {
        diagnostics.push({
          sourceId: source.id,
          code: 'containment-refused',
          // Also covers a link resolving to the root *itself*: `skills/loop -> .` stays inside the
          // root but makes the whole discovery tree look like one skill bundle.
          message: `Skill directory '${name}' is a symbolic link that does not resolve to a directory inside the discovery root.`,
        });
        continue;
      }
      resolvedTarget = target;
    }

    try {
      const info = await stat(directoryPath);
      if (!info.isDirectory()) continue;
      await stat(join(directoryPath, 'SKILL.md')).catch(async () => {
        await stat(join(directoryPath, 'skill.md'));
      });
    } catch {
      continue;
    }

    // An in-root alias (`alias -> real`) is the same directory reached twice. Admitting both
    // produced a phantom duplicate that could out-sort the real one, so the catalog reported the
    // skill as living at whichever path happened to sort first.
    if (seenTargets.has(resolvedTarget)) continue;
    seenTargets.add(resolvedTarget);

    candidates.push({ source, directoryName: name, directoryPath });
  }

  return { candidates, diagnostics, cancelled: cancelled || isAborted(signal) };
}

function compatibilityFrom(imported: ReturnType<typeof importSkillMarkdown>): SkillCompatibility {
  return {
    conformant: imported.conformant,
    diagnostics: imported.conformance,
    repairs: imported.repairs.map((repair) => repair.message),
  };
}

/**
 * Whether a conformance failure makes a skill unusable rather than merely unportable.
 *
 * The same line the conformance issue drew, now recorded per entry instead of per ingestion run:
 * an unknown frontmatter key or a directory disagreement costs portability and confers no
 * authority, while a broken name or a missing description leaves nothing to offer.
 */
function isUsable(compatibility: SkillCompatibility): boolean {
  return compatibility.diagnostics.every(
    (diagnostic) =>
      diagnostic.code === 'unexpected-field' || diagnostic.code === 'name-directory-mismatch',
  );
}

async function readCandidate(
  candidate: Candidate,
  limits: SkillAdmissionLimits | undefined,
): Promise<
  | {
      readonly ok: true;
      readonly artifact: SkillArtifact;
      readonly compatibility: SkillCompatibility;
      readonly name: string;
      readonly description: string;
    }
  | { readonly ok: false; readonly diagnostic: SkillSourceDiagnostic }
> {
  const admission = await readSkillArtifact(
    candidate.directoryPath,
    limits === undefined ? undefined : { limits },
  );

  if (!admission.admitted) {
    return {
      ok: false,
      diagnostic: {
        sourceId: candidate.source.id,
        code: 'admission-failed',
        message: `Skill directory '${candidate.directoryName}' was refused.`,
        admission: admission.diagnostics,
      },
    };
  }

  const manifest = findArtifactManifest(admission.artifact);
  if (manifest === undefined) {
    return {
      ok: false,
      diagnostic: {
        sourceId: candidate.source.id,
        code: 'admission-failed',
        message: `Skill directory '${candidate.directoryName}' has no SKILL.md.`,
      },
    };
  }

  try {
    const imported = importSkillMarkdown(decodeArtifactText(manifest), {
      directoryName: candidate.directoryName,
    });
    return {
      ok: true,
      artifact: admission.artifact,
      compatibility: compatibilityFrom(imported),
      name: imported.content.metadata.name,
      description: imported.content.metadata.description,
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: {
        sourceId: candidate.source.id,
        code: 'admission-failed',
        message:
          error instanceof SkillParseError
            ? `Skill directory '${candidate.directoryName}': ${error.message}`
            : `Skill directory '${candidate.directoryName}' could not be parsed.`,
      },
    };
  }
}

interface Discovered {
  readonly record: SkillCatalogRecord;
  readonly precedence: number;
}

function buildRecord(
  candidate: Candidate,
  read: Extract<Awaited<ReturnType<typeof readCandidate>>, { ok: true }>,
  trust: ReturnType<typeof resolveTrust>,
): SkillCatalogRecord {
  const usable = isUsable(read.compatibility);
  const trusted = trust.state === 'trusted';

  let unavailableReason: SkillUnavailableReason | undefined;
  if (!trusted) {
    unavailableReason = trust.state === 'revoked' ? 'source-revoked' : 'source-untrusted';
  } else if (!usable) {
    unavailableReason = 'invalid';
  }

  return {
    name: read.name,
    description: read.description,
    directoryName: candidate.directoryName,
    sourceId: candidate.source.id,
    sourceKind: candidate.source.kind,
    sourceLocation: candidate.source.location,
    bundleSupport: candidate.source.bundleSupport ?? 'complete',
    trust: trust.state,
    trustReason: trust.reason,
    artifactDigest: read.artifact.digest,
    compatibility: read.compatibility,
    available: unavailableReason === undefined,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

/**
 * Resolves name collisions by precedence, and records what lost.
 *
 * A shadowed entry stays in the catalog marked `shadowed` rather than being dropped. An operator
 * debugging "why is my project skill not the one running" needs to see both, and a catalog that
 * silently discarded the loser could not answer that question.
 *
 * Two entries with the same name *and* the same artifact digest are the identical skill reached
 * through two sources; the loser is still marked shadowed, but that is a fact rather than a
 * conflict, so it produces no diagnostic.
 */
function resolveCollisions(discovered: readonly Discovered[]): {
  records: SkillCatalogRecord[];
  diagnostics: SkillSourceDiagnostic[];
} {
  const byName = new Map<string, Discovered[]>();
  for (const entry of discovered) {
    const existing = byName.get(entry.record.name);
    if (existing) existing.push(entry);
    else byName.set(entry.record.name, [entry]);
  }

  const records: SkillCatalogRecord[] = [];
  const diagnostics: SkillSourceDiagnostic[] = [];

  for (const [name, entries] of byName) {
    const ordered = entries.toSorted((left, right) => {
      if (left.precedence !== right.precedence) return left.precedence - right.precedence;
      if (left.record.sourceId !== right.record.sourceId) {
        return left.record.sourceId < right.record.sourceId ? -1 : 1;
      }
      const leftDirectory = left.record.directoryName ?? '';
      const rightDirectory = right.record.directoryName ?? '';
      if (leftDirectory !== rightDirectory) return leftDirectory < rightDirectory ? -1 : 1;
      // A consistent comparator must return 0 for equal elements; returning 1 makes the sort's
      // behaviour implementation-defined and, with it, the catalog's.
      return 0;
    });

    const [winner, ...losers] = ordered;
    if (!winner) continue;
    records.push(winner.record);

    for (const loser of losers) {
      records.push({
        ...loser.record,
        available: false,
        unavailableReason: 'shadowed',
        shadowedBy:
          loser.record.sourceId === winner.record.sourceId
            ? `${winner.record.sourceId}:${winner.record.directoryName ?? name}`
            : winner.record.sourceId,
      });

      // Two entries with the same name *and* the same artifact digest are the identical skill
      // reached through two sources: a fact, not a disagreement. Different content under one name
      // is a real conflict and the operator is told which source won.
      if (loser.record.artifactDigest !== winner.record.artifactDigest) {
        diagnostics.push({
          sourceId: loser.record.sourceId,
          code: 'name-conflict',
          message: `Skill '${name}' is also provided with different content by source '${winner.record.sourceId}', which takes precedence.`,
        });
      }
    }
  }

  return {
    records: records.toSorted((left, right) => {
      if (left.name !== right.name) return left.name < right.name ? -1 : 1;
      if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
      const leftDirectory = left.directoryName ?? '';
      const rightDirectory = right.directoryName ?? '';
      if (leftDirectory !== rightDirectory) return leftDirectory < rightDirectory ? -1 : 1;
      return 0;
    }),
    diagnostics,
  };
}

async function computeRevisionDigest(
  records: readonly SkillCatalogRecord[],
  sourceDiagnostics: readonly SkillSourceDiagnostic[],
): Promise<string> {
  // Every field the catalog exposes, not just the ones that felt important. A digest blind to
  // `sourceLocation` or `bundleSupport` made a refresh report `unchanged` after a source moved or
  // changed what it can deliver — and because every later refresh reached the same conclusion, the
  // catalog served the stale value permanently. Source diagnostics are included for the same
  // reason: a root that starts failing while holding no skills changes nothing else.
  const canonical = [
    ...records.map((record) =>
      [
        record.name,
        record.directoryName ?? '',
        record.sourceId,
        record.sourceKind,
        record.sourceLocation,
        record.bundleSupport,
        record.trust,
        record.trustReason,
        record.artifactDigest,
        String(record.compatibility.conformant),
        record.compatibility.diagnostics.map((diagnostic) => diagnostic.code).join(','),
        record.compatibility.repairs.join('|'),
        String(record.available),
        record.unavailableReason ?? '',
        record.shadowedBy ?? '',
      ].join('\u0000'),
    ),
    ...sourceDiagnostics.map((diagnostic) =>
      ['@diagnostic', diagnostic.sourceId, diagnostic.code, diagnostic.message].join('\u0000'),
    ),
  ].join('\n');
  return sha256Hex(canonical);
}

/**
 * Fetches, verifies and catalogues one remote source.
 *
 * Trust follows verification here rather than preceding it: a remote source is trusted exactly
 * when an integrity policy admitted its content, which is what the criterion "remote artifacts
 * require configured integrity or signature policy before admission" means in practice. An
 * explicit trust policy still wins, so a host can revoke a source whose signatures are valid.
 */
async function collectRemote(
  source: RemoteSkillSource,
  options: DiscoverSkillsOptions,
): Promise<{
  discovered: Discovered[];
  diagnostics: SkillSourceDiagnostic[];
  cancelled: boolean;
}> {
  if (options.remote === undefined) {
    return {
      cancelled: false,
      discovered: [],
      diagnostics: [
        {
          sourceId: source.id,
          code: 'unavailable',
          message: `Remote source '${source.id}' is configured but no transport was supplied.`,
        },
      ],
    };
  }

  const materialized = await materializeRemoteSource(source, {
    fetch: options.remote.fetch,
    ...(options.remote.verifySignature === undefined
      ? {}
      : { verifySignature: options.remote.verifySignature }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const diagnostics: SkillSourceDiagnostic[] = materialized.diagnostics.map((diagnostic) => ({
    sourceId: source.id,
    code:
      diagnostic.code === 'integrity-policy-missing'
        ? 'untrusted'
        : diagnostic.code === 'cancelled'
          ? 'cancelled'
          : 'admission-failed',
    message: diagnostic.message,
  }));

  // An explicit policy decision always wins, so a host can revoke a source whose signatures are
  // perfectly valid. Only when the policy has no opinion does verification itself decide: content
  // that an integrity policy admitted is trusted, and a source that admitted nothing falls back to
  // the documented default for its kind.
  const admittedAnything = materialized.artifacts.length > 0;
  const trust =
    options.trustPolicy?.decide(source) ??
    (admittedAnything
      ? ({
          state: 'trusted',
          reason: `Remote source '${source.id}' content was admitted by its integrity policy.`,
        } as const)
      : resolveTrust(source, undefined));

  const built = recordsFromArtifacts(
    source,
    new Map(materialized.artifacts.map((entry) => [entry.name, entry.artifact])),
    trust,
    // This transport carries only SKILL.md, so an entry says so rather than promising resources no
    // load could return.
    'manifest-only',
  );
  diagnostics.push(...built.diagnostics);
  const discovered = built.discovered;

  return { discovered, diagnostics, cancelled: materialized.cancelled };
}

/**
 * Reads a durable store as a source.
 *
 * Trust is the source's own decision rather than something verification confers, because unlike a
 * remote registry there is no third party here: these are skills this runtime already admitted and
 * persisted, so refusing them would make an accepted self-improvement proposal unusable by the run
 * that accepted it.
 */
async function collectStorage(
  source: SkillSource,
  options: DiscoverSkillsOptions,
): Promise<{ discovered: Discovered[]; diagnostics: SkillSourceDiagnostic[] }> {
  if (options.storage === undefined) {
    return {
      discovered: [],
      diagnostics: [
        {
          sourceId: source.id,
          code: 'unavailable',
          message: `Storage source '${source.id}' is configured but no store was supplied.`,
        },
      ],
    };
  }

  const trust = resolveTrust(source, options.trustPolicy);
  const artifacts = await readStoredSkillArtifacts(
    options.storage,
    options.limits === undefined ? undefined : { limits: options.limits },
  );
  // A stored skill carries its whole bundle, resources included, so it is a complete bundle in a
  // way a manifest-only registry is not.
  return recordsFromArtifacts(source, artifacts, trust, 'complete');
}

/**
 * Builds one immutable catalog revision from the configured sources.
 *
 * Every source is visited, including untrusted ones: an untrusted source contributes entries that
 * are present and unavailable, with the reason attached, because a host that wants to prompt "this
 * workspace has 3 skills, trust it?" needs to know they exist. What an untrusted source never gets
 * is availability.
 *
 * Cancellation produces a revision rather than throwing. A caller that aborted still wants to know
 * what was found before the abort, and a partially-filled catalog marked `cancelled` is honest in
 * a way that a rejected promise is not.
 */
export async function discoverSkills(
  options: DiscoverSkillsOptions,
): Promise<SkillCatalogRevision> {
  const limit = options.maximumSkillsPerSource ?? DEFAULT_MAXIMUM_SKILLS_PER_SOURCE;
  const discovered: Discovered[] = [];
  const sourceDiagnostics: SkillSourceDiagnostic[] = [];
  let outcome: SkillDiscoveryOutcome = 'completed';

  // Sources are visited in precedence order so the walk itself is deterministic, independent of
  // how the caller happened to order its configuration.
  const sources = options.sources.toSorted((left, right) => {
    if (left.precedence !== right.precedence) return left.precedence - right.precedence;
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    return 0;
  });

  // Source ids are documented unique and the catalog keys provenance on them, so a duplicate would
  // make two different roots indistinguishable in every record and let one `admitSources` entry
  // admit both.
  const seenIds = new Set<string>();
  for (const source of sources) {
    if (seenIds.has(source.id)) {
      sourceDiagnostics.push({
        sourceId: source.id,
        code: 'duplicate-source-id',
        message: `Source id '${source.id}' is configured more than once; provenance would be ambiguous.`,
      });
    }
    seenIds.add(source.id);
  }

  for (const source of sources) {
    if (isAborted(options.signal)) {
      outcome = 'cancelled';
      break;
    }

    if (source.kind === 'storage') {
      const stored = await collectStorage(source, options);
      sourceDiagnostics.push(...stored.diagnostics);
      discovered.push(...stored.discovered);
      continue;
    }

    if (isRemote(source)) {
      const remoteResult = await collectRemote(source, options);
      sourceDiagnostics.push(...remoteResult.diagnostics);
      discovered.push(...remoteResult.discovered);
      // Propagated rather than dropped. Returning normally from a cancelled fetch let the loop
      // finish and report `completed`, so an abort mid-poll committed a truncated catalog as
      // though it were the whole thing — and attributed the abort to the registry.
      if (remoteResult.cancelled) {
        outcome = 'cancelled';
        break;
      }
      continue;
    }

    const trust = resolveTrust(source, options.trustPolicy);
    const {
      candidates,
      diagnostics: listDiagnostics,
      cancelled: listCancelled,
    } = await listCandidates(source, limit, options.signal);
    sourceDiagnostics.push(...listDiagnostics);
    if (listCancelled) {
      outcome = 'cancelled';
      break;
    }

    if (trust.state !== 'trusted') {
      sourceDiagnostics.push({
        sourceId: source.id,
        code: trust.state === 'revoked' ? 'revoked' : 'untrusted',
        message: trust.reason,
      });
    }

    for (const candidate of candidates) {
      if (isAborted(options.signal)) {
        outcome = 'cancelled';
        break;
      }

      const read = await readCandidate(candidate, options.limits);
      if (!read.ok) {
        sourceDiagnostics.push(read.diagnostic);
        continue;
      }

      discovered.push({
        record: buildRecord(candidate, read, trust),
        precedence: source.precedence,
      });
    }

    if (outcome === 'cancelled') break;
  }

  // Checked once more after the loop: an abort that lands while the *last* source is being read
  // leaves the loop by exhaustion rather than by the break above, and reporting that pass as
  // `completed` is what let a cancelled refresh commit a partial catalog.
  if (outcome !== 'cancelled' && isAborted(options.signal)) {
    outcome = 'cancelled';
  }

  if (outcome === 'cancelled') {
    sourceDiagnostics.push({
      sourceId: '*',
      code: 'cancelled',
      message: 'Discovery was cancelled before every source was visited.',
    });
  }

  const { records, diagnostics: collisionDiagnostics } = resolveCollisions(discovered);
  sourceDiagnostics.push(...collisionDiagnostics);

  // Frozen all the way down, and here rather than only in the catalog service: `discoverSkills` is
  // exported, and a caller feeding its result back in as `initial` is the natural way to produce a
  // revision — so returning a mutable graph from the public function left the guarantee with a hole
  // in exactly the shape of its intended use.
  return deepCloneAndFreeze({
    revision: options.revision ?? 1,
    createdAt: options.now?.() ?? new Date().toISOString(),
    outcome,
    records,
    sourceDiagnostics,
    digest: await computeRevisionDigest(records, sourceDiagnostics),
  });
}
