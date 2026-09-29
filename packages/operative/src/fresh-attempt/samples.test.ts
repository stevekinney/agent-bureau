import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { Conversation } from 'conversationalist';

import { sealContextEpoch } from '../context-epoch';
import { SecretBearingFreshAttemptArtifactError } from './errors';
import type { FreshAttemptHandoffArtifact } from './handoff-artifact';
import {
  canonicalizeFreshAttemptValue,
  finalizeFreshAttemptHandoffArtifact,
} from './handoff-artifact';
import { collectStringFields, highestTokenEntropy } from './secret-scan';
import {
  FRESH_ATTEMPT_ARTIFACT_ENTROPY_THRESHOLD,
  FRESH_ATTEMPT_ARTIFACT_MAX_BYTES,
  FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES,
  FRESH_ATTEMPT_ARTIFACT_RETENTION_MS,
} from './thresholds';
import type { FreshAttemptSourceResolver } from './validate';
import { validateFreshAttemptArtifact } from './validate';

const SAMPLES_DIRECTORY = new URL('./fixtures/samples/', import.meta.url);

/**
 * Where each sample's instants come from, so a reviewer can check them
 * against the record: commit times from `git show -s --format='%aI %cI'`
 * (converted to UTC), Linear comment times, and the pull request #5 review.
 *
 * A failure is dated at the earliest instant the record allows: the commit
 * time of the tree it ran on, or the comment that first reports it. The
 * handoff is dated at the author time of the commit that carried out its
 * `nextRequestedAction`, the latest instant it could have been produced. Each
 * measured failure-to-handoff span is therefore the widest the record allows.
 */
const RECORDED_INSTANTS: Record<
  string,
  {
    readonly failures: readonly (readonly [instant: string, source: string])[];
    readonly handoff: readonly [instant: string, source: string];
  }
> = {
  'cor-198-lint-gates.json': {
    failures: [['2026-09-26T15:14:48.000Z', '6dd6062c, the last commit adding a violation']],
    handoff: ['2026-09-26T15:57:59.000Z', 'e6f88cd4'],
  },
  'cor-219-malformed-ledger-record.json': {
    failures: [['2026-09-25T19:19:37.903Z', 'COR-219 claim comment reporting the overwrite']],
    handoff: ['2026-09-26T17:21:50.000Z', '6ae95602'],
  },
  'cor-243-realm-diagnostics-coverage.json': {
    failures: [['2026-09-26T15:10:04.000Z', '2f370574, which added the operation']],
    handoff: ['2026-09-26T15:42:31.000Z', '72a51a74'],
  },
  'cor-1327-revision-realm-worker-events.json': {
    failures: [['2026-09-26T15:14:24.000Z', 'c32f390b, the combined tree COR-1327 names']],
    handoff: ['2026-09-26T15:55:39.000Z', '0910f949'],
  },
  'cor-1329-coverage-diagnosis-piped-stderr.json': {
    failures: [
      ['2026-09-26T15:14:24.000Z', 'c32f390b, the first tree COR-1329 names'],
      ['2026-09-26T15:55:39.000Z', '0910f949, the second tree COR-1329 names'],
    ],
    handoff: ['2026-09-26T16:48:18.000Z', 'd4de7331'],
  },
  'cor-1331-digest-guard-stale-edges.json': {
    failures: [['2026-09-26T16:59:00.000Z', 'b8d0e857, the tree COR-1331 names']],
    handoff: ['2026-09-26T17:17:08.000Z', 'e7f57ab4'],
  },
  'cor-1332-event-history-stop-when.json': {
    failures: [['2026-09-26T16:40:49.000Z', 'f9154d11, the candidate COR-1332 names']],
    handoff: ['2026-09-26T18:04:04.000Z', 'b647bdfb'],
  },
  'cor-1333-revision-realm-signal-parks.json': {
    failures: [['2026-09-26T17:55:08.841Z', 'COR-1333 claim comment scheduling the control']],
    handoff: ['2026-09-26T18:06:43.000Z', '55a9f8d2'],
  },
  'cor-1334-cinder-hang-guards.json': {
    failures: [
      ['2026-09-26T17:17:08.000Z', 'e7f57ab4, the tree COR-1334 names'],
      ['2026-09-26T17:17:08.000Z', 'e7f57ab4, the same validate run'],
    ],
    handoff: ['2026-09-26T18:27:30.000Z', '3c77df4c'],
  },
  'cor-1346-weft-watch-restart-typing.json': {
    failures: [
      ['2026-09-28T15:53:15.000Z', '41257994, the source of the failing mirror sync'],
      ['2026-09-28T16:28:12.000Z', 'pull request #5 review comment'],
    ],
    handoff: ['2026-09-28T16:31:51.000Z', '8096e237'],
  },
};

/** The principals that published the corpus. */
const CORPUS_PRINCIPALS = ['workflow:linear-implementation', 'operator:steve-kinney'];

const samples: [string, FreshAttemptHandoffArtifact][] = readdirSync(SAMPLES_DIRECTORY)
  .filter((file) => file.endsWith('.json'))
  .toSorted()
  .map((file) => [
    file,
    JSON.parse(
      readFileSync(new URL(file, SAMPLES_DIRECTORY), 'utf8'),
    ) as FreshAttemptHandoffArtifact,
  ]);

/** The producing run's epoch, sealed the way the run loop seals one for that agent. */
const resolveCorpusSource: FreshAttemptSourceResolver = (source) => {
  const conversation = new Conversation();
  conversation.appendUserMessage(`Resume ${source.runId}.`);
  return {
    epoch: sealContextEpoch({
      epochId: `epoch:${source.runId}`,
      conversation,
      agentName: 'implementer',
      toolNames: ['read_file', 'edit_file', 'run_command'],
      hookPlanRevision: 1,
      consumer: { runId: source.runId, step: 0, attempt: 0 },
    }),
    permittedActors: CORPUS_PRINCIPALS,
  };
};

function consumedOneMinuteAfter(artifact: FreshAttemptHandoffArtifact) {
  return { resolveSource: resolveCorpusSource, now: Date.parse(artifact.timestamp) + 60_000 };
}

describe('fresh-attempt sample corpus', () => {
  it('holds at least ten samples', () => {
    expect(samples.length).toBeGreaterThanOrEqual(10);
  });

  it.each(samples)('%s dates its failures and handoff at recorded instants', (file, artifact) => {
    const recorded = RECORDED_INSTANTS[file];
    if (recorded === undefined) throw new Error(`${file} has no recorded instants.`);

    expect(artifact.knownFailures.map((failure) => failure.occurredAt)).toEqual(
      recorded.failures.map(([instant]) => instant),
    );
    expect(artifact.timestamp).toBe(recorded.handoff[0]);
    expect(artifact.provenance.producedAt).toBe(artifact.timestamp);
    for (const failure of artifact.knownFailures) {
      expect(Date.parse(failure.occurredAt)).toBeLessThanOrEqual(Date.parse(artifact.timestamp));
    }
  });

  it.each(samples)('%s validates', async (_file, artifact) => {
    const validated = await validateFreshAttemptArtifact(
      artifact,
      consumedOneMinuteAfter(artifact),
    );

    expect(validated.artifact).toEqual(artifact);
  });

  it('keeps every threshold outside the corpus by its documented margin', () => {
    const artifacts = samples.map(([, artifact]) => artifact);
    const largestBytes = Math.max(
      ...artifacts.map(
        (artifact) => new TextEncoder().encode(canonicalizeFreshAttemptValue(artifact)).byteLength,
      ),
    );
    const highestEntropy = Math.max(
      ...artifacts.flatMap((artifact) =>
        collectStringFields(artifact).map((field) => highestTokenEntropy(field.value)),
      ),
    );
    const longestSpan = Math.max(
      ...artifacts.map(
        (artifact) =>
          Date.parse(artifact.timestamp) -
          Math.min(...artifact.knownFailures.map((failure) => Date.parse(failure.occurredAt))),
      ),
    );
    const longestAllowlist = Math.max(
      ...artifacts.map((artifact) => artifact.allowedCarryForwardContext.length),
    );

    expect(FRESH_ATTEMPT_ARTIFACT_MAX_BYTES).toBeGreaterThanOrEqual(3.5 * largestBytes);
    expect(FRESH_ATTEMPT_ARTIFACT_RETENTION_MS).toBeGreaterThanOrEqual(3 * longestSpan);
    expect(FRESH_ATTEMPT_ARTIFACT_ENTROPY_THRESHOLD - highestEntropy).toBeGreaterThanOrEqual(0.25);
    expect(longestAllowlist).toBeLessThanOrEqual(FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES);
  });

  it('rejects a sample seeded with a high-entropy token as secret-bearing', async () => {
    const seededToken = 'Vq7ZkT2mX9pR4wLc8NbY3sHfJ6dG1aQeU5oIr0yK';
    const [, sample] = samples[0] ?? [];
    if (sample === undefined) throw new Error('The corpus is empty.');
    const { schemaVersion: _schemaVersion, digest: _digest, ...draft } = sample;
    const seeded = await finalizeFreshAttemptHandoffArtifact({
      ...draft,
      validatedFacts: [...draft.validatedFacts, `The staging deploy accepted ${seededToken}.`],
    });

    const outcome = await validateFreshAttemptArtifact(seeded, consumedOneMinuteAfter(seeded)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(SecretBearingFreshAttemptArtifactError);
    const error = outcome as SecretBearingFreshAttemptArtifactError;
    expect(error.diagnostics).toEqual([
      { path: `validatedFacts[${draft.validatedFacts.length}]`, rule: 'high-entropy-token' },
    ]);
    expect(error.message).not.toContain(seededToken);
  });
});
