import type { EventMap } from '@lostgradient/lifecycle';

/**
 * Skill lifecycle events (COR-767). Before these, every skill transition was
 * silent: AB-87's matrix recorded the `skills` surface as a declared gap with
 * no `Event` subclass anywhere in the package.
 *
 * All five carry the skill name and the correlation the caller supplies. They
 * are dispatched from the `@lostgradient/skills` tool factories, which COR-1226
 * made the single production path — before that, Bureau ran its own inline
 * copy of these tools, so an event emitted here would never have fired.
 *
 * Deliberately NOT covered here: resource loading (`load_skill_resource`).
 * That is the tier-3 progressive-disclosure step, not a skill lifecycle
 * transition — a skill is already active before any resource is read, and a
 * blocked resource does not deactivate it. `skill.loaded` below means the
 * skill's own instructions were loaded, not a bundled file.
 */

/**
 * Correlation carried by every skill event.
 *
 * Every field optional and every one a bare identifier. A dispatch site stamps what it actually
 * knows: the tool factories cannot see a run or session, which is why Bureau supplies those. The
 * source and artifact fields were added by COR-892 so an event can be tied back to the catalog
 * entry and the exact bundle it came from — a skill name alone does not identify content, and two
 * sources can serve the same name.
 */
export interface SkillEventCorrelation {
  /** The consuming run, when the dispatch site knows it. */
  runId?: string | undefined;
  /** The owning session, when the dispatch site knows it. */
  sessionId?: string | undefined;
  /** The distributed trace this transition belongs to. */
  traceId?: string | undefined;
  /** The agent whose run admitted the skill. */
  agentName?: string | undefined;
  /** The catalog source the skill came from. */
  sourceId?: string | undefined;
  /** The whole-bundle digest the catalog recorded. Identity, never content. */
  artifactDigest?: string | undefined;
}

/**
 * The skill's instructions were loaded from the provider. Fires before the
 * guardrail scan and before the session admits the skill, so a skill that is
 * loaded and then blocked produces `skill.loaded` followed by
 * `skill.rejected` and never `skill.activated`. That ordering is the point:
 * it separates "the provider had it" from "it entered context".
 */
export class SkillLoadedEvent extends Event {
  static readonly type = 'skill.loaded' as const;
  readonly skillName: string;
  readonly correlation: SkillEventCorrelation;
  constructor(skillName: string, correlation: SkillEventCorrelation = {}) {
    super(SkillLoadedEvent.type);
    this.skillName = skillName;
    this.correlation = correlation;
  }
  override get type(): typeof SkillLoadedEvent.type {
    return SkillLoadedEvent.type;
  }
}

/**
 * The skill was admitted to the session and its instructions returned to the
 * model. Fires after every gate the activation path applies.
 */
export class SkillActivatedEvent extends Event {
  static readonly type = 'skill.activated' as const;
  readonly skillName: string;
  readonly correlation: SkillEventCorrelation;
  constructor(skillName: string, correlation: SkillEventCorrelation = {}) {
    super(SkillActivatedEvent.type);
    this.skillName = skillName;
    this.correlation = correlation;
  }
  override get type(): typeof SkillActivatedEvent.type {
    return SkillActivatedEvent.type;
  }
}

/**
 * The skill left the active set. Fires only when a previously active skill is
 * actually deactivated — deactivating an inactive skill is a no-op and emits
 * nothing, matching what the tool itself reports through `deactivated: false`.
 */
export class SkillDeactivatedEvent extends Event {
  static readonly type = 'skill.deactivated' as const;
  readonly skillName: string;
  readonly correlation: SkillEventCorrelation;
  constructor(skillName: string, correlation: SkillEventCorrelation = {}) {
    super(SkillDeactivatedEvent.type);
    this.skillName = skillName;
    this.correlation = correlation;
  }
  override get type(): typeof SkillDeactivatedEvent.type {
    return SkillDeactivatedEvent.type;
  }
}

/**
 * Why an activation attempt was refused before admission.
 *
 * A closed union rather than a free-text reason, following
 * `RecoveryRejectionReason` in `@lostgradient/bureau` — and for the same purpose,
 * so a consumer can branch on the cause without parsing prose. The guardrail's
 * own `category`/`detail` stay off this event for the reason
 * `ReviewRejectedEvent` keeps a decision's reason off the public event: the
 * detail belongs in the privileged, separately-redacted surface, not in a
 * general lifecycle event.
 *
 * `'ownership-policy'` was added once COR-752 defined the gate: Bureau's
 * `skillPolicy` is an admission decision, not merely a catalog filter, and a
 * denial names which of its two rules refused the skill.
 */
/**
 * Why an activation was refused.
 *
 * The first three are COR-767's, from the tool-factory path. The rest were added by COR-892 for
 * the catalog-backed client, which can refuse for reasons the provider-backed tools never could:
 * a name that is not in the run's catalog at all, a source the trust policy did not admit, a
 * revoked source, a skill that lost a name collision, a bundle that has changed since it was
 * catalogued, and content that is not conformant enough to use.
 *
 * `'artifact-changed'` is the security-relevant one: the skill at that path is no longer the skill
 * the trust decision admitted.
 */
export type SkillRejectionReason =
  | 'disabled'
  | 'guardrail-blocked'
  | 'ownership-policy'
  | 'not-in-catalog'
  | 'source-untrusted'
  | 'source-revoked'
  | 'shadowed'
  | 'incompatible'
  | 'artifact-unavailable'
  | 'artifact-changed';

/**
 * Which rule of the admission policy refused an activation. Carried only on an
 * `'ownership-policy'` rejection, and deliberately an identity rather than the
 * policy's contents: a consumer can branch on which rule fired without the
 * event disclosing the configured allow or deny lists.
 *
 * `'allow-list'` — an allow list is configured and the skill is not on it.
 * `'deny-list'` — the skill appears on the deny list.
 */
export type SkillAdmissionRule = 'allow-list' | 'deny-list';

/**
 * An activation attempt was refused before the skill entered context.
 * Mutually exclusive with {@link SkillFailedEvent} for one attempt: rejection
 * is a pre-admission policy outcome, failure is a runtime fault.
 */
export class SkillRejectedEvent extends Event {
  static readonly type = 'skill.rejected' as const;
  readonly skillName: string;
  readonly reason: SkillRejectionReason;
  /**
   * The admission rule that refused the skill. Set only when `reason` is
   * `'ownership-policy'`; undefined for every other reason, which have no rule
   * to name.
   */
  readonly rule: SkillAdmissionRule | undefined;
  readonly correlation: SkillEventCorrelation;
  constructor(
    skillName: string,
    reason: SkillRejectionReason,
    correlation: SkillEventCorrelation = {},
    rule?: SkillAdmissionRule,
  ) {
    super(SkillRejectedEvent.type);
    this.skillName = skillName;
    this.reason = reason;
    this.correlation = correlation;
    this.rule = rule;
  }
  override get type(): typeof SkillRejectedEvent.type {
    return SkillRejectedEvent.type;
  }
}

/**
 * An activation attempt could not complete because the skill was not there to
 * admit — the provider returned nothing for that name. Distinct from
 * {@link SkillRejectedEvent}, which is a policy refusal of a skill that does
 * exist. One attempt produces at most one of the two, never both.
 */
export class SkillFailedEvent extends Event {
  static readonly type = 'skill.failed' as const;
  readonly skillName: string;
  readonly correlation: SkillEventCorrelation;
  constructor(skillName: string, correlation: SkillEventCorrelation = {}) {
    super(SkillFailedEvent.type);
    this.skillName = skillName;
    this.correlation = correlation;
  }
  override get type(): typeof SkillFailedEvent.type {
    return SkillFailedEvent.type;
  }
}

/**
 * A catalog revision was built. One per discovery pass, not one per skill.
 *
 * Carries counts rather than the records themselves: a catalog can hold hundreds of entries, and
 * an event that inlined them would make every observer pay for the whole catalog on every refresh.
 */
export class SkillCatalogRevisedEvent extends Event {
  static readonly type = 'skill.catalog-revised' as const;
  readonly revision: number;
  readonly digest: string;
  readonly discovered: number;
  readonly available: number;
  readonly correlation: SkillEventCorrelation;
  constructor(
    revision: number,
    digest: string,
    counts: { readonly discovered: number; readonly available: number },
    correlation: SkillEventCorrelation = {},
  ) {
    super(SkillCatalogRevisedEvent.type);
    this.revision = revision;
    this.digest = digest;
    this.discovered = counts.discovered;
    this.available = counts.available;
    this.correlation = correlation;
  }
}

/**
 * A source's trust decision admitted or refused its skills.
 *
 * Separate from activation: admission is about the *source*, decided once per discovery pass, and
 * a skill from an unadmitted source is never offered in the first place.
 */
export class SkillSourceAdmittedEvent extends Event {
  static readonly type = 'skill.source-admitted' as const;
  readonly sourceId: string;
  readonly trust: string;
  readonly reason: string;
  readonly correlation: SkillEventCorrelation;
  constructor(
    sourceId: string,
    trust: string,
    reason: string,
    correlation: SkillEventCorrelation = {},
  ) {
    super(SkillSourceAdmittedEvent.type);
    this.sourceId = sourceId;
    this.trust = trust;
    this.reason = reason;
    this.correlation = correlation;
  }
}

/**
 * A conformance verdict was reached for one skill.
 *
 * Carries diagnostic codes rather than messages: a code is stable enough to branch on, and a
 * message is a third party's text that would end up in every log line.
 */
export class SkillCompatibilityDecidedEvent extends Event {
  static readonly type = 'skill.compatibility-decided' as const;
  readonly skillName: string;
  readonly conformant: boolean;
  readonly diagnosticCodes: readonly string[];
  readonly correlation: SkillEventCorrelation;
  constructor(
    skillName: string,
    conformant: boolean,
    diagnosticCodes: readonly string[],
    correlation: SkillEventCorrelation = {},
  ) {
    super(SkillCompatibilityDecidedEvent.type);
    this.skillName = skillName;
    this.conformant = conformant;
    this.diagnosticCodes = diagnosticCodes;
    this.correlation = correlation;
  }
}

/**
 * A bundled resource was read for an active skill — the tier-three disclosure step.
 *
 * COR-767 deliberately left this out of the *lifecycle* events, and rightly: a skill is already
 * active before any resource is read, and a blocked resource does not deactivate it. It is
 * nonetheless an observable transition COR-892 requires, so it is its own event rather than being
 * folded into `skill.loaded`, which means the skill's own instructions.
 */
export class SkillResourceLoadedEvent extends Event {
  static readonly type = 'skill.resource-loaded' as const;
  readonly skillName: string;
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly correlation: SkillEventCorrelation;
  constructor(
    skillName: string,
    resource: { readonly path: string; readonly mediaType: string; readonly byteLength: number },
    correlation: SkillEventCorrelation = {},
  ) {
    super(SkillResourceLoadedEvent.type);
    this.skillName = skillName;
    this.path = resource.path;
    this.mediaType = resource.mediaType;
    this.byteLength = resource.byteLength;
    this.correlation = correlation;
  }
}

/**
 * Active instructions were re-rendered into context after compaction.
 *
 * Observable because it is the mechanism by which instructions survive a strategy that rewrote the
 * entire transcript — an operator debugging "why is this skill still in context" needs to see that
 * it was reinjected rather than retained.
 */
export class SkillReinjectedEvent extends Event {
  static readonly type = 'skill.reinjected' as const;
  readonly skillNames: readonly string[];
  readonly instructionsDigest: string;
  readonly correlation: SkillEventCorrelation;
  constructor(
    skillNames: readonly string[],
    instructionsDigest: string,
    correlation: SkillEventCorrelation = {},
  ) {
    super(SkillReinjectedEvent.type);
    this.skillNames = skillNames;
    this.instructionsDigest = instructionsDigest;
    this.correlation = correlation;
  }
}

/**
 * An active set was rehydrated from stored records.
 *
 * Reports refusals alongside recoveries, because a recovery that silently dropped a skill would
 * leave a resumed run quietly less capable than the one it resumed.
 */
export class SkillRecoveredEvent extends Event {
  static readonly type = 'skill.recovered' as const;
  readonly recovered: readonly string[];
  readonly refused: readonly string[];
  readonly correlation: SkillEventCorrelation;
  constructor(
    recovered: readonly string[],
    refused: readonly string[],
    correlation: SkillEventCorrelation = {},
  ) {
    super(SkillRecoveredEvent.type);
    this.recovered = recovered;
    this.refused = refused;
    this.correlation = correlation;
  }
}

/**
 * Asynchronous skill work was cancelled before it finished.
 *
 * Distinct from {@link SkillFailedEvent}: nothing went wrong, someone asked it to stop. Collapsing
 * the two would make a cancelled poll indistinguishable from a broken source in every dashboard
 * built on these events.
 */
export class SkillCancelledEvent extends Event {
  static readonly type = 'skill.cancelled' as const;
  readonly operation: 'discovery' | 'refresh' | 'remote-fetch';
  readonly detail: string;
  readonly correlation: SkillEventCorrelation;
  constructor(
    operation: 'discovery' | 'refresh' | 'remote-fetch',
    detail: string,
    correlation: SkillEventCorrelation = {},
  ) {
    super(SkillCancelledEvent.type);
    this.operation = operation;
    this.detail = detail;
    this.correlation = correlation;
  }
}

/**
 * Maps each event type string to its class. Deliberately does NOT extend
 * `EventMap` — the same split `FileSynchronizerEventClassMap` uses in
 * `@lostgradient/memory`, because a type that extends an index signature has its
 * `keyof` collapse to `string`, which would let a typo'd literal through.
 */
export interface SkillEventClassMap {
  [SkillLoadedEvent.type]: SkillLoadedEvent;
  [SkillActivatedEvent.type]: SkillActivatedEvent;
  [SkillDeactivatedEvent.type]: SkillDeactivatedEvent;
  [SkillRejectedEvent.type]: SkillRejectedEvent;
  [SkillFailedEvent.type]: SkillFailedEvent;
  [SkillCatalogRevisedEvent.type]: SkillCatalogRevisedEvent;
  [SkillSourceAdmittedEvent.type]: SkillSourceAdmittedEvent;
  [SkillCompatibilityDecidedEvent.type]: SkillCompatibilityDecidedEvent;
  [SkillResourceLoadedEvent.type]: SkillResourceLoadedEvent;
  [SkillReinjectedEvent.type]: SkillReinjectedEvent;
  [SkillRecoveredEvent.type]: SkillRecoveredEvent;
  [SkillCancelledEvent.type]: SkillCancelledEvent;
}

export interface SkillEventMap extends SkillEventClassMap, EventMap {}

export type SkillEventType = Extract<keyof SkillEventClassMap, string>;
