import type { Conversation } from 'conversationalist';

import type { SteeringDesiredState } from './durable/types';
import type { SelectionPlan } from './providers/selection';

/**
 * COR-581 — the effective-context epoch.
 *
 * An epoch answers one question after the fact: which identified,
 * versioned sources produced this provider turn? It records what each
 * source *was* — an identity, a revision, a digest — never what it said.
 * Protected content stays at its source; the epoch carries integrity
 * evidence about it.
 *
 * ## Where it seals
 *
 * Immediately before `generate.started`, once per generate attempt.
 *
 * The obvious-looking alternative — sealing at `prepareStep`'s return, the
 * boundary AB-67 fixed for steering — is wrong, and wrong in a way that
 * would not show up in a test that only checked the epoch existed.
 * `deps.prepareStepHooks` and the hook registry's own `prepareStep` phase
 * run *later*, inside `executeGeneration`, and `createIdentityHook`,
 * `createMemoryBridge`, and the input guardrail are all `PrepareStepHook`.
 * An epoch sealed at `prepareStep`'s return would omit the agent's own
 * identity prompt, every retrieved memory, and every guardrail
 * sanitization, and then present itself as a complete account of the turn.
 *
 * Sealing per *attempt* rather than per step follows from the same place:
 * `executeGeneration`'s retry loop can re-run the hook waterfall, so a
 * guardrail that sanitizes the user message between attempt one and
 * attempt two genuinely changed what the model sees, and the second
 * attempt's epoch says so.
 *
 * ## What "attempt" does and does not count
 *
 * `firstConsumedBy.attempt` is `run-step-generation.ts`'s `stepRetryCount`:
 * it counts error-recovery iterations, an `onError` hook returning
 * `'retry'` and re-entering the `do…while (shouldRetryStep)` loop. Two
 * neighbouring things are deliberately not counted, and a reader
 * reconstructing a turn needs to know which:
 *
 * - A **schema retry** is not an attempt. `run-step-finalization.ts`
 *   appends its correction message and lets the step complete; the
 *   re-generation happens in the next `runStep` call, so it seals a new
 *   epoch as a new *step*.
 * - A **provider-level retry inside `callGenerateWithRetry`** is not an
 *   attempt either, and this is a genuine gap rather than a definition.
 *   That loop can issue several real `generate()` calls under one seal,
 *   and a configured `retry.mutate` can change the request between them.
 *   Those mutations are invisible to the epoch: the seal happens once,
 *   before the call. Closing it means either sealing inside that loop or
 *   recording the mutation as its own source; neither is done here, and
 *   an epoch should not be read as covering provider-retry mutations.
 *
 * An attempt that never reaches a provider call seals nothing. A
 * `prepareStep` hook may short-circuit by returning a response outright —
 * which is how the input guardrail's `block` action works — and on that
 * path no `generate.started` fires, so `firstConsumedBy` can never name a
 * provider turn that did not happen.
 */

/** How much of a source may be resolved back to its content. */
export type ContextSourceRedaction =
  /** Fully resolvable under authorization. */
  | 'none'
  /** Only the digest leaves the source. */
  | 'digest-only'
  /** Identity and digest only; content is never carried, even privileged. */
  | 'reference-only'
  /** Never enters an epoch in any form. */
  | 'forbidden';

/**
 * What a consumer may assume about a source's content. The distinction
 * that matters most is `untrusted-retrieved`: content that arrived from
 * outside the trust boundary, where instructions are data.
 */
export type ContextSourceTrust =
  | 'trusted-operator'
  | 'trusted-agent'
  | 'untrusted-retrieved'
  | 'protected-secret'
  /** The conversation: provenance varies per message, not per source. */
  | 'per-message';

/** Whether a missing source fails the turn or degrades it visibly. */
export type ContextSourceAvailability = 'required' | 'degraded-ok' | 'optional';

/** One source's disposition in a sealed epoch. */
export type ContextSourceDisposition =
  | { readonly kind: 'included' }
  | { readonly kind: 'excluded'; readonly reason: string }
  /**
   * The run never configured this source. Distinct from `excluded`, and
   * the distinction is load-bearing: without it, `required` would fail
   * every step of every agent that has no Bureau, no policy configuration
   * and no catalog — which is every plain `createAgent` agent.
   */
  | { readonly kind: 'absent-by-composition' };

/** One source as the epoch recorded it. */
export interface ContextSourceRecord {
  readonly sourceId: string;
  readonly trust: ContextSourceTrust;
  readonly precedence: number;
  readonly availability: ContextSourceAvailability;
  readonly redaction: ContextSourceRedaction;
  readonly disposition: ContextSourceDisposition;
  /** The source's own version, when it has one. */
  readonly revision?: number | string | undefined;
  /** Content digest, when the source's redaction policy permits one. */
  readonly digest?: string | undefined;
}

/** The provider turn that first consumed an epoch. */
export interface ContextEpochConsumer {
  readonly runId?: string | undefined;
  readonly step: number;
  /** Generate attempt within the step, zero-based. */
  readonly attempt: number;
}

/**
 * An immutable effective-context epoch. Never edited: a source change
 * produces a successor with its own `epochId` and a `supersedes` link, so
 * the history is a chain a postmortem can walk backwards.
 */
export interface EffectiveContextEpoch {
  readonly epochId: string;
  /** The epoch this one replaced, when it replaced one. */
  readonly supersedes?: string | undefined;
  readonly sources: readonly ContextSourceRecord[];
  /** Digest of the rendered provider baseline these sources produced. */
  readonly baselineDigest: string;
  readonly agentName?: string | undefined;
  readonly selectionPlanId?: string | undefined;
  readonly policyRevision?: number | undefined;
  readonly configVersion?: number | undefined;
  /**
   * Write-once. "First" because the contract permits reuse when every
   * bound source digest is unchanged — which happens for a retry attempt
   * where nothing mutated, and essentially never across step indices,
   * since `conversation` is a bound source and the prior assistant turn is
   * appended before the next step.
   */
  readonly firstConsumedBy: ContextEpochConsumer;
}

/**
 * A 64-bit FNV-1a digest, rendered as 16 lowercase hex characters.
 *
 * Deliberately not a cryptographic hash. An epoch digest answers "did this
 * source change between two boundaries", a same-process comparison against
 * a value this process computed moments earlier. It is not a signature,
 * nothing authenticates against it, and treating it as tamper-evidence
 * would be a misuse. A cryptographic hash would cost real time on every
 * one of these at every generate attempt and buy nothing the comparison
 * needs.
 */
export function digestText(text: string): string {
  // Two 32-bit halves, because JavaScript bitwise operators are 32-bit and
  // BigInt arithmetic here would be materially slower on a hot path.
  let high = 0x811c9dc5;
  let low = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low ^= code & 0xff;
    low = Math.imul(low, 0x01000193) >>> 0;
    high ^= (code >>> 8) & 0xff;
    high = Math.imul(high, 0x01000193) >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

/** Inputs the sealer reads. Every one is already resolved by this point. */
export interface SealContextEpochInput {
  readonly epochId: string;
  readonly previousEpochId?: string | undefined;
  readonly conversation: Conversation;
  readonly steering?: SteeringDesiredState | undefined;
  readonly plan?: SelectionPlan | undefined;
  readonly agentName?: string | undefined;
  /** `HookRegistry.revision`, when a registry is composed. */
  readonly hookPlanRevision?: number | undefined;
  /** Tool names in the step's resolved toolbox. */
  readonly toolNames?: readonly string[] | undefined;
  /** Digest of the structured-output schema, when one is configured. */
  readonly responseFormatDigest?: string | undefined;
  /**
   * Skills whose instructions this attempt actually admitted into context.
   *
   * Absent when the run has no skill client or activated nothing — which is why it is
   * `absent-by-composition` rather than `excluded`: an agent with no skills has not had a source
   * withheld from it (COR-752, Decision 5).
   */
  readonly skillActivation?: SkillActivationContext | undefined;
  readonly consumer: ContextEpochConsumer;
}

/**
 * What the epoch binds about active skills.
 *
 * Deliberately digests rather than content. Skill instructions are untrusted third-party text, and
 * an epoch is provenance evidence that gets logged and correlated — carrying the instructions here
 * would turn every recorded epoch into a copy of whatever a skill author wrote.
 */
export interface SkillActivationContext {
  /**
   * The skill catalog revision this run snapshotted.
   *
   * Its own field, and never conflated with `SelectionPlan.catalogRevision`, which counts *model*
   * catalog generations. Two different counters under one name would make either one unreadable.
   */
  readonly catalogRevision: number;
  /** One entry per active skill, in activation order. */
  readonly activations: readonly SkillActivationBinding[];
}

/** One active skill's identity, as the epoch records it. */
export interface SkillActivationBinding {
  readonly name: string;
  readonly sourceId: string;
  readonly trust: string;
  readonly artifactDigest: string;
  readonly instructionsDigest: string;
}

/**
 * Per-message trust for the conversation source.
 *
 * `role` plus `toolResult` presence recovers most of the distinction a
 * transcript needs: a tool result arrived from outside the trust boundary,
 * an assistant turn is the agent's own prior output, and everything else
 * is operator-authored. What it cannot separate today is an operator
 * system message from an agent-authored one, because `Message` carries no
 * explicit provenance field. That gap is recorded rather than papered
 * over — the alternative, one scalar trust tier for the whole transcript,
 * would erase exactly the distinction this record exists to preserve.
 */
function conversationTrustVector(conversation: Conversation): string {
  const counts = { operator: 0, agent: 0, retrieved: 0 };
  // Ordered tier sequence, not only totals. Counts alone would report two
  // transcripts with the same mix but a different order as identical,
  // which is a weaker signal than a `reference-only` source's digest is
  // supposed to carry: the epoch promises integrity evidence about a
  // source it deliberately does not quote, so that evidence has to
  // distinguish arrangements it cannot show. The sequence is digested
  // rather than inlined so the vector stays a fixed size on a long
  // conversation.
  const sequence: string[] = [];
  for (const message of conversation.getMessages()) {
    let tier: 'o' | 'a' | 'r';
    if (message.toolResult !== undefined) {
      tier = 'r';
      counts.retrieved += 1;
    } else if (message.role === 'assistant') {
      tier = 'a';
      counts.agent += 1;
    } else {
      tier = 'o';
      counts.operator += 1;
    }
    sequence.push(tier);
  }
  return (
    `operator=${counts.operator},agent=${counts.agent},retrieved=${counts.retrieved}` +
    `,order=${digestText(sequence.join(''))}`
  );
}

const INCLUDED: ContextSourceDisposition = { kind: 'included' };
const ABSENT: ContextSourceDisposition = { kind: 'absent-by-composition' };

/**
 * Seals one epoch from already-resolved inputs. Pure and synchronous: it
 * resolves nothing itself, so it cannot observe a value the attempt did
 * not actually use.
 */
export function sealContextEpoch(input: SealContextEpochInput): EffectiveContextEpoch {
  const messages = input.conversation.getMessages();
  const renderedBaseline = messages
    .map(
      (message) => `${message.role}:${typeof message.content === 'string' ? message.content : ''}`,
    )
    .join('\n');

  const sources: ContextSourceRecord[] = [
    {
      sourceId: 'conversation',
      trust: 'per-message',
      precedence: 5,
      availability: 'required',
      redaction: 'reference-only',
      disposition: INCLUDED,
      revision: messages.length,
      digest: conversationTrustVector(input.conversation),
    },
    {
      sourceId: 'steering-desired',
      trust: 'trusted-operator',
      precedence: 2,
      availability: 'optional',
      redaction: 'none',
      disposition: input.steering === undefined ? ABSENT : INCLUDED,
      revision: input.steering?.configVersion,
    },
    {
      sourceId: 'selection-plan',
      trust: 'trusted-operator',
      precedence: 0,
      availability: 'required',
      redaction: 'digest-only',
      disposition: input.plan === undefined ? ABSENT : INCLUDED,
      revision: input.plan?.planId,
      digest:
        input.plan === undefined
          ? undefined
          : digestText(
              `${input.plan.outcome}|${input.plan.catalogRevision}|${input.plan.policyRevision}|${input.plan.selectorRevision}`,
            ),
    },
    {
      sourceId: 'hook-plan',
      trust: 'trusted-operator',
      precedence: 2,
      availability: 'required',
      redaction: 'digest-only',
      disposition: input.hookPlanRevision === undefined ? ABSENT : INCLUDED,
      revision: input.hookPlanRevision,
    },
    {
      sourceId: 'toolbox',
      trust: 'trusted-operator',
      precedence: 4,
      availability: 'required',
      redaction: 'digest-only',
      disposition: input.toolNames === undefined ? ABSENT : INCLUDED,
      revision: input.toolNames?.length,
      // Sorted: a toolbox is a set, and two steps that resolved the same
      // tools in a different order have not changed the model's context.
      digest:
        input.toolNames === undefined
          ? undefined
          : digestText(input.toolNames.toSorted().join(',')),
    },
    {
      sourceId: 'response-format',
      trust: 'trusted-operator',
      precedence: 1,
      availability: 'optional',
      redaction: 'digest-only',
      disposition: input.responseFormatDigest === undefined ? ABSENT : INCLUDED,
      digest: input.responseFormatDigest,
    },
    {
      // A source of its own rather than a field on `agent-instructions`: skill instructions come
      // from a different trust tier than the agent's own, and folding them together would let a
      // third-party skill's content hide behind the operator's provenance.
      sourceId: 'skill-activation',
      // `untrusted-retrieved`, matching the project's own security position that skill content is
      // untrusted instruction input and passes the same guardrail and trust policy as retrieved
      // evidence. A skill an operator admitted is still a third party's text.
      trust: 'untrusted-retrieved',
      precedence: 3,
      availability: 'optional',
      redaction: 'digest-only',
      disposition: input.skillActivation === undefined ? ABSENT : INCLUDED,
      revision: input.skillActivation?.catalogRevision,
      digest:
        input.skillActivation === undefined
          ? undefined
          : digestText(
              input.skillActivation.activations
                .map(
                  (activation) =>
                    `${activation.name}|${activation.sourceId}|${activation.trust}` +
                    `|${activation.artifactDigest}|${activation.instructionsDigest}`,
                )
                .join('\n'),
            ),
    },
    {
      sourceId: 'agent-instructions',
      trust: 'trusted-operator',
      precedence: 1,
      availability: 'required',
      redaction: 'digest-only',
      disposition: input.agentName === undefined ? ABSENT : INCLUDED,
      revision: input.agentName,
    },
  ];

  return {
    epochId: input.epochId,
    supersedes: input.previousEpochId,
    sources,
    baselineDigest: digestText(renderedBaseline),
    agentName: input.agentName,
    selectionPlanId: input.plan?.planId,
    policyRevision: input.plan?.policyRevision,
    configVersion: input.steering?.configVersion,
    firstConsumedBy: input.consumer,
  };
}

/**
 * True when two epochs bound the same sources at the same versions, so the
 * later attempt may reuse the earlier epoch's identity rather than minting
 * a successor. Compares dispositions and digests, never `epochId` or
 * `firstConsumedBy`.
 */
export function epochSourcesUnchanged(
  previous: EffectiveContextEpoch,
  next: EffectiveContextEpoch,
): boolean {
  if (previous.baselineDigest !== next.baselineDigest) return false;
  if (previous.sources.length !== next.sources.length) return false;
  return previous.sources.every((source, index) => {
    const other = next.sources[index];
    return (
      other !== undefined &&
      source.sourceId === other.sourceId &&
      source.revision === other.revision &&
      source.digest === other.digest &&
      source.disposition.kind === other.disposition.kind
    );
  });
}

/** What a caller hands the sealer at one generate attempt. */
export interface ContextEpochSealInput {
  readonly conversation: Conversation;
  readonly steering?: SteeringDesiredState | undefined;
  readonly plan?: SelectionPlan | undefined;
  readonly toolNames?: readonly string[] | undefined;
  /**
   * Active skills, read at seal time.
   *
   * Passed per attempt rather than held on the sealer because a skill can be activated or
   * deactivated between two attempts of the same step, and an epoch that bound a stale active set
   * would attest to context the provider never saw.
   */
  readonly skillActivation?: SkillActivationContext | undefined;
  readonly consumer: ContextEpochConsumer;
}

export interface CreateContextEpochSealerOptions {
  /** Defaults to `crypto.randomUUID`; inject for byte-stable tests. */
  readonly newEpochId?: (() => string) | undefined;
  readonly agentName?: string | undefined;
  /** Read fresh at every seal, so a hook registered mid-run is observed. */
  readonly hookPlanRevision?: (() => number | undefined) | undefined;
  readonly responseFormatDigest?: string | undefined;
}

/**
 * Mints and chains epochs across a run's generate attempts.
 *
 * Reuse is a permitted optimization, not the common case: `conversation`
 * is a bound source and the prior assistant turn is appended before the
 * next step, so successive steps essentially always seal a successor. The
 * case reuse actually serves is a retry attempt where nothing mutated.
 */
export interface ContextEpochSealer {
  seal(input: ContextEpochSealInput): EffectiveContextEpoch;
  /** The most recently sealed epoch, or `undefined` before the first. */
  current(): EffectiveContextEpoch | undefined;
}

export function createContextEpochSealer(
  options: CreateContextEpochSealerOptions = {},
): ContextEpochSealer {
  const newEpochId = options.newEpochId ?? (() => crypto.randomUUID());
  let current: EffectiveContextEpoch | undefined;

  return {
    seal(input: ContextEpochSealInput): EffectiveContextEpoch {
      // Sealed against a placeholder id first so the source comparison can
      // run before an id is spent: minting one and then discarding it on
      // reuse would make ids non-contiguous for no reason.
      const candidate = sealContextEpoch({
        epochId: '',
        conversation: input.conversation,
        steering: input.steering,
        plan: input.plan,
        toolNames: input.toolNames,
        skillActivation: input.skillActivation,
        agentName: options.agentName,
        hookPlanRevision: options.hookPlanRevision?.(),
        responseFormatDigest: options.responseFormatDigest,
        consumer: input.consumer,
      });

      if (current !== undefined && epochSourcesUnchanged(current, candidate)) {
        // Genuinely the same context. Keep the original epoch, including
        // its `firstConsumedBy` — that field names the FIRST turn that
        // consumed it, and this is not that turn.
        return current;
      }

      const sealed: EffectiveContextEpoch = {
        ...candidate,
        epochId: newEpochId(),
        supersedes: current?.epochId,
      };
      current = sealed;
      return sealed;
    },
    current(): EffectiveContextEpoch | undefined {
      return current;
    },
  };
}
