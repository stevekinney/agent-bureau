import { sha256Hex } from '@lostgradient/cryptography';
import type { TypedEventTarget } from '@lostgradient/lifecycle';

import { refusedByAdmissionPolicy, type SkillAdmissionPolicy } from '../admission';
import type { SkillArtifact } from '../artifact';
import { parseAllowedTools } from '../conformance';
import { availableRecords, findRecord, type SkillCatalogRevision } from '../discovery/catalog';
import {
  SkillActivatedEvent,
  SkillCatalogRevisedEvent,
  SkillCompatibilityDecidedEvent,
  SkillDeactivatedEvent,
  SkillLoadedEvent,
  SkillRecoveredEvent,
  SkillRejectedEvent,
  SkillResourceLoadedEvent,
  SkillSourceAdmittedEvent,
  type SkillAdmissionRule,
  type SkillEventCorrelation,
  type SkillEventMap,
  type SkillRejectionReason,
} from '../events';
import { scanSkillResource, type SkillGuardrailOptions } from '../guardrail';
import { importSkillMarkdown } from '../parse-skill-markdown';
import type {
  ActiveSkill,
  SkillActivationOutcome,
  SkillActivationRecord,
  SkillDeactivationOutcome,
} from './activation';
import {
  readInstructions,
  readResource,
  type LoadedSkillResource,
  type SkillArtifactLoader,
} from './artifact-loader';

/** How a skill stands relative to this client, for a host that wants to show the whole picture. */
export type SkillStanding =
  'active' | 'admitted' | 'not-permitted' | 'incompatible' | 'untrusted' | 'revoked' | 'shadowed';

/** One line of the client's own report. */
export interface SkillStandingEntry {
  readonly name: string;
  readonly description: string;
  readonly standing: SkillStanding;
  readonly sourceId: string;
  readonly artifactDigest: string;
  /** Present when the standing is `incompatible`. */
  readonly diagnostics?: readonly string[];
  /**
   * Which admission rule refused this skill. Present only when the standing is `not-permitted`.
   *
   * The rule's identity, never the policy's contents: a host can branch on which rule fired
   * without this report disclosing the configured allow or deny lists.
   */
  readonly admissionRule?: SkillAdmissionRule;
}

/**
 * What a parent run permits a child to use.
 *
 * Attenuation only. A grant can narrow what a child sees and asks for; it can never let a child
 * reach a skill or a tool the parent could not, which is the same rule `allowed-tools` follows and
 * for the same reason — delegation must not be a way to acquire authority by going one level down.
 */
export interface SkillDelegationGrant {
  /**
   * Skill names the child may use. Omit to pass the parent's own availability through unchanged.
   *
   * An empty array is not the same as omitting it: it grants nothing.
   */
  readonly skills?: readonly string[] | undefined;
  /** Tools the parent's grant allows. A child's skill requests intersect with this. */
  readonly tools?: readonly string[] | undefined;
}

/** Options for {@link createSkillClient}. */
export interface CreateSkillClientOptions {
  /** The revision this client is bound to. Immutable for the client's whole life. */
  readonly catalog: SkillCatalogRevision;
  readonly loadArtifact: SkillArtifactLoader;
  /** Injectable so a test need not read a real clock. */
  readonly now?: () => string;
  /**
   * Where lifecycle events are dispatched.
   *
   * Optional, and absent means silence rather than a no-op emitter, so a caller that never wired
   * observation pays nothing. Events fire from *this* client because this is the path production
   * takes — the lesson COR-1226 paid for, where events hung off a surface production never reached.
   */
  readonly events?: TypedEventTarget<SkillEventMap>;
  /** Stamped onto every event. A client cannot see a run or session; its host supplies them. */
  readonly correlation?: SkillEventCorrelation;
  /**
   * Which skills this deployment permits activating, by name.
   *
   * Taken directly rather than inferred from catalog availability, because the two answer
   * different questions: availability is a property of the artifact, admission is a property of
   * the deployment, and a perfectly trustworthy skill can still be refused here.
   */
  readonly admissionPolicy?: SkillAdmissionPolicy;
  /**
   * Scans skill content before it enters context.
   *
   * A skill's body and its resources are untrusted instruction input — authored by whoever
   * published the skill, not by this session's user — so they pass the same detector pipeline as
   * anything else that reaches a model. Omitting this is the guardrail bypass COR-892 exists to
   * close: a client that admitted instructions no detector had seen would be a way in for exactly
   * the content the rest of the pipeline is built to catch.
   */
  readonly guardrail?: SkillGuardrailOptions;
}

/**
 * The Agent-owned skill client.
 *
 * Bound to exactly one catalog revision and never re-reads it. A client whose catalog could move
 * underneath it would be able to activate, mid-conversation, a skill the operator never saw —
 * which is the thing catalog revisions are numbered to prevent. A host that wants a newer catalog
 * builds a new client from it.
 */
export interface SkillClient {
  /** The revision this client is bound to. */
  catalog(): SkillCatalogRevision;

  /**
   * What the model may see before activation: exactly name and description.
   *
   * Tier one of progressive disclosure. An unavailable skill is not offered at all — a model
   * cannot usefully be told about a skill it is not permitted to activate, and listing one would
   * invite it to try.
   */
  offered(): readonly { readonly name: string; readonly description: string }[];

  /** The whole picture, for a host rather than a model. */
  report(): readonly SkillStandingEntry[];

  /** Activates by name, validating against the admitted catalog. */
  activate(name: string): Promise<SkillActivationOutcome>;

  /** Deactivates by name. */
  deactivate(name: string): SkillDeactivationOutcome;

  /** Every active skill, in activation order. */
  active(): readonly ActiveSkill[];

  /** The provenance records alone, for persistence and correlation. */
  activationRecords(): readonly SkillActivationRecord[];

  /** Loads one resource from an *active* skill's bundle. */
  loadResource(name: string, path: string): LoadedSkillResource | undefined;

  /**
   * The tools every active skill agrees may remain available, or `undefined` when none asked.
   *
   * Intersection, not union: each active skill may narrow further, and none may widen. `undefined`
   * means no active skill expressed a preference, which is different from every skill agreeing on
   * an empty set — the latter would mean no tools at all.
   */
  narrowedTools(): readonly string[] | undefined;

  /**
   * Rehydrates an active set from persisted records.
   *
   * Every record is re-validated against this client's catalog and its artifact re-read and
   * digest-checked, so recovery cannot resurrect a skill whose source was revoked or whose files
   * changed while the run was away. That is the whole reason records carry a digest.
   */
  recover(
    records: readonly SkillActivationRecord[],
  ): Promise<{ readonly recovered: readonly string[]; readonly refused: readonly string[] }>;

  /**
   * Derives a child client whose reach is the intersection of this one's and the grant.
   *
   * The child has its own active set — a parent's activations are not a child's — but it can never
   * see or activate a skill this client could not, and its narrowed tools intersect the grant's.
   * Attenuation composes: a grandchild narrows further and never widens back.
   */
  attenuate(grant: SkillDelegationGrant): SkillClient;
}

function standingFor(
  record: ReturnType<typeof findRecord> & object,
  isActive: boolean,
): SkillStanding {
  if (isActive) return 'active';
  if (record.available) return 'admitted';
  switch (record.unavailableReason) {
    case 'source-untrusted':
      return 'untrusted';
    case 'source-revoked':
      return 'revoked';
    case 'shadowed':
      return 'shadowed';
    default:
      return 'incompatible';
  }
}

/** Creates a client bound to one catalog revision. */
export function createSkillClient(options: CreateSkillClientOptions): SkillClient {
  const now = options.now ?? ((): string => new Date().toISOString());
  const activeOrder: string[] = [];
  const activeSkills = new Map<string, ActiveSkill>();
  const activeArtifacts = new Map<string, SkillArtifact>();
  const events = options.events;
  const baseCorrelation = options.correlation ?? {};

  /** Correlation for one skill, carrying the source and artifact that identify its content. */
  function correlationFor(name: string): SkillEventCorrelation {
    const record = findRecord(options.catalog, name);
    return {
      ...baseCorrelation,
      ...(record === undefined
        ? {}
        : { sourceId: record.sourceId, artifactDigest: record.artifactDigest }),
    };
  }

  function reject(name: string, reason: SkillRejectionReason, rule?: SkillAdmissionRule): void {
    events?.dispatchEvent(new SkillRejectedEvent(name, reason, correlationFor(name), rule));
  }

  /**
   * The refusal a name outside this run's reach produces, whether it is absent from the catalog or
   * refused by the deployment's admission policy.
   *
   * Identical in both cases, deliberately. A distinct refusal for "exists but you may not have it"
   * is an existence oracle: a model that cannot see the catalog could probe names and read the
   * difference to enumerate what the operator configured. The host learns which it was from the
   * `skill.rejected` event, which carries the reason and the admission rule; the model learns only
   * that this run has no such skill.
   */
  function outOfReach(name: string): SkillActivationOutcome {
    return {
      activated: false,
      refusal: 'not-in-catalog',
      // Names the constraint rather than the string, so a model cannot learn from the refusal
      // which unlisted names exist.
      message: `No skill named '${name}' is in this run's catalog.`,
    };
  }

  /** Every record this deployment's admission policy permits. */
  function admissiblyAvailable(): ReturnType<typeof availableRecords> {
    return availableRecords(options.catalog).filter(
      (record) => refusedByAdmissionPolicy(record.name, options.admissionPolicy) === undefined,
    );
  }

  // The catalog this client was handed is a fact about the run, announced once at construction
  // rather than re-announced per read.
  events?.dispatchEvent(
    new SkillCatalogRevisedEvent(
      options.catalog.revision,
      options.catalog.digest,
      {
        discovered: options.catalog.records.length,
        available: availableRecords(options.catalog).length,
      },
      baseCorrelation,
    ),
  );

  for (const record of options.catalog.records) {
    events?.dispatchEvent(
      new SkillSourceAdmittedEvent(record.sourceId, record.trust, record.trustReason, {
        ...baseCorrelation,
        sourceId: record.sourceId,
      }),
    );
    events?.dispatchEvent(
      new SkillCompatibilityDecidedEvent(
        record.name,
        record.compatibility.conformant,
        record.compatibility.diagnostics.map((diagnostic) => diagnostic.code),
        { ...baseCorrelation, sourceId: record.sourceId, artifactDigest: record.artifactDigest },
      ),
    );
  }

  async function admit(name: string): Promise<SkillActivationOutcome> {
    // Admission before existence, and before availability. A refused skill must be indistinguishable
    // from an absent one to the model, which it cannot be if any earlier check answers first with a
    // different refusal.
    const refusedBy = refusedByAdmissionPolicy(name, options.admissionPolicy);
    if (refusedBy !== undefined) {
      reject(name, 'ownership-policy', refusedBy);
      return outOfReach(name);
    }

    const record = findRecord(options.catalog, name);
    if (record === undefined) {
      reject(name, 'not-in-catalog');
      return outOfReach(name);
    }

    if (!record.available) {
      const refusal =
        record.unavailableReason === 'source-untrusted'
          ? 'source-untrusted'
          : record.unavailableReason === 'source-revoked'
            ? 'source-revoked'
            : record.unavailableReason === 'shadowed'
              ? 'shadowed'
              : 'incompatible';
      reject(name, refusal);
      return {
        activated: false,
        refusal,
        message: `Skill '${name}' is not available: ${record.unavailableReason ?? 'unknown reason'}.`,
      };
    }

    if (activeSkills.has(name)) {
      // Deduplication is a no-op rather than an error (COR-752, Decision 4): a model asking twice
      // has not done anything wrong, and the second admission would change nothing.
      return {
        activated: false,
        refusal: 'already-active',
        message: `Skill '${name}' is already active.`,
      };
    }

    const load = await options.loadArtifact(record);
    if (!load.loaded) {
      const refusal = load.failure === 'changed' ? 'artifact-changed' : 'artifact-unavailable';
      reject(name, refusal);
      return { activated: false, refusal, message: load.message };
    }

    const instructions = readInstructions(load.artifact);
    if (instructions === undefined) {
      reject(name, 'artifact-unavailable');
      return {
        activated: false,
        refusal: 'artifact-unavailable',
        message: `Skill '${name}' has no instructions to admit.`,
      };
    }

    // Before admission, as COR-767's ordering requires: `skill.loaded` separates "the bundle had
    // it" from "it entered context", so a skill loaded and then refused produces `loaded` followed
    // by `rejected` and never `activated`.
    events?.dispatchEvent(new SkillLoadedEvent(name, correlationFor(name)));

    // The scan sits between loading and admitting, which is the only place it can sit: scanning
    // earlier would mean scanning bytes that never enter context, and scanning later would mean
    // the instructions are already in the active set a renderer reads from.
    if (options.guardrail !== undefined) {
      const scan = await scanSkillResource(instructions, options.guardrail);
      if (scan.blocked) {
        reject(name, 'guardrail-blocked');
        return {
          activated: false,
          refusal: 'guardrail-blocked',
          message: `Skill '${name}' was blocked by a guardrail before its instructions entered context.`,
        };
      }
    }

    const imported = importSkillMarkdown(
      instructions,
      record.directoryName === undefined ? undefined : { directoryName: record.directoryName },
    );
    const body = imported.content.body;

    const activationRecord: SkillActivationRecord = {
      name: record.name,
      sourceId: record.sourceId,
      sourceKind: record.sourceKind,
      trust: record.trust,
      artifactDigest: record.artifactDigest,
      instructionsDigest: await sha256Hex(body),
      requestedTools: parseAllowedTools(imported.content.metadata.toolPolicy?.allowList?.join(' ')),
      catalogRevision: options.catalog.revision,
      activatedAt: now(),
    };

    activeSkills.set(name, { record: activationRecord, instructions: body });
    activeArtifacts.set(name, load.artifact);
    activeOrder.push(name);

    events?.dispatchEvent(new SkillActivatedEvent(name, correlationFor(name)));
    return { activated: true, record: activationRecord };
  }

  return {
    catalog: () => options.catalog,

    // Filtered, not merely gated at activation: a refused skill named in the tier-one catalog has
    // already told the model it exists, whatever the activation tool then says.
    offered: () =>
      admissiblyAvailable().map((record) => ({
        name: record.name,
        description: record.description,
      })),

    // The host's view, unlike `offered()`: a refused skill appears here with the rule that refused
    // it, because an operator asking "why can this run not use that skill" needs the answer.
    report: () =>
      options.catalog.records.map((record) => {
        const refusedBy = refusedByAdmissionPolicy(record.name, options.admissionPolicy);
        return {
          name: record.name,
          description: record.description,
          standing:
            refusedBy === undefined
              ? standingFor(record, activeSkills.has(record.name))
              : ('not-permitted' as const),
          ...(refusedBy === undefined ? {} : { admissionRule: refusedBy }),
          sourceId: record.sourceId,
          artifactDigest: record.artifactDigest,
          ...(record.compatibility.conformant
            ? {}
            : {
                diagnostics: record.compatibility.diagnostics.map(
                  (diagnostic) => diagnostic.message,
                ),
              }),
        };
      }),

    activate: admit,

    deactivate(name: string): SkillDeactivationOutcome {
      if (!activeSkills.has(name)) return { deactivated: false, reason: 'not-active', name };
      activeSkills.delete(name);
      activeArtifacts.delete(name);
      const index = activeOrder.indexOf(name);
      if (index >= 0) activeOrder.splice(index, 1);
      events?.dispatchEvent(new SkillDeactivatedEvent(name, correlationFor(name)));
      return { deactivated: true, name };
    },

    active: () =>
      activeOrder
        .map((name) => activeSkills.get(name))
        .filter((entry): entry is ActiveSkill => entry !== undefined),

    activationRecords: () =>
      activeOrder
        .map((name) => activeSkills.get(name)?.record)
        .filter((record): record is SkillActivationRecord => record !== undefined),

    loadResource(name: string, path: string): LoadedSkillResource | undefined {
      // Only an *active* skill's resources load. An inactive skill's bundle is not part of this
      // run's context, and letting it be read would be tier-three disclosure without the tier-two
      // decision that is supposed to gate it.
      const artifact = activeArtifacts.get(name);
      if (artifact === undefined) return undefined;
      const resource = readResource(artifact, path);
      if (resource !== undefined) {
        events?.dispatchEvent(
          new SkillResourceLoadedEvent(
            name,
            {
              path: resource.path,
              mediaType: resource.mediaType,
              byteLength: resource.bytes.byteLength,
            },
            correlationFor(name),
          ),
        );
      }
      return resource;
    },

    narrowedTools(): readonly string[] | undefined {
      const requests = activeOrder
        .map((name) => activeSkills.get(name)?.record.requestedTools)
        .filter((tools): tools is readonly string[] => tools !== undefined && tools.length > 0);
      if (requests.length === 0) return undefined;
      const [first, ...rest] = requests;
      if (first === undefined) return undefined;
      return rest.reduce<readonly string[]>(
        (narrowed, tools) => narrowed.filter((tool) => tools.includes(tool)),
        first,
      );
    },

    attenuate(grant: SkillDelegationGrant): SkillClient {
      const permitted = grant.skills;
      const child = createSkillClient(options);

      const parentOffered = new Set(admissiblyAvailable().map((record) => record.name));
      const allowed =
        permitted === undefined
          ? parentOffered
          : // Intersection, not replacement: a grant naming a skill the parent cannot use does not
            // conjure it into existence for the child.
            new Set(permitted.filter((name) => parentOffered.has(name)));

      return {
        ...child,
        offered: () => child.offered().filter((entry) => allowed.has(entry.name)),
        report: () => child.report().filter((entry) => allowed.has(entry.name)),
        async activate(name: string): Promise<SkillActivationOutcome> {
          if (!allowed.has(name)) {
            // Distinguishable from `not-in-catalog`, unlike an admission refusal, and deliberately.
            // The admission policy hides the deployment's configuration from a model that is
            // adversarial towards it; a grant is composed by trusted parent code inside the same
            // boundary, where the child learning "that name means something upstream" reveals
            // nothing withheld from it and telling a misconfigured grant apart from a missing skill
            // is what an operator debugs.
            //
            // That reasoning depends on the parent being code. If a grant ever becomes something a
            // *model* composes from its own output, the child leaves the trust boundary and this
            // refusal becomes the same oracle admission avoids — collapse it into `outOfReach` then.
            return {
              activated: false,
              refusal: 'not-delegated',
              message: `Skill '${name}' is not within the delegation grant for this child.`,
            };
          }
          return child.activate(name);
        },
        narrowedTools(): readonly string[] | undefined {
          const fromSkills = child.narrowedTools();
          const fromGrant = grant.tools;
          if (fromGrant === undefined) return fromSkills;
          if (fromSkills === undefined) return fromGrant;
          return fromSkills.filter((tool) => fromGrant.includes(tool));
        },
        attenuate: (nested: SkillDelegationGrant): SkillClient =>
          // Composed against what this level already permits, so a grandchild cannot widen back.
          child.attenuate({
            skills: (nested.skills ?? [...allowed]).filter((name) => allowed.has(name)),
            ...(nested.tools === undefined && grant.tools === undefined
              ? {}
              : {
                  tools: (nested.tools ?? grant.tools ?? []).filter(
                    (tool) => grant.tools === undefined || grant.tools.includes(tool),
                  ),
                }),
          }),
      };
    },

    async recover(records): Promise<{ recovered: readonly string[]; refused: readonly string[] }> {
      const recovered: string[] = [];
      const refused: string[] = [];
      for (const record of records) {
        const outcome = await admit(record.name);
        if (!outcome.activated) {
          refused.push(record.name);
          continue;
        }
        // Digest-bound: the stored record is what proves the recovered skill is the one the run
        // actually had. Equal names and a re-read artifact are not enough — the artifact could
        // have been rewritten with the same path and a different body.
        //
        // Both digests, not just the instructions. The loader only checks an artifact against the
        // catalog it was *just* discovered from, which a rewritten bundle satisfies: rediscovery
        // hashes the new bytes and the loader agrees with itself. The stored record is the only
        // thing that remembers what this run had. Instructions alone would admit a bundle whose
        // manifest is untouched and whose `references/` were replaced underneath it — a skill that
        // still says "read the guide" while the guide now says something else.
        if (
          outcome.record.instructionsDigest !== record.instructionsDigest ||
          outcome.record.artifactDigest !== record.artifactDigest
        ) {
          activeSkills.delete(record.name);
          activeArtifacts.delete(record.name);
          const index = activeOrder.indexOf(record.name);
          if (index >= 0) activeOrder.splice(index, 1);
          refused.push(record.name);
          continue;
        }
        recovered.push(record.name);
      }
      events?.dispatchEvent(new SkillRecoveredEvent(recovered, refused, baseCorrelation));
      return { recovered, refused };
    },
  };
}
