import type { ContextSourceRecord } from '../context-epoch';
import type { EvidenceReference, FailureRecord } from './handoff-artifact';
import type { ValidatedFreshAttemptArtifact } from './validate';

function list(label: string, items: readonly string[]): string[] {
  return items.length === 0
    ? [`${label}: (none)`]
    : [`${label}:`, ...items.map((item) => `- ${item}`)];
}

function renderEvidence(reference: EvidenceReference): string {
  return [
    `${reference.kind} ${reference.id}`,
    ...(reference.digest === undefined ? [] : [`digest ${reference.digest}`]),
    ...(reference.uri === undefined ? [] : [`uri ${reference.uri}`]),
  ].join(', ');
}

function renderFailure(failure: FailureRecord): string {
  return `[${failure.kind}] ${failure.occurredAt} ${failure.summary}`;
}

/**
 * An allowlisted source as its epoch recorded it: identity, trust, and
 * integrity evidence. An epoch never holds a source's content, so nothing
 * from the source transcript can reach the seed through this path.
 */
function renderCarryForward(record: ContextSourceRecord): string {
  const facts = [
    `trust ${record.trust}`,
    `redaction ${record.redaction}`,
    ...(record.revision === undefined ? [] : [`revision ${String(record.revision)}`]),
    ...(record.digest === undefined ? [] : [`digest ${record.digest}`]),
  ];
  return `${record.sourceId} (${facts.join(', ')})`;
}

/**
 * COR-1354 — the single rendering of a validated artifact that seeds a fresh
 * attempt. Every field appears under its own name so the new conversation,
 * and anyone auditing it, can see exactly what crossed the boundary.
 */
export function renderFreshAttemptHandoff({
  artifact,
  carryForward,
}: Pick<ValidatedFreshAttemptArtifact, 'artifact' | 'carryForward'>): string {
  const { producer, sourceRunOrAttempt: source, lineage, provenance } = artifact;
  return [
    'Fresh-attempt handoff. This conversation starts clean: the previous attempt’s transcript is not included. Continue from the validated state below.',
    `artifactId: ${artifact.artifactId}`,
    `revision: ${artifact.revision}`,
    `schemaVersion: ${artifact.schemaVersion}`,
    `digest: ${artifact.digest.algorithm} ${artifact.digest.value}`,
    `objective: ${artifact.objective}`,
    `successRevision: ${artifact.successRevision}`,
    ...list('constraints', artifact.constraints),
    ...list('completedWork', artifact.completedWork),
    ...list('validatedFacts', artifact.validatedFacts),
    ...list('evidenceReferences', artifact.evidenceReferences.map(renderEvidence)),
    ...list('knownFailures', artifact.knownFailures.map(renderFailure)),
    ...list('unresolvedQuestions', artifact.unresolvedQuestions),
    `nextRequestedAction: ${artifact.nextRequestedAction}`,
    ...list('allowedCarryForwardContext', carryForward.map(renderCarryForward)),
    `producer: agent ${producer.agentName}, run ${producer.runId}, session ${producer.sessionId}`,
    `sourceRunOrAttempt: session ${source.sessionId}, run ${source.runId}, sequence ${source.sequence}`,
    `timestamp: ${artifact.timestamp}`,
    `lineage: sourceRevision ${lineage.sourceRevision}${
      lineage.parentConversationId === undefined
        ? ''
        : `, parentConversationId ${lineage.parentConversationId}`
    }`,
    `provenance: producingActor ${provenance.producingActor}, producedAt ${provenance.producedAt}`,
  ].join('\n');
}
