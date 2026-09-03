/**
 * The Bureau reproduction-artifact assembler (AB-263 / AB-94's tst-03d
 * child).
 *
 * `assembleReproductionArtifact` builds the normalized `ReproductionArtifact`
 * AB-92's Decision (2026-09-01) fixes (AC8) from one already-completed
 * harness run: a real Bureau composed over deterministic
 * `ManualRuntimeServices` (AB-261's `BureauTestHarness`), an `EventRecorder`
 * (AB-255) already attached to whatever the run's own resources are, and the
 * caller's own terminal result and cleanup report. This slice only
 * ASSEMBLES the shape — no fault engine exists yet to populate
 * `scriptedOutcomes`/`firedFaults` (AB-95/tst-04a), so both are always
 * empty here; the artifact WRITER and replay command that consume this
 * shape are tst-04c's, not this file's.
 *
 * Byte stability (AB-263's own acceptance criteria) rests on two things:
 * the returned object's keys are always written in AB-92's field order
 * (JSON.stringify follows insertion order for string keys), and every
 * field that varies only with WHEN the process happened to run — the git
 * revision, the installed package manifests — is read from something that
 * cannot differ between two runs of the same scripted case against the
 * same repository checkout.
 */
import { dirname, join } from 'node:path';

import type { CleanupAcknowledgement } from '@lostgradient/operative';
import { summarizeToolInput } from '@lostgradient/operative';
import type { CausalTraceEntry, EventRecorder, FiredFault } from '@lostgradient/operative/test';
import type { DeferredDrainReport } from 'lifecycle';

import type { AgentDefinitions } from '../agent-catalog';
import type { BureauShutdownReport } from '../types';
import type { BureauTestHarness } from './harness';

/**
 * One scripted double's recorded outcome (AB-92 AC8), matched field for
 * field. Always an empty list on this slice's own artifacts — nothing
 * populates it until AB-95's fault engine exists — but the shape is fixed
 * here because `ReproductionArtifact.scriptedOutcomes` needs it and this is
 * the file that owns the artifact shape.
 */
export interface ScriptedOutcome {
  readonly boundary: string;
  readonly sequenceNumber: number;
  readonly outcome: unknown;
}

/**
 * AB-92 AC8's `ReproductionArtifact`, matched field for field. Field order
 * here IS the serialization contract: `assembleReproductionArtifact` always
 * constructs the returned object with these keys in this order, which is
 * what makes `JSON.stringify` byte-identical across two runs of the same
 * scripted case.
 */
export interface ReproductionArtifact {
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
  /** Redacted per the projection already in force for the run — see `summarizeToolInput` below. */
  readonly terminalResult: unknown;
  readonly cleanupReport: CleanupAcknowledgement | DeferredDrainReport | BureauShutdownReport;
}

/**
 * Options for {@link assembleReproductionArtifact}. Both fields are
 * intentionally `unknown` at this boundary: the caller has already produced
 * a concrete `CleanupAcknowledgement`/`DeferredDrainReport`/
 * `BureauShutdownReport` (for `cleanupReport`) and a concrete, possibly
 * unredacted run result (for `terminalResult`) from whichever driver it
 * used; this assembler's job is to redact and slot them into the artifact,
 * not to re-derive or validate their shape.
 */
export interface AssembleReproductionArtifactOptions {
  readonly terminalResult: unknown;
  readonly cleanupReport: unknown;
}

const EMPTY_SCRIPTED_OUTCOMES: readonly ScriptedOutcome[] = Object.freeze([]);
const EMPTY_FIRED_FAULTS: readonly FiredFault[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Repository-relative reads (source revision, package manifests). Each is
// read at most once per process — the git HEAD and every workspace
// package's manifest are immutable for the lifetime of a test run, so
// re-reading them on every `assembleReproductionArtifact` call would only
// add I/O, never change the answer.
// ---------------------------------------------------------------------------

/**
 * Walks up from `startDirectory` looking for `turbo.json` — the workspace
 * root marker every package in this monorepo shares exactly one of.
 * Exported (rather than kept module-private) so a test can exercise the
 * not-found path directly with an isolated starting directory (e.g. the OS
 * temp directory), instead of that path staying permanently unreachable
 * from inside this repository's own checkout.
 */
export async function locateWorkspaceRoot(
  startDirectory: string = import.meta.dir,
): Promise<string> {
  let directory = startDirectory;
  for (;;) {
    if (await Bun.file(join(directory, 'turbo.json')).exists()) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        `assembleReproductionArtifact: could not locate the workspace root (no turbo.json found while walking up from ${startDirectory})`,
      );
    }
    directory = parent;
  }
}

let repoRootPromise: Promise<string> | undefined;

function repoRoot(): Promise<string> {
  repoRootPromise ??= locateWorkspaceRoot();
  return repoRootPromise;
}

let sourceRevisionPromise: Promise<string> | undefined;

/** The git commit the suite ran against — `git rev-parse HEAD`, read once. */
async function readSourceRevision(): Promise<string> {
  sourceRevisionPromise ??= (async () => {
    const root = await repoRoot();
    const output = await Bun.$`git rev-parse HEAD`.cwd(root).quiet().text();
    return output.trim();
  })();
  return sourceRevisionPromise;
}

let packageVersionsPromise: Promise<Readonly<Record<string, string>>> | undefined;

/** Every workspace package's resolved version, keyed by its `package.json` `name`, read from the installed manifests — never hard-coded. Sorted by name so key order (and therefore `JSON.stringify` output) never depends on filesystem enumeration order. */
async function readPackageVersions(): Promise<Readonly<Record<string, string>>> {
  packageVersionsPromise ??= (async () => {
    const root = await repoRoot();
    const glob = new Bun.Glob('packages/*/package.json');
    const entries: [string, string][] = [];
    for await (const relativePath of glob.scan({ cwd: root })) {
      const manifest = (await Bun.file(join(root, relativePath)).json()) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        entries.push([manifest.name, manifest.version]);
      }
    }
    entries.sort(([nameA], [nameB]) => (nameA < nameB ? -1 : nameA > nameB ? 1 : 0));
    return Object.freeze(Object.fromEntries(entries));
  })();
  return packageVersionsPromise;
}

/**
 * Reads the harness's Bureau-level `effectiveModel` off `getConfiguration()`
 * — the same redacted (`apiKey`-stripped) provider configuration the
 * gateway's own `/api/v1/config` endpoint serves. `effort` is left
 * unpopulated: Bureau's `ProviderConfiguration` carries no effort field on
 * this baseline (AB-155, related but not blocking, is the fix for
 * `effectiveModel.effort` records). Throws rather than inventing a provider
 * or model name (matching `generation-profile.ts`'s "never invented"
 * rollback trigger) when the harness was constructed without a `provider`
 * — a scripted `generate` double still needs `BureauOptions.provider` set
 * alongside it for a caller that wants a reproduction artifact.
 */
function resolveEffectiveModel<D extends AgentDefinitions>(
  harness: BureauTestHarness<D>,
): ReproductionArtifact['effectiveModel'] {
  const provider = harness.bureau.getConfiguration().provider;
  if (!provider) {
    throw new Error(
      'assembleReproductionArtifact: harness bureau has no configured `provider`; ' +
        'ReproductionArtifact.effectiveModel (AB-92 AC8) requires BureauOptions.provider — ' +
        'pass one alongside a scripted `generate` double when a reproduction artifact is needed.',
    );
  }
  return { provider: provider.provider, model: provider.model };
}

/**
 * Assembles a {@link ReproductionArtifact} from a harness run: `harness`
 * supplies the source revision's runtime context (seeds, effective model),
 * `recorder` supplies `causalTrace` via `EventRecorder.normalize()` and
 * nothing else (AB-263's own acceptance criteria), and `options` supplies
 * the run's own terminal result and cleanup report.
 *
 * `terminalResult` is passed through `summarizeToolInput` — the same
 * redaction projection already in force for `tool-pre`/`tool-post` frames
 * elsewhere in this codebase (`@lostgradient/operative`'s
 * `run-envelope.ts`) — before being embedded, so a privileged value (a key
 * matching its sensitive-key pattern: `password`, `secret`, `token`,
 * `apiKey`, `authorization`, `credential`, `privateKey`) never appears in
 * the serialized artifact. `cleanupReport` is forwarded verbatim: it is
 * already one of `CleanupAcknowledgement`/`DeferredDrainReport`/
 * `BureauShutdownReport` by construction at the caller (this assembler's
 * fixed `options: { terminalResult: unknown; cleanupReport: unknown }`
 * signature — AB-263's own acceptance criteria — leaves no room for a
 * narrower parameter type here), so the cast below only restates that
 * caller-side guarantee at the type level.
 */
export async function assembleReproductionArtifact<D extends AgentDefinitions = AgentDefinitions>(
  harness: BureauTestHarness<D>,
  recorder: EventRecorder,
  options: AssembleReproductionArtifactOptions,
): Promise<ReproductionArtifact> {
  const [sourceRevision, packageVersions] = await Promise.all([
    readSourceRevision(),
    readPackageVersions(),
  ]);

  return Object.freeze({
    sourceRevision,
    packageVersions,
    effectiveModel: resolveEffectiveModel(harness),
    clockOrigin: harness.runtime.clockOrigin,
    identifierSeed: harness.runtime.identifierSeed,
    randomSeed: harness.runtime.randomSeed,
    scriptedOutcomes: EMPTY_SCRIPTED_OUTCOMES,
    firedFaults: EMPTY_FIRED_FAULTS,
    causalTrace: recorder.normalize(),
    terminalResult: summarizeToolInput(options.terminalResult),
    cleanupReport: options.cleanupReport as ReproductionArtifact['cleanupReport'],
  });
}
