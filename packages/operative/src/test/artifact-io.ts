// ---------------------------------------------------------------------------
// AB-267 — the reproduction-artifact writer, reader, and replay core (AB-95's
// tst-04c slice, AB-92's testability contract). AB-334 moved the CANONICAL
// `ReproductionArtifact` declaration down here from `bureau/src/test/
// reproduction-artifact.ts` (AB-263): `bureau` depends on
// `@lostgradient/operative`, never the other way around, so the shared
// declaration has to live at the lower layer for bureau to import it.
// AB-263's narrowness at `cleanupReport` (a real union, not `unknown`)
// survives the move as a type parameter, `TCleanupReport`, because its
// widest member — `BureauShutdownReport` — is Bureau-owned and unreachable
// from this package: operative can express and default the parameter, but
// only bureau can supply the argument that includes its own type. Bureau's
// `ReproductionArtifact` (see `packages/bureau/src/test/
// reproduction-artifact.ts`) is now `ReproductionArtifact<ReproductionCleanupReport
// | BureauShutdownReport>` — an instantiation of this declaration, not a
// second one.
// ---------------------------------------------------------------------------

import type { DeferredDrainReport, RuntimeServices } from 'lifecycle';
import { createManualRuntimeServices } from 'lifecycle';

import type { CleanupAcknowledgement } from '../types';
import { createBarrierRegistry } from './barriers';
import type { CausalTraceEntry, EventRecorder } from './event-recorder';
import { createEventRecorder } from './event-recorder';
import { createFaultEngine } from './fault-engine';
import type { FaultPlan, FiredFault } from './fault-plan';

/** One scripted double's recorded outcome (AB-92 AC8), matched field for field. */
export interface ScriptedOutcome {
  readonly boundary: string;
  readonly sequenceNumber: number;
  readonly outcome: unknown;
}

/**
 * The default `cleanupReport` union for a run with no Bureau-specific
 * cleanup shape: a bare `Agent`/`ActiveRun`'s own `CleanupAcknowledgement`,
 * or `RuntimeServices.deferred.drain()`'s `DeferredDrainReport`. Exported by
 * name so a package that widens `ReproductionArtifact`'s `TCleanupReport`
 * (bureau, adding `BureauShutdownReport`) composes onto this union instead
 * of repeating its two members.
 */
export type ReproductionCleanupReport = CleanupAcknowledgement | DeferredDrainReport;

/**
 * AB-92 AC8's `ReproductionArtifact` — the ONE declaration in the
 * repository (AB-334). Field ORDER here is the serialization contract
 * `writeReproductionArtifact` relies on for byte stability. `TCleanupReport`
 * defaults to {@link ReproductionCleanupReport} for a caller with no wider
 * cleanup-report shape of its own; bureau instantiates it with its own
 * union instead (see the module doc above).
 */
export interface ReproductionArtifact<TCleanupReport = ReproductionCleanupReport> {
  readonly sourceRevision: string;
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly effectiveModel: {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
  };
  readonly clockOrigin: string;
  readonly identifierSeed: string;
  readonly randomSeed: string;
  readonly scriptedOutcomes: readonly ScriptedOutcome[];
  readonly firedFaults: readonly FiredFault[];
  readonly causalTrace: readonly CausalTraceEntry[];
  readonly terminalResult: unknown;
  readonly cleanupReport: TCleanupReport;
}

/** Thrown by {@link readReproductionArtifact} when the file at `path` is not a well-formed `ReproductionArtifact`. */
export class InvalidReproductionArtifactError extends Error {
  constructor(path: string, reason: string) {
    super(`readReproductionArtifact: ${path} is not a valid ReproductionArtifact: ${reason}`);
    this.name = 'InvalidReproductionArtifactError';
  }
}

/** Thrown by {@link replayReproductionArtifact} when the replayed run's evidence does not match the artifact's own. */
export class ReproductionArtifactMismatchError extends Error {
  constructor(message: string) {
    super(`replayReproductionArtifact: ${message}`);
    this.name = 'ReproductionArtifactMismatchError';
  }
}

// ---------------------------------------------------------------------------
// writeReproductionArtifact / readReproductionArtifact
// ---------------------------------------------------------------------------

/**
 * Builds a plain object with AB-92 AC8's fields in a FIXED insertion order —
 * `JSON.stringify` walks own-enumerable string keys in insertion order, so
 * this is what makes two artifacts assembled from the same run byte-identical
 * regardless of how the caller happened to build the object it passed in.
 * `packageVersions`' own keys are sorted too, so filesystem/Map enumeration
 * order upstream can never leak into the written bytes.
 */
function canonicalize<TCleanupReport>(
  artifact: ReproductionArtifact<TCleanupReport>,
): ReproductionArtifact<TCleanupReport> {
  const sortedPackageVersions = Object.fromEntries(
    Object.entries(artifact.packageVersions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  return {
    sourceRevision: artifact.sourceRevision,
    packageVersions: sortedPackageVersions,
    effectiveModel: {
      provider: artifact.effectiveModel.provider,
      model: artifact.effectiveModel.model,
      ...(artifact.effectiveModel.effort !== undefined
        ? { effort: artifact.effectiveModel.effort }
        : {}),
    },
    clockOrigin: artifact.clockOrigin,
    identifierSeed: artifact.identifierSeed,
    randomSeed: artifact.randomSeed,
    scriptedOutcomes: artifact.scriptedOutcomes,
    firedFaults: artifact.firedFaults,
    causalTrace: artifact.causalTrace,
    terminalResult: artifact.terminalResult,
    cleanupReport: artifact.cleanupReport,
  };
}

/**
 * Writes `artifact` to `path` as stable, fixed-key-order JSON. Writing the
 * same artifact twice — even from two independently constructed objects
 * with the same field values — produces byte-identical files, which is
 * what makes a committed fixture a meaningful regression target rather
 * than a moving one.
 */
export async function writeReproductionArtifact<TCleanupReport>(
  artifact: ReproductionArtifact<TCleanupReport>,
  path: string,
): Promise<void> {
  const json = `${JSON.stringify(canonicalize(artifact), null, 2)}\n`;
  await Bun.write(path, json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string') {
    throw new InvalidReproductionArtifactError(path, `"${field}" must be a string`);
  }
  return value;
}

function requireStringRecord(
  value: unknown,
  field: string,
  path: string,
): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new InvalidReproductionArtifactError(path, `"${field}" must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new InvalidReproductionArtifactError(path, `"${field}.${key}" must be a string`);
    }
  }
  return value as Readonly<Record<string, string>>;
}

function requireEffectiveModel(
  value: unknown,
  path: string,
): ReproductionArtifact['effectiveModel'] {
  if (!isRecord(value)) {
    throw new InvalidReproductionArtifactError(path, '"effectiveModel" must be an object');
  }
  const provider = requireString(value['provider'], 'effectiveModel.provider', path);
  const model = requireString(value['model'], 'effectiveModel.model', path);
  const effort = value['effort'];
  if (effort !== undefined && typeof effort !== 'string') {
    throw new InvalidReproductionArtifactError(path, '"effectiveModel.effort" must be a string');
  }
  return effort === undefined ? { provider, model } : { provider, model, effort };
}

function requireArray(value: unknown, field: string, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new InvalidReproductionArtifactError(path, `"${field}" must be an array`);
  }
  return value;
}

/**
 * Asserts `field` is a present OWN key of `raw` — not merely that
 * `raw[field]` is not `undefined`, since a JSON object can hold an
 * explicit `null` for either of these two fields but never omit the key
 * entirely. `terminalResult`/`cleanupReport` are the two fields this file
 * cannot validate the SHAPE of (the former is `unknown` by design; the
 * latter is a caller-supplied `TCleanupReport` this function has no way to
 * narrow generically — see {@link readReproductionArtifact}'s own doc
 * comment) — but a missing key is still a corrupted artifact, not a valid
 * one with an absent field, and `raw[field]` alone cannot tell the two
 * apart.
 */
function requirePresentKey(raw: Record<string, unknown>, field: string, path: string): void {
  if (!(field in raw)) {
    throw new InvalidReproductionArtifactError(path, `"${field}" is required`);
  }
}

/**
 * Reads and structurally validates the `ReproductionArtifact` at `path`.
 * Hand-written guards rather than a schema library: `src/test/` ships in
 * `@lostgradient/operative`'s published `./test` subpath, and `zod` is only
 * a devDependency of this package — adding a runtime dependency here for
 * one file's validation is a bigger footprint change than this slice's
 * delivery boundary covers. Returns `ReproductionArtifact<unknown>`: this
 * function validates every field's SHAPE except `cleanupReport`, which is
 * passed through as whatever the JSON held — narrowing it to a caller's own
 * `TCleanupReport` union would need a guard this file has no way to write
 * generically, and every consumer (`replayReproductionArtifact` included)
 * only round-trips the field, never inspects it.
 */
export async function readReproductionArtifact(
  path: string,
): Promise<ReproductionArtifact<unknown>> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (error) {
    // Malformed JSON, a missing file, or any other read/parse failure —
    // surfaced as the same typed error the shape-validation guards below
    // throw, so a caller (the CLI included) never has to distinguish "not
    // valid JSON" from "valid JSON but not a ReproductionArtifact".
    throw new InvalidReproductionArtifactError(
      path,
      `could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new InvalidReproductionArtifactError(path, 'top-level value must be an object');
  }
  requirePresentKey(raw, 'terminalResult', path);
  requirePresentKey(raw, 'cleanupReport', path);

  return {
    sourceRevision: requireString(raw['sourceRevision'], 'sourceRevision', path),
    packageVersions: requireStringRecord(raw['packageVersions'], 'packageVersions', path),
    effectiveModel: requireEffectiveModel(raw['effectiveModel'], path),
    clockOrigin: requireString(raw['clockOrigin'], 'clockOrigin', path),
    identifierSeed: requireString(raw['identifierSeed'], 'identifierSeed', path),
    randomSeed: requireString(raw['randomSeed'], 'randomSeed', path),
    scriptedOutcomes: requireArray(
      raw['scriptedOutcomes'],
      'scriptedOutcomes',
      path,
    ) as readonly ScriptedOutcome[],
    firedFaults: requireArray(raw['firedFaults'], 'firedFaults', path) as readonly FiredFault[],
    causalTrace: requireArray(
      raw['causalTrace'],
      'causalTrace',
      path,
    ) as readonly CausalTraceEntry[],
    terminalResult: raw['terminalResult'],
    cleanupReport: raw['cleanupReport'],
  };
}

// ---------------------------------------------------------------------------
// The baseline replay case. This is the ONE scripted case both the
// committed fixture (generated by a one-off scratchpad script; see the
// pull request body for the exact recipe) and `replayReproductionArtifact`
// below run — deliberately built entirely out of this test kit's own
// primitives (a barrier, a fault-wrapped in-memory store) rather than a
// real `Agent`/`Conversation`, so its causal trace never embeds a real
// Conversation id (AB-321 is the tracked fix for that non-determinism;
// this case sidesteps it rather than depending on it).
// ---------------------------------------------------------------------------

// `wrapStorage` wraps whichever of the four `storage:${verb}` verbs a store
// actually exposes — this baseline case only needs `get`/`set`/`query`, so
// `delete` is omitted rather than left present-but-uncalled.
interface BaselineStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  query(): Promise<readonly string[]>;
}

function createBaselineStore(): BaselineStore {
  const data = new Map<string, unknown>();
  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async query() {
      return [...data.keys()];
    },
  };
}

/** The fixed fault plan every baseline replay case run applies — one `before-work` rejection on the first `storage:get`. */
const BASELINE_FAULT_PLAN: FaultPlan = [
  {
    id: 'reject-first-get',
    boundary: 'before-work',
    operation: 'storage:get',
    occurrence: { kind: 'nth', n: 1 },
    effect: { kind: 'reject-before-work', error: 'baseline-fixture-fault' },
  },
];

export interface BaselineReplayResult {
  readonly causalTrace: readonly CausalTraceEntry[];
  readonly firedFaults: readonly FiredFault[];
  readonly terminalResult: unknown;
}

/**
 * Runs the fixed baseline case against `runtime` — a barrier arrival/release
 * (recorded into the causal trace) followed by a fault-wrapped storage
 * `get`/`set`/`query` sequence (the `get` deliberately faulted, recorded
 * into `firedFaults`). Fully deterministic given a deterministic `runtime`:
 * two runs against two independently constructed `ManualRuntimeServices`
 * pinned to the same seeds produce byte-identical `causalTrace` and
 * `firedFaults`. Exported so both the fixture-generation recipe and
 * {@link replayReproductionArtifact} run the exact same case.
 */
export async function runBaselineReplayCase(
  runtime: RuntimeServices,
): Promise<BaselineReplayResult> {
  const recorder: EventRecorder = createEventRecorder(runtime);
  const barriers = createBarrierRegistry(recorder);
  const engine = createFaultEngine(BASELINE_FAULT_PLAN, runtime);
  const store = engine.wrapStorage(createBaselineStore());

  const checkpoint = barriers.barrier('checkpoint');
  const arrival = checkpoint.arrive();
  await checkpoint.reached();
  checkpoint.release('checkpoint-released');
  await arrival;

  let firstGetError: string | undefined;
  try {
    // The plan's ONE entry fires on this, the first `storage:get` call
    // (`before-work`: the underlying `get` never actually runs).
    await store.get('missing-key');
  } catch (error) {
    firstGetError = error instanceof Error ? error.message : String(error);
  }
  await store.set('key', 'value');
  // A second `storage:get` call — past the plan's `{ kind: 'nth', n: 1 }`
  // occurrence, so this one reaches the real underlying store and actually
  // returns the value just set, exercising `createBaselineStore`'s `get`
  // for real rather than only through the faulted first call.
  const secondGetValue = await store.get('key');
  const keys = await store.query();

  return {
    causalTrace: recorder.normalize(),
    firedFaults: engine.fired(),
    terminalResult: { firstGetError, secondGetValue, keys },
  };
}

/** Fixed, non-evidentiary fields for the baseline fixture — nothing here participates in replay comparison. */
const BASELINE_ARTIFACT_HEADER = {
  sourceRevision: 'baseline-fixture',
  packageVersions: Object.freeze({ '@lostgradient/operative': 'baseline-fixture' }),
  effectiveModel: Object.freeze({ provider: 'baseline-fixture', model: 'baseline-fixture' }),
  scriptedOutcomes: Object.freeze([]) as readonly ScriptedOutcome[],
  cleanupReport: Object.freeze({ status: 'not-required' }),
} as const;

/**
 * Assembles a full {@link ReproductionArtifact} from the baseline replay
 * case run against a fresh `ManualRuntimeServices` constructed from `seeds`.
 * This is what generated the committed fixture (see the pull request body
 * for the exact one-off invocation) and is reused by
 * `artifact-io.test.ts`'s byte-stability assertions — never re-derived by
 * hand in two places.
 */
export async function assembleBaselineArtifact(
  seeds: {
    readonly origin?: string;
    readonly identifierSeed?: string;
    readonly randomSeed?: string;
  } = {},
): Promise<ReproductionArtifact> {
  const runtime = createManualRuntimeServices(seeds);
  const { causalTrace, firedFaults, terminalResult } = await runBaselineReplayCase(runtime);

  return {
    ...BASELINE_ARTIFACT_HEADER,
    clockOrigin: runtime.clockOrigin,
    identifierSeed: runtime.identifierSeed,
    randomSeed: runtime.randomSeed,
    firedFaults,
    causalTrace,
    terminalResult,
  };
}

/**
 * A key-order-independent `JSON.stringify`: object keys are sorted
 * recursively at every level before serializing, so two values that are
 * semantically identical but were built with different property insertion
 * order (e.g. an artifact assembled by another package, or reconstructed
 * from a plain object literal in a test) compare equal here even though
 * plain `JSON.stringify` would not. Array element order is preserved —
 * only object key order is normalized.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (isRecord(value)) {
    const sortedEntries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entryValue]) => [key, sortKeysDeep(entryValue)] as const);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

/**
 * Reconstructs a `ManualRuntimeServices` from `artifact`'s own
 * `clockOrigin`/`identifierSeed`/`randomSeed`, re-runs the baseline replay
 * case against it, and asserts the replayed `firedFaults` and normalized
 * `causalTrace` match the artifact's own — entry for entry, comparing both
 * fields rather than only `causalTrace`, because a corrupted `clockOrigin`
 * changes `firedFaults[].firedAt` (origin-relative) without necessarily
 * changing any `causalTrace` entry. Throws {@link ReproductionArtifactMismatchError}
 * naming the first mismatching entry's index and identity. Uses no random
 * source of its own — every value comes from `artifact`.
 */
export async function replayReproductionArtifact<TCleanupReport>(
  artifact: ReproductionArtifact<TCleanupReport>,
): Promise<void> {
  const runtime = createManualRuntimeServices({
    origin: artifact.clockOrigin,
    identifierSeed: artifact.identifierSeed,
    randomSeed: artifact.randomSeed,
  });
  const replayed = await runBaselineReplayCase(runtime);

  const expectedFaultsLength = artifact.firedFaults.length;
  if (replayed.firedFaults.length !== expectedFaultsLength) {
    throw new ReproductionArtifactMismatchError(
      `firedFaults length mismatch: replayed ${replayed.firedFaults.length}, artifact recorded ${expectedFaultsLength}`,
    );
  }
  for (let index = 0; index < expectedFaultsLength; index++) {
    const replayedFault = replayed.firedFaults[index];
    const artifactFault = artifact.firedFaults[index];
    if (stableStringify(replayedFault) !== stableStringify(artifactFault)) {
      throw new ReproductionArtifactMismatchError(
        `firedFaults[${index}] mismatch: replayed ${stableStringify(replayedFault)}, ` +
          `artifact recorded ${stableStringify(artifactFault)}`,
      );
    }
  }

  const expectedTraceLength = artifact.causalTrace.length;
  if (replayed.causalTrace.length !== expectedTraceLength) {
    throw new ReproductionArtifactMismatchError(
      `causalTrace length mismatch: replayed ${replayed.causalTrace.length} entries, ` +
        `artifact recorded ${expectedTraceLength}`,
    );
  }
  for (let index = 0; index < expectedTraceLength; index++) {
    const replayedEntry = replayed.causalTrace[index];
    const artifactEntry = artifact.causalTrace[index];
    if (stableStringify(replayedEntry) !== stableStringify(artifactEntry)) {
      throw new ReproductionArtifactMismatchError(
        `causalTrace[${index}] (resource "${artifactEntry?.resource}", event "${artifactEntry?.event}") ` +
          `does not match: replayed ${stableStringify(replayedEntry)}, ` +
          `artifact recorded ${stableStringify(artifactEntry)}`,
      );
    }
  }
}
