import type { SkillAdmissionDiagnostic } from '../artifact';
import type { SkillConformanceDiagnostic } from '../conformance';
import type { SkillBundleSupport, SkillSourceKind, SkillTrustState } from './source';

/**
 * What strict validation made of a skill, kept alongside it rather than deciding its fate.
 *
 * A catalog entry records the verdict and stays inspectable; nothing here throws a skill away. The
 * conformance issue reported this through an ingestion result's `repaired` array, which could only
 * describe skills that happened to load — this is the per-entry home that verdict belongs in.
 */
export interface SkillCompatibility {
  /** True only when strict validation passed and nothing needed repairing. */
  readonly conformant: boolean;
  /** Every strict-conformance failure, empty when conformant. */
  readonly diagnostics: readonly SkillConformanceDiagnostic[];
  /** What diagnostic import had to change to read the skill at all. */
  readonly repairs: readonly string[];
}

/** Why a discovered skill is not available for activation. */
export type SkillUnavailableReason =
  'source-untrusted' | 'source-revoked' | 'shadowed' | 'invalid' | 'unreadable';

/**
 * One skill in a catalog revision.
 *
 * Every field a host needs to decide whether to offer this skill, and none it does not: there is
 * deliberately no credential, no absolute path beyond the source's own canonical location, and no
 * instruction body. Tier-one disclosure is `name` and `description`; the body is loaded at
 * activation, not catalogued.
 */
export interface SkillCatalogRecord {
  readonly name: string;
  readonly description: string;
  /**
   * The directory the skill was read from, when it came from one.
   *
   * Carried because a name and a source id together do not identify a skill: two directories in
   * one root can declare the same name, and without this their catalog entries would be
   * indistinguishable.
   */
  readonly directoryName?: string;
  readonly sourceId: string;
  readonly sourceKind: SkillSourceKind;
  /** The source's canonical location, as configured. Never carries a credential. */
  readonly sourceLocation: string;
  readonly bundleSupport: SkillBundleSupport;
  readonly trust: SkillTrustState;
  /** Why the trust decision went the way it did. */
  readonly trustReason: string;
  /** SHA-256 over the artifact's ordered path/content digests. */
  readonly artifactDigest: string;
  readonly compatibility: SkillCompatibility;
  /**
   * Whether this entry may be activated.
   *
   * False is never silent: {@link unavailableReason} always says why, so a host can tell an
   * untrusted workspace apart from a skill that simply lost a name collision.
   */
  readonly available: boolean;
  readonly unavailableReason?: SkillUnavailableReason;
  /** The source that shadows this entry, when `unavailableReason` is `shadowed`. */
  readonly shadowedBy?: string;
}

/** A source that produced no usable skills, and why. */
export interface SkillSourceDiagnostic {
  readonly sourceId: string;
  /**
   * Machine-readable reason.
   *
   * Distinct codes rather than one catch-all: a host cannot act on "something went wrong". A
   * refused bundle, two sources disagreeing about a name, a link out of the root and a misconfigured
   * source id call for four different responses, so they carry four different codes.
   */
  readonly code:
    | 'unavailable'
    | 'untrusted'
    | 'revoked'
    | 'admission-failed'
    | 'containment-refused'
    | 'name-conflict'
    | 'duplicate-source-id'
    | 'cancelled';
  readonly message: string;
  /** Admission diagnostics from the artifact layer, when the failure came from there. */
  readonly admission?: readonly SkillAdmissionDiagnostic[];
}

/** How a discovery pass ended. */
export type SkillDiscoveryOutcome = 'completed' | 'cancelled' | 'failed';

/**
 * An immutable catalog generation.
 *
 * A run binds one revision and keeps it. A source that changes on disk produces a *later*
 * revision; it never edits this one, so instructions already admitted to a conversation cannot be
 * rewritten underneath it by someone touching a file. That is the whole reason revisions are
 * numbered rather than a catalog simply being re-read.
 */
export interface SkillCatalogRevision {
  /** Monotonic within one catalog, starting at 1. */
  readonly revision: number;
  readonly createdAt: string;
  readonly outcome: SkillDiscoveryOutcome;
  /** Every discovered skill, available or not, ordered by name. */
  readonly records: readonly SkillCatalogRecord[];
  readonly sourceDiagnostics: readonly SkillSourceDiagnostic[];
  /**
   * SHA-256 over the revision's ordered content.
   *
   * Two revisions with equal digests represent the same catalog, which lets a refresh decide it
   * has nothing to commit without comparing entry by entry.
   */
  readonly digest: string;
}

/**
 * Recursively clones an object graph and freezes the clone at every level, never mutating the
 * input.
 *
 * `Object.freeze` is shallow, so freezing a revision and its two top-level arrays leaves every
 * record, every `compatibility` object and every diagnostics array writable. One holder mutating an
 * entry would change what every other holder of that revision sees, while the digest still attested
 * to the original.
 *
 * Cloning rather than freezing in place matters too: `compatibility.diagnostics` is the parser's own
 * array passed through by reference, and freezing it would reach back into state this module does
 * not own.
 */
export function deepCloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: unknown) => deepCloneAndFreeze(item))) as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = deepCloneAndFreeze(nested);
  }
  return Object.freeze(clone) as T;
}

/** The records a host would actually offer a model. */
export function availableRecords(revision: SkillCatalogRevision): readonly SkillCatalogRecord[] {
  return revision.records.filter((record) => record.available);
}

/** Looks up one record by name, available or not. */
export function findRecord(
  revision: SkillCatalogRevision,
  name: string,
): SkillCatalogRecord | undefined {
  return revision.records.find((record) => record.name === name);
}

/**
 * The tier-one projection: exactly what a model may see before activation.
 *
 * Built by omission rather than redaction. A projection that started from the full record and
 * deleted fields would leak every field someone later added and forgot to delete here.
 */
export function generalCatalogProjection(
  revision: SkillCatalogRevision,
): readonly { readonly name: string; readonly description: string }[] {
  return availableRecords(revision).map((record) => ({
    name: record.name,
    description: record.description,
  }));
}
