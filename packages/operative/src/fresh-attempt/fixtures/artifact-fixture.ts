import { Conversation } from 'conversationalist';

import type { ContextSourceRecord, EffectiveContextEpoch } from '../../context-epoch';
import { sealContextEpoch } from '../../context-epoch';
import type {
  FreshAttemptHandoffArtifact,
  FreshAttemptHandoffArtifactDraft,
} from '../handoff-artifact';
import { finalizeFreshAttemptHandoffArtifact } from '../handoff-artifact';
import type { FreshAttemptSourceRecord, FreshAttemptSourceResolver } from '../validate';

/** The instant every fixture artifact claims to have been produced at. */
export const FIXTURE_TIMESTAMP = '2026-09-26T18:00:00.000Z';

/** One minute after {@link FIXTURE_TIMESTAMP}: comfortably inside any retention window. */
export const FIXTURE_NOW = Date.parse(FIXTURE_TIMESTAMP) + 60_000;

/** The actor every fixture source permits to publish. */
export const FIXTURE_ACTOR = 'operator:steve-kinney';

/**
 * A real sealed epoch for the fixture's producing run, built by the same
 * `sealContextEpoch` the run loop uses, so the carry-forward allowlist is
 * checked against source ids the runtime actually records.
 */
export function createFixtureEpoch(
  extraSources: readonly ContextSourceRecord[] = [],
): EffectiveContextEpoch {
  const conversation = new Conversation();
  conversation.appendUserMessage('Fix the flaky revision-realm test.');
  const sealed = sealContextEpoch({
    epochId: 'epoch-fixture-1',
    conversation,
    agentName: 'implementer',
    toolNames: ['read_file', 'run_tests'],
    hookPlanRevision: 3,
    consumer: { runId: 'session-fixture:0', step: 4, attempt: 0 },
  });
  return { ...sealed, sources: [...sealed.sources, ...extraSources] };
}

export function createFixtureSource(
  epoch: EffectiveContextEpoch = createFixtureEpoch(),
): FreshAttemptSourceRecord {
  return { epoch, permittedActors: [FIXTURE_ACTOR] };
}

export function resolverFor(source: FreshAttemptSourceRecord): FreshAttemptSourceResolver {
  return () => source;
}

/** A complete, schema-valid artifact body without its digest. */
export function createFixtureDraft(
  overrides: Partial<FreshAttemptHandoffArtifactDraft> = {},
): FreshAttemptHandoffArtifactDraft {
  return {
    artifactId: 'handoff-fixture',
    revision: 1,
    objective: 'Make revision-realm-execution.test.ts pass under host load.',
    successRevision: 'COR-1333#acceptance-1',
    constraints: ['Never raise a test timeout.', 'Touch only packages/weft.'],
    completedWork: ['Replaced the first waitForSignalWaiters poll with an event wait.'],
    validatedFacts: ['The old file fails 7 of 9 with a 700ms injected boot delay.'],
    evidenceReferences: [
      { kind: 'commit', id: '55a9f8d2', uri: 'git:55a9f8d2' },
      { kind: 'test-run', id: 'validate-2026-09-26', digest: 'a'.repeat(64) },
    ],
    knownFailures: [
      {
        kind: 'tool',
        summary: 'bun test timed out waiting for a Worker realm to boot.',
        occurredAt: '2026-09-26T17:40:00.000Z',
      },
    ],
    unresolvedQuestions: ['Does the child-process sibling need the same change?'],
    nextRequestedAction: 'Convert the remaining polls to observed events.',
    allowedCarryForwardContext: ['agent-instructions', 'toolbox'],
    producer: {
      agentName: 'implementer',
      runId: 'session-fixture:0',
      sessionId: 'session-fixture',
    },
    sourceRunOrAttempt: { sessionId: 'session-fixture', runId: 'session-fixture:0', sequence: 0 },
    timestamp: FIXTURE_TIMESTAMP,
    lineage: { parentConversationId: 'conversation-fixture', sourceRevision: 7 },
    provenance: { producedAt: FIXTURE_TIMESTAMP, producingActor: FIXTURE_ACTOR },
    ...overrides,
  };
}

export function createFixtureArtifact(
  overrides: Partial<FreshAttemptHandoffArtifactDraft> = {},
): Promise<FreshAttemptHandoffArtifact> {
  return finalizeFreshAttemptHandoffArtifact(createFixtureDraft(overrides));
}
