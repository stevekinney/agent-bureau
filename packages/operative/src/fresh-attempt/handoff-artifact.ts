import { sha256Hex } from '@lostgradient/cryptography';
import { z } from 'zod';

import { AGENT_RUN_ERROR_KINDS, type AgentRunErrorKind } from '../errors';

/**
 * COR-1354 (COR-894's decision) — the typed handoff a fresh attempt starts
 * from instead of the failed attempt's transcript.
 *
 * Every field is a plain string, number, array, or object of the same. No
 * field can hold a `Message`, a `ConversationHistory`, or a raw tool payload:
 * the schema is strict at every level, so redaction is structural rather
 * than a runtime filter a producer could route around. Secret scanning
 * (`validate.ts`) is a second line of defense behind this.
 *
 * `schemaVersion` is its own counter. It does not share a version space with
 * `ConversationHistory.schemaVersion`, because the artifact is not a
 * conversation and has to evolve independently of one.
 */
export const FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION = 1 as const;

/** The only digest algorithm an artifact may carry (COR-894 owner ruling). */
export const FRESH_ATTEMPT_ARTIFACT_DIGEST_ALGORITHM = 'sha-256' as const;

/** A reference to evidence held elsewhere. Evidence content is never embedded. */
export interface EvidenceReference {
  readonly kind: string;
  readonly id: string;
  readonly digest?: string | undefined;
  readonly uri?: string | undefined;
}

/** One failure the source attempt hit, in COR-843's terminal-result vocabulary. */
export interface FailureRecord {
  readonly kind: AgentRunErrorKind;
  readonly summary: string;
  readonly occurredAt: string;
}

/** The agent and run that produced the artifact. */
export interface FreshAttemptProducer {
  readonly agentName: string;
  readonly runId: string;
  readonly sessionId: string;
}

/** The run or attempt the artifact hands off from. */
export interface FreshAttemptSourceRunOrAttempt {
  readonly sessionId: string;
  readonly runId: string;
  readonly sequence: number;
}

/**
 * Mirrors `ConversationSnapshot.lineage`, minus the conversation-tree fields
 * a fresh artifact has no analogue for.
 */
export interface FreshAttemptLineage {
  readonly parentConversationId?: string | undefined;
  readonly sourceRevision: number;
}

/**
 * Who authorized the write. Deliberately separate from `producer`: collapsing
 * the actor into the agent/run identity would make `unauthorized` undetectable.
 */
export interface FreshAttemptProvenance {
  readonly producedAt: string;
  readonly producingActor: string;
}

export interface FreshAttemptArtifactDigest {
  readonly algorithm: typeof FRESH_ATTEMPT_ARTIFACT_DIGEST_ALGORITHM;
  /** Lowercase hex sha-256 over the canonical serialization without `digest`. */
  readonly value: string;
}

export interface FreshAttemptHandoffArtifact {
  readonly schemaVersion: typeof FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION;
  readonly artifactId: string;
  /** Starts at 1 and increments on every republish of the same `artifactId`. */
  readonly revision: number;
  readonly objective: string;
  /** The objective's success-criteria revision: a reference, not criteria text. */
  readonly successRevision: string;
  readonly constraints: readonly string[];
  readonly completedWork: readonly string[];
  readonly validatedFacts: readonly string[];
  readonly evidenceReferences: readonly EvidenceReference[];
  readonly knownFailures: readonly FailureRecord[];
  readonly unresolvedQuestions: readonly string[];
  readonly nextRequestedAction: string;
  /**
   * Source ids from the producing run's own sealed context epoch that the
   * fresh attempt may carry forward. Never transcript content.
   */
  readonly allowedCarryForwardContext: readonly string[];
  readonly producer: FreshAttemptProducer;
  readonly sourceRunOrAttempt: FreshAttemptSourceRunOrAttempt;
  /** ISO-8601. Retention is measured from here. */
  readonly timestamp: string;
  readonly lineage: FreshAttemptLineage;
  readonly provenance: FreshAttemptProvenance;
  readonly digest: FreshAttemptArtifactDigest;
}

/** An artifact body before `finalizeFreshAttemptHandoffArtifact` stamps its version and digest. */
export type FreshAttemptHandoffArtifactDraft = Omit<
  FreshAttemptHandoffArtifact,
  'schemaVersion' | 'digest'
>;

const text = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

export const freshAttemptHandoffArtifactSchema = z.strictObject({
  schemaVersion: z.literal(FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION),
  artifactId: text,
  revision: z.number().int().positive(),
  objective: text,
  successRevision: text,
  constraints: z.array(text),
  completedWork: z.array(text),
  validatedFacts: z.array(text),
  evidenceReferences: z.array(
    z.strictObject({
      kind: text,
      id: text,
      digest: text.optional(),
      uri: text.optional(),
    }),
  ),
  knownFailures: z.array(
    z.strictObject({
      kind: z.enum(AGENT_RUN_ERROR_KINDS),
      summary: text,
      occurredAt: timestamp,
    }),
  ),
  unresolvedQuestions: z.array(text),
  nextRequestedAction: text,
  allowedCarryForwardContext: z.array(text),
  producer: z.strictObject({ agentName: text, runId: text, sessionId: text }),
  sourceRunOrAttempt: z.strictObject({ sessionId: text, runId: text, sequence: count }),
  timestamp,
  lineage: z.strictObject({ parentConversationId: text.optional(), sourceRevision: count }),
  provenance: z.strictObject({ producedAt: timestamp, producingActor: text }),
  digest: z.strictObject({
    algorithm: z.literal(FRESH_ATTEMPT_ARTIFACT_DIGEST_ALGORITHM),
    value: z.string().regex(/^[0-9a-f]{64}$/),
  }),
}) satisfies z.ZodType<FreshAttemptHandoffArtifact>;

/**
 * The canonical serialization the digest and the byte ceiling are measured
 * over: JSON with object keys sorted and `undefined` members dropped, so two
 * producers that build the same artifact in a different key order agree.
 */
export function canonicalizeFreshAttemptValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeFreshAttemptValue(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const members = Object.keys(value)
      .toSorted()
      .flatMap((key) => {
        const member: unknown = (value as Record<string, unknown>)[key];
        return member === undefined
          ? []
          : [`${JSON.stringify(key)}:${canonicalizeFreshAttemptValue(member)}`];
      });
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Recomputes an artifact's sha-256 digest over everything except `digest` itself. */
export function computeFreshAttemptArtifactDigest(
  artifact: Omit<FreshAttemptHandoffArtifact, 'digest'>,
): Promise<string> {
  const { digest: _digest, ...body } = artifact as FreshAttemptHandoffArtifact;
  return sha256Hex(canonicalizeFreshAttemptValue(body));
}

/** Stamps the current schema version and a sha-256 digest onto a draft. */
export async function finalizeFreshAttemptHandoffArtifact(
  draft: FreshAttemptHandoffArtifactDraft,
): Promise<FreshAttemptHandoffArtifact> {
  const body = { ...draft, schemaVersion: FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION };
  return {
    ...body,
    digest: {
      algorithm: FRESH_ATTEMPT_ARTIFACT_DIGEST_ALGORITHM,
      value: await computeFreshAttemptArtifactDigest(body),
    },
  };
}
