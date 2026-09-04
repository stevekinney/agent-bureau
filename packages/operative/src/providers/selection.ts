/**
 * The deterministic backend selector and the self-contained `SelectionPlan`
 * (AB-64's decision record, `## Selector and selection plan (AC5, AC6,
 * AC7)`, implemented by AB-249/mod-03b).
 *
 * `select(request, options)` is a pure, synchronous function: it performs no
 * input or output, reads no clock (its only timestamp source is the
 * injected `options.now`), and consumes `composePolicy` (AB-248) to filter
 * hard constraints before ranking soft preferences. Every eligible
 * candidate's `descriptorSnapshot` is a deep, independent structural copy of
 * the deciding `BackendDescriptor` — never a live reference into the
 * catalog — so a `SelectionPlan` replays its own decision unchanged after
 * the source catalog has moved on, been mutated, or been discarded.
 *
 * Out of scope here, per AB-249's delivery boundary: policy composition
 * itself (AB-248, consumed as a dependency); Bureau wiring,
 * `BureauOptions.modelPolicy`, and boundary revalidation (AB-250);
 * cross-mode replay fixtures (AB-251); any LLM-based selector; any
 * `TaskClassification` taxonomy (it stays the opaque caller-supplied tag
 * AB-64 fixes — determinism is a property of the recorded input signature,
 * never of what the tag's string value happens to be).
 *
 * ## Design choices not fully fixed by the decision record
 *
 * The ratified type sketches (Linear AB-64, and the fuller vault record at
 * `ABP-11—Model Capability and Selection Planning.md`) fix every exported
 * shape verbatim but leave a handful of mechanics for the implementing
 * issue to choose. Each choice below is deliberately minimal and
 * self-contained, documented here rather than deferred:
 *
 * - **`select`'s second parameter.** `SelectionRequest` itself is fixed at
 *   exactly the six fields AB-64 names (`agentName`, `taskClassification`,
 *   `requestedValue`, `catalogRevision`, `policyRevision`,
 *   `availabilitySnapshotRevision`) — it is the *recorded signature*
 *   determinism is checked against, not a place to smuggle in the catalog
 *   or the five policy layers. Those travel on a second parameter,
 *   `SelectOptions`, alongside `now`, `newPlanId`, `selectorRevision`, and
 *   the optional `revalidate` input (below). `options.catalog.revision`
 *   must equal `request.catalogRevision`; a caller citing a revision it
 *   does not also supply the matching catalog for is a caller bug this
 *   module cannot detect from data alone; supply the number and the catalog
 *   together.
 * - **`requestedValue.override` versus `UserModelConfiguration.exactOverride`.**
 *   AB-64's "requested" row states `SelectionRequest.requestedValue` "reuses
 *   AB-67's `SteeringRequestedValue`" and its User-configuration section
 *   separately fixes that `UserModelConfiguration.exactOverride` "is checked
 *   against every layer above the user's own... before being honored." This
 *   module treats a `requestedValue` naming `target: 'model' | 'provider' |
 *   'route'` with `.override` set as contributing that one field to the same
 *   `exactOverride` object `composePolicy` already understands — merged with
 *   any standing `options.user.exactOverride` the caller also supplied —
 *   rather than inventing a second, parallel override mechanism.
 *   `composePolicy`'s own `exactOverride` path already never applies the
 *   user layer to a matched candidate (`evaluateThroughDelegated` only), so
 *   this reuse gets AB-64's "checked only against the four layers above the
 *   user's" rule for free instead of reimplementing it. `target: 'effort'`
 *   is handled separately (below) — `composePolicy`'s `matchesOverride`
 *   never reads `exactOverride.effort` when matching a candidate, so an
 *   effort override cannot itself select a provider/model pair.
 * - **`target: 'route'`.** `BackendDescriptor` carries no `route` field
 *   today (`policy.ts`'s own comments note this at every layer). An
 *   override naming a route can never match a descriptor, so it always
 *   yields zero candidates from `composePolicy` and this module reports
 *   `'no-candidate'`, consistent with every other route-touching rule in
 *   the corpus.
 * - **Effort resolution.** The requested effort tier is, in priority order,
 *   `requestedValue` when its target is `'effort'` and it carries an
 *   `.override`, else `options.user?.exactOverride?.effort`, else
 *   `options.user?.defaultEffort`. When defined, every otherwise-eligible
 *   candidate is checked against its own `descriptor.effort.degradesTo`
 *   table: the same tier is always compatible; a different, defined tier is
 *   compatible only under `effortFallbackMode: 'degrade'` and the selected
 *   effort is recorded as the degraded tier, never silently; an `undefined`
 *   entry (the tier is unsupported at any degradation) excludes the
 *   candidate with `'incompatible-effort'` regardless of mode, because there
 *   is nothing to degrade to.
 * - **Ranking signals.** `rankingInputs` names three signals for every
 *   eligible candidate, always populated regardless of whether a preference
 *   activates them, "so the decision procedure is visible rather than
 *   summarized into one score" (AB-249's acceptance criteria, verbatim):
 *   `cost` (0..1, higher is cheaper, normalized across the eligible set from
 *   `descriptor.pricing`; `0.5` for an unpriced descriptor — neither
 *   rewarded nor penalized for missing data), `latency` (a fixed `0` for
 *   every candidate — `BackendDescriptor` carries no latency field yet, so
 *   `latencyPreference` has a documented, always-inert home rather than
 *   silently doing nothing until one exists), and `preferenceMatch` (0, 0.5,
 *   or 1, one half for each of `options.agent.preferredProviders`/`preferredModels`
 *   — AB-64's Agent-preferences layer, `generation-profile.ts`'s `AgentPreferences`,
 *   never `UserModelConfiguration`, which carries no such fields — that
 *   names the candidate). The ranking score sums `cost` weighted by
 *   `costPreference` (`1` for `'lowest-cost'`, `0.5` for `'balanced'`, `0`
 *   otherwise), `latency` weighted the same way by `latencyPreference`
 *   (always contributing `0`, since `latency` is always `0`), and
 *   `preferenceMatch` unweighted. Ties — including the "no preference set at
 *   all" case, where every candidate's score is `preferenceMatch` alone —
 *   break by `(provider, model)` lexicographic order using plain `<`
 *   comparison, never `localeCompare`, so the result never depends on the
 *   host's locale.
 * - **`capability-changed` / `policy-changed`.** These compare a prior
 *   selection against the current one when the caller supplies
 *   `options.revalidate` — a prior selected candidate, and the catalog/policy
 *   revisions that plan was made against. Bureau's boundary revalidation
 *   (AB-250) is the eventual caller that decides *when* to revalidate; this
 *   module only defines what the comparison means, so both outcomes are
 *   reachable and testable now rather than left as dead code until AB-250
 *   lands. When `revalidate.priorCatalogRevision` differs from
 *   `request.catalogRevision` and the prior candidate is no longer present
 *   or no longer eligible, the outcome is `'capability-changed'`. Otherwise,
 *   when `revalidate.priorPolicyRevision` differs from
 *   `request.policyRevision` and the same is true, the outcome is
 *   `'policy-changed'`. When neither the candidate's presence nor its
 *   eligibility changed, revalidation is a no-op and normal selection
 *   proceeds.
 * - **`recordEffectiveGeneration` against a non-`'selected'` plan.** There is
 *   no completed response to diverge from when a plan never selected
 *   anything, so `recordEffectiveGeneration` returns `plan` unchanged, by
 *   reference, for every `outcome` other than `'selected'` — never
 *   fabricating a `'provider-effective-divergence'` outcome with nothing to
 *   compare against.
 */

import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

import type { SteeringRequestedValue } from '../durable/types.ts';
import type { BackendDescriptor, ModelCatalog } from './model-catalog.ts';
import {
  type AgentPreferences,
  type BureauInvariants,
  composePolicy,
  type DelegatedAuthority,
  type DeploymentInvariants,
  type PolicyCandidate,
  type SelectionExclusionCode,
  type UserModelConfiguration,
} from './policy.ts';
import type { Effort, ProviderName } from './types.ts';

export type { SelectionExclusionCode };

/**
 * Opaque caller/Agent-supplied tag (e.g. `'chat'`, `'coding'`,
 * `'tool-heavy'`, `'vision'`). AB-64's decision record fixes no taxonomy —
 * determinism is a property of the `SelectionRequest` signature, independent
 * of what values `TaskClassification` takes. Quality-evidence-based
 * classification is out of scope (ABP-11 ruling); `SelectionCandidate.rankingInputs`
 * is the named extension point for a future signal, not this type.
 */
export type TaskClassification = string & { readonly __brand?: 'TaskClassification' };

/**
 * `select`'s recorded input signature: the five values determinism is
 * checked against (`catalogRevision`, `policyRevision`,
 * `availabilitySnapshotRevision`, `taskClassification`, `requestedValue`)
 * plus the requesting Agent's name. The catalog itself and the five policy
 * layers travel on `SelectOptions`, not here — see this module's top-level
 * documentation.
 */
export interface SelectionRequest {
  readonly agentName: string;
  readonly taskClassification?: TaskClassification;
  /**
   * AB-67's shipped union, narrowed to the four targets a selector can act
   * on — `pause`/`resume`/`agent-identity` are not generation choices and
   * never reach a `SelectionRequest`. Absent means "use the Agent's own
   * default."
   */
  readonly requestedValue?: Extract<
    SteeringRequestedValue,
    { target: 'model' | 'provider' | 'route' | 'effort' }
  >;
  readonly catalogRevision: number;
  readonly policyRevision: number;
  readonly availabilitySnapshotRevision: number;
}

/**
 * One evaluated candidate in a `SelectionPlan`: a policy verdict plus an
 * inlined, independent copy of the descriptor that decided it, and — when
 * eligible — the named ranking signals that positioned it.
 */
export interface SelectionCandidate {
  readonly provider: ProviderName;
  readonly model: string;
  readonly route?: string;
  /** Inlined by value, deeply frozen, and structurally independent of the
   *  source catalog — the replay guarantee AB-64 requires. */
  readonly descriptorSnapshot: BackendDescriptor;
  readonly eligible: boolean;
  readonly exclusionCode?: SelectionExclusionCode;
  readonly exclusionReason?: string;
  readonly rankingInputs?: Readonly<Record<string, number>>;
}

export type SelectionOutcomeKind =
  | 'selected'
  | 'no-candidate'
  | 'stale-catalog'
  | 'capability-changed'
  | 'policy-changed'
  | 'exact-override-rejected'
  | 'provider-effective-divergence';

export interface SelectionOutcomeFailure {
  readonly kind: Exclude<SelectionOutcomeKind, 'selected'>;
  readonly reason: string;
  /** Mirrors `SelectionCandidate.exclusionCode`; present whenever the
   *  failure traces to one specific denying layer or incompatibility.
   *  Absent for `'no-candidate'`/`'stale-catalog'` unless every excluded
   *  candidate shares the identical code, in which case it is still
   *  surfaced rather than discarded. */
  readonly exclusionCode?: SelectionExclusionCode;
  readonly rejectedOverride?: SteeringRequestedValue;
}

interface SelectionPlanCommon {
  readonly planId: string;
  readonly request: SelectionRequest;
  readonly candidates: readonly SelectionCandidate[];
  readonly selected?: {
    readonly provider: ProviderName;
    readonly model: string;
    readonly route?: string;
    readonly effort?: Effort;
  };
  /** Ordered, drawn from `UserModelConfiguration.fallbackOrder` intersected
   *  with the eligible set. Empty when no `fallbackOrder` is configured. */
  readonly fallbackPlan: readonly {
    readonly provider: ProviderName;
    readonly model: string;
    readonly route?: string;
  }[];
  readonly catalogRevision: number;
  readonly policyRevision: number;
  /** Version of the selector algorithm itself, independent of the catalog
   *  or policy revisions it ran against. */
  readonly selectorRevision: number;
  /** AB-67's `SteeringDesiredState.configVersion`, when steering produced
   *  this request. */
  readonly configurationRevision?: number;
  readonly createdAt: string;
}

/**
 * `failure` is present if and only if `outcome !== 'selected'`, enforced
 * structurally by this two-arm union rather than left to a runtime
 * assertion — every field name and type otherwise matches AB-64's decision
 * record verbatim.
 */
export type SelectionPlan =
  | (SelectionPlanCommon & { readonly outcome: 'selected'; readonly failure?: never })
  | (SelectionPlanCommon & {
      readonly outcome: Exclude<SelectionOutcomeKind, 'selected'>;
      readonly failure: SelectionOutcomeFailure;
    });

/**
 * The provider's actual, effective generation state after a request
 * completes — the terminal fact a `SelectionPlan` is checked against for
 * divergence.
 */
export interface EffectiveGenerationResult {
  readonly planId: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly effort?: Effort;
  readonly divergedFromPlan: boolean;
}

/**
 * A prior selection to revalidate the current request against — see this
 * module's top-level documentation for what `'capability-changed'` and
 * `'policy-changed'` mean. Bureau's boundary revalidation (AB-250) decides
 * when to supply this; `select` only defines the comparison.
 */
export interface RevalidationInput {
  readonly priorSelected: {
    readonly provider: ProviderName;
    readonly model: string;
    readonly route?: string;
  };
  readonly priorCatalogRevision: number;
  readonly priorPolicyRevision: number;
}

/** `select`'s second parameter: the catalog, the five policy layers
 *  `composePolicy` consumes, and injectable determinism seams. See this
 *  module's top-level documentation for why these live here rather than on
 *  `SelectionRequest`. */
export interface SelectOptions {
  readonly catalog: ModelCatalog;
  readonly deployment?: DeploymentInvariants;
  readonly bureau?: BureauInvariants;
  readonly agent?: AgentPreferences;
  readonly delegated?: DelegatedAuthority;
  readonly user?: UserModelConfiguration;
  /** Defaults to the wall clock; inject in tests for byte-stable plans. */
  readonly now?: () => string;
  /** Defaults to `crypto.randomUUID`; inject in tests for byte-stable plans. */
  readonly newPlanId?: () => string;
  /**
   * The AB-92/AB-252 `RuntimeServices` seam (AB-325) backing the default
   * `now`/`newPlanId` when those are not supplied. Defaults to the real
   * implementation; explicit `now`/`newPlanId` still take precedence over
   * `runtime` when both are supplied, for backward compatibility.
   */
  readonly runtime?: RuntimeServices;
  /** Defaults to `1`. */
  readonly selectorRevision?: number;
  readonly configurationRevision?: number;
  readonly revalidate?: RevalidationInput;
}

// ── Deep freeze / structural copy, mirroring model-catalog.ts's own helper
// of the same shape — kept local here because descriptorSnapshot's replay
// guarantee requires a copy independent of the *caller's* descriptor array,
// which may not have come from createModelCatalog (and so may not already
// be frozen) at all. ─────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    deepFreeze(record[key]);
  }
  return Object.freeze(value);
}

function snapshotDescriptor(descriptor: BackendDescriptor): BackendDescriptor {
  return deepFreeze(structuredClone(descriptor));
}

/** The requested effort tier, in priority order — see this module's
 *  top-level documentation. */
function requestedEffort(request: SelectionRequest, options: SelectOptions): Effort | undefined {
  if (
    request.requestedValue?.target === 'effort' &&
    request.requestedValue.override !== undefined
  ) {
    return request.requestedValue.override;
  }
  return options.user?.exactOverride?.effort ?? options.user?.defaultEffort;
}

interface EffortVerdict {
  readonly eligible: boolean;
  readonly effort?: Effort;
  readonly exclusionCode?: SelectionExclusionCode;
  readonly exclusionReason?: string;
}

const EFFORT_COMPATIBLE_NO_CHANGE = (effort: Effort): EffortVerdict => ({ eligible: true, effort });

/** Checks one candidate's descriptor against a requested effort tier. */
function evaluateEffort(
  descriptor: BackendDescriptor,
  requested: Effort,
  mode: 'reject' | 'degrade',
): EffortVerdict {
  const resolved = descriptor.effort.degradesTo[requested];
  if (resolved === requested) return EFFORT_COMPATIBLE_NO_CHANGE(requested);
  if (resolved === undefined) {
    return {
      eligible: false,
      exclusionCode: 'incompatible-effort',
      exclusionReason: `effort ${requested} is not supported by ${descriptor.provider}/${descriptor.model}, even degraded`,
    };
  }
  if (mode === 'degrade') return { eligible: true, effort: resolved };
  return {
    eligible: false,
    exclusionCode: 'incompatible-effort',
    exclusionReason: `effort ${requested} degrades to ${resolved} on ${descriptor.provider}/${descriptor.model}, but effortFallbackMode is 'reject'`,
  };
}

/** The three named ranking signals — see this module's top-level
 *  documentation for the normalization and weighting rules. */
function candidateCost(descriptor: BackendDescriptor): number | undefined {
  if (descriptor.pricing === undefined) return undefined;
  return (descriptor.pricing.inputPerMillionTokens + descriptor.pricing.outputPerMillionTokens) / 2;
}

function buildRankingInputs(
  eligible: readonly {
    readonly provider: ProviderName;
    readonly model: string;
    readonly descriptor: BackendDescriptor;
  }[],
  // `preferredProviders`/`preferredModels` are AB-64's Agent-preferences
  // layer, defined in generation-profile.ts's AgentPreferences — never
  // UserModelConfiguration, which carries only costPreference/latencyPreference.
  agent: AgentPreferences | undefined,
): ReadonlyMap<string, Readonly<Record<string, number>>> {
  const costs = eligible.map((candidate) => candidateCost(candidate.descriptor));
  const definedCosts = costs.filter((cost): cost is number => cost !== undefined);
  const minCost = definedCosts.length > 0 ? Math.min(...definedCosts) : undefined;
  const maxCost = definedCosts.length > 0 ? Math.max(...definedCosts) : undefined;

  const result = new Map<string, Readonly<Record<string, number>>>();
  for (const candidate of eligible) {
    const rawCost = candidateCost(candidate.descriptor);
    const cost =
      rawCost === undefined || minCost === undefined || maxCost === undefined
        ? 0.5
        : maxCost === minCost
          ? 1
          : 1 - (rawCost - minCost) / (maxCost - minCost);

    const preferenceMatch =
      (agent?.preferredProviders?.includes(candidate.provider) ? 0.5 : 0) +
      (agent?.preferredModels?.includes(candidate.model) ? 0.5 : 0);

    result.set(
      candidateKey(candidate.provider, candidate.model),
      Object.freeze({ cost, latency: 0, preferenceMatch }),
    );
  }
  return result;
}

type CostOrLatencyPreference =
  UserModelConfiguration['costPreference'] | UserModelConfiguration['latencyPreference'];

function preferenceWeight(preference: CostOrLatencyPreference): number {
  if (preference === 'lowest-cost' || preference === 'lowest-latency') return 1;
  if (preference === 'balanced') return 0.5;
  return 0;
}

function rankingScore(
  rankingInputs: Readonly<Record<string, number>>,
  costPreference: UserModelConfiguration['costPreference'],
  latencyPreference: UserModelConfiguration['latencyPreference'],
): number {
  return (
    preferenceWeight(costPreference) * (rankingInputs['cost'] ?? 0) +
    preferenceWeight(latencyPreference) * (rankingInputs['latency'] ?? 0) +
    (rankingInputs['preferenceMatch'] ?? 0)
  );
}

function candidateKey(provider: ProviderName, model: string): string {
  return `${provider}::${model}`;
}

/**
 * Builds the `exactOverride` `composePolicy` should check: the
 * `provider`/`model`/`route` fields of any standing `options.user.exactOverride`,
 * merged with a `requestedValue` targeting one of those three. `effort` is
 * deliberately excluded even when a standing override sets it —
 * `composePolicy`'s `matchesOverride` never reads `exactOverride.effort` to
 * match a candidate, but the mere *presence* of the `exactOverride` key is
 * what routes `composePolicy` into its single-candidate path, so an
 * effort-only override must never reach it: `requestedEffort` reads
 * `user.exactOverride.effort` directly instead. Returns `undefined` unless
 * at least one of `provider`/`model`/`route` is present after merging, so a
 * pure effort preference never triggers the exact-override path.
 */
function buildExactOverride(
  request: SelectionRequest,
  user: UserModelConfiguration | undefined,
): UserModelConfiguration['exactOverride'] {
  const requestedValue = request.requestedValue;
  const fromRequest =
    requestedValue !== undefined &&
    requestedValue.target !== 'effort' &&
    requestedValue.override !== undefined
      ? { [requestedValue.target]: requestedValue.override }
      : undefined;

  const standing = user?.exactOverride;
  const merged = {
    ...(standing?.provider === undefined ? {} : { provider: standing.provider }),
    ...(standing?.model === undefined ? {} : { model: standing.model }),
    ...(standing?.route === undefined ? {} : { route: standing.route }),
    ...fromRequest,
  };

  if (merged.provider === undefined && merged.model === undefined && merged.route === undefined) {
    return undefined;
  }
  return merged;
}

function isFromRequestOverride(request: SelectionRequest): boolean {
  const requestedValue = request.requestedValue;
  return (
    requestedValue !== undefined &&
    requestedValue.target !== 'effort' &&
    requestedValue.override !== undefined
  );
}

function toRejectedOverride(request: SelectionRequest): SteeringRequestedValue | undefined {
  return isFromRequestOverride(request) ? request.requestedValue : undefined;
}

function toSelectionCandidate(
  policyCandidate: PolicyCandidate,
  overrides: {
    readonly eligible?: boolean;
    readonly exclusionCode?: SelectionExclusionCode;
    readonly exclusionReason?: string;
    readonly effort?: Effort;
  } = {},
): SelectionCandidate {
  const eligible = overrides.eligible ?? policyCandidate.eligible;
  const exclusionCode = eligible
    ? undefined
    : (overrides.exclusionCode ?? policyCandidate.exclusionCode);
  const exclusionReason = eligible
    ? undefined
    : (overrides.exclusionReason ?? policyCandidate.exclusionReason);

  return Object.freeze({
    provider: policyCandidate.provider,
    model: policyCandidate.model,
    ...(policyCandidate.route === undefined ? {} : { route: policyCandidate.route }),
    descriptorSnapshot: snapshotDescriptor(policyCandidate.descriptor),
    eligible,
    ...(exclusionCode === undefined ? {} : { exclusionCode }),
    ...(exclusionReason === undefined ? {} : { exclusionReason }),
  });
}

/** The single `exclusionCode` shared by every excluded candidate in
 *  `candidates`, or `undefined` when there is more than one distinct code
 *  (or none excluded at all) — see this module's top-level documentation on
 *  when `'no-candidate'`/`'stale-catalog'` still surface one. */
function sharedExclusionCode(
  candidates: readonly SelectionCandidate[],
): SelectionExclusionCode | undefined {
  const codes = new Set(
    candidates
      .filter((candidate) => !candidate.eligible)
      .map((candidate) => candidate.exclusionCode),
  );
  if (codes.size !== 1) return undefined;
  const [only] = codes;
  return only;
}

function buildFallbackPlan(
  eligible: readonly SelectionCandidate[],
  fallbackOrder: readonly string[] | undefined,
): SelectionPlan['fallbackPlan'] {
  if (fallbackOrder === undefined || fallbackOrder.length === 0) return Object.freeze([]);
  // When multiple eligible descriptors share the same `model` across
  // different providers, pick a deterministic representative — the
  // lexicographically smallest provider — so the chosen candidate never
  // depends on the incoming descriptor order.
  const byModel = new Map<string, SelectionCandidate>();
  for (const candidate of eligible) {
    const existing = byModel.get(candidate.model);
    if (existing === undefined || candidate.provider < existing.provider) {
      byModel.set(candidate.model, candidate);
    }
  }
  const plan: {
    readonly provider: ProviderName;
    readonly model: string;
    readonly route?: string;
  }[] = [];
  for (const ref of fallbackOrder) {
    const candidate = byModel.get(ref);
    if (candidate === undefined) continue;
    plan.push({
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.route === undefined ? {} : { route: candidate.route }),
    });
  }
  return Object.freeze(plan);
}

function findPriorCandidate(
  candidates: readonly SelectionCandidate[],
  prior: RevalidationInput['priorSelected'],
): SelectionCandidate | undefined {
  return candidates.find(
    (candidate) =>
      candidate.provider === prior.provider &&
      candidate.model === prior.model &&
      candidate.route === prior.route,
  );
}

/**
 * A pure, synchronous function of `request` and `options`'s recorded
 * inputs. See this module's top-level documentation for the full design.
 */
export function select(request: SelectionRequest, options: SelectOptions): SelectionPlan {
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const now = options.now ?? (() => runtime.clock.nowISO());
  const newPlanId = options.newPlanId ?? (() => runtime.identifiers.next('selection-plan'));
  const selectorRevision = options.selectorRevision ?? 1;
  const createdAt = now();
  const planId = newPlanId();

  const common = {
    planId,
    request,
    catalogRevision: request.catalogRevision,
    policyRevision: request.policyRevision,
    selectorRevision,
    ...(options.configurationRevision === undefined
      ? {}
      : { configurationRevision: options.configurationRevision }),
    createdAt,
  };

  function terminal(
    outcome: Exclude<SelectionOutcomeKind, 'selected'>,
    candidates: readonly SelectionCandidate[],
    failure: SelectionOutcomeFailure,
  ): SelectionPlan {
    return Object.freeze({
      ...common,
      candidates: Object.freeze(candidates),
      fallbackPlan: Object.freeze([]),
      outcome,
      failure,
    });
  }

  // Sanitized once, used by both the stale-catalog branch and normal
  // selection below, so an effort-only `options.user.exactOverride` never
  // reaches `composePolicy`'s override path in either — see
  // `buildExactOverride`'s documentation.
  const exactOverride = buildExactOverride(request, options.user);
  const usingExactOverride = exactOverride !== undefined;
  const sanitizedUser =
    exactOverride === options.user?.exactOverride
      ? options.user
      : { ...options.user, exactOverride };

  // ── stale-catalog: a plan-level outcome that marks EVERY candidate
  // without excluding any (policy.ts's own comment on SelectionExclusionCode)
  // — including one a real provider/model exactOverride would otherwise
  // narrow composePolicy down to. So this branch always enumerates the full
  // descriptor set: `exactOverride` is dropped here even when it names a
  // real provider/model, never merely sanitized of an effort-only value.
  if (options.catalog.stale) {
    const policyCandidates = composePolicy({
      descriptors: options.catalog.descriptors,
      deployment: options.deployment,
      bureau: options.bureau,
      agent: options.agent,
      delegated: options.delegated,
      user: { ...options.user, exactOverride: undefined },
    });
    const candidates = policyCandidates.map((candidate) => toSelectionCandidate(candidate));
    return terminal('stale-catalog', candidates, {
      kind: 'stale-catalog',
      reason: `catalog revision ${options.catalog.revision} is stale`,
    });
  }

  const policyCandidates = composePolicy({
    descriptors: options.catalog.descriptors,
    deployment: options.deployment,
    bureau: options.bureau,
    agent: options.agent,
    delegated: options.delegated,
    user: sanitizedUser,
  });

  if (usingExactOverride) {
    if (policyCandidates.length === 0) {
      return terminal('no-candidate', [], {
        kind: 'no-candidate',
        reason: 'no descriptor matches the exact override',
      });
    }
    // composePolicy's exactOverride path never returns more than one
    // candidate; `policyCandidates.length === 0` was already handled above.
    const only = policyCandidates[0]!;
    if (!only.eligible) {
      const candidate = toSelectionCandidate(only);
      return terminal('exact-override-rejected', [candidate], {
        kind: 'exact-override-rejected',
        reason: candidate.exclusionReason ?? 'exact override rejected',
        exclusionCode: candidate.exclusionCode,
        rejectedOverride: toRejectedOverride(request),
      });
    }
  }

  // ── Effort compatibility, applied within the already-eligible set.
  const requested = requestedEffort(request, options);
  const effortMode = options.user?.effortFallbackMode ?? 'reject';

  const candidates: SelectionCandidate[] = policyCandidates.map((policyCandidate) => {
    if (!policyCandidate.eligible) return toSelectionCandidate(policyCandidate);
    if (requested === undefined) return toSelectionCandidate(policyCandidate);
    const verdict = evaluateEffort(policyCandidate.descriptor, requested, effortMode);
    return toSelectionCandidate(policyCandidate, {
      eligible: verdict.eligible,
      exclusionCode: verdict.exclusionCode,
      exclusionReason: verdict.exclusionReason,
      effort: verdict.effort,
    });
  });

  const finalEligible = candidates.filter((candidate) => candidate.eligible);
  const rankingInputsByKey = buildRankingInputs(
    finalEligible.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      descriptor: candidate.descriptorSnapshot,
    })),
    options.agent,
  );
  const enrichedByKey = new Map(
    finalEligible.map((candidate) => {
      const inputs = rankingInputsByKey.get(candidateKey(candidate.provider, candidate.model));
      const enriched =
        inputs === undefined ? candidate : Object.freeze({ ...candidate, rankingInputs: inputs });
      return [candidateKey(candidate.provider, candidate.model), enriched] as const;
    }),
  );
  // `candidates` reassigned in place: every eligible entry now carries its
  // `rankingInputs`; ineligible entries are untouched.
  const annotated = candidates.map(
    (candidate) =>
      enrichedByKey.get(candidateKey(candidate.provider, candidate.model)) ?? candidate,
  );
  const eligibleCandidates = annotated.filter((candidate) => candidate.eligible);

  // ── revalidation, when the caller supplies a prior selection.
  if (options.revalidate !== undefined) {
    const prior = options.revalidate;
    const priorCandidate = findPriorCandidate(annotated, prior.priorSelected);
    const priorGone = priorCandidate === undefined || !priorCandidate.eligible;

    if (prior.priorCatalogRevision !== request.catalogRevision && priorGone) {
      return terminal('capability-changed', annotated, {
        kind: 'capability-changed',
        reason: `${prior.priorSelected.provider}/${prior.priorSelected.model} is no longer an eligible candidate under catalog revision ${request.catalogRevision}`,
        exclusionCode: priorCandidate?.exclusionCode,
      });
    }
    if (prior.priorPolicyRevision !== request.policyRevision && priorGone) {
      return terminal('policy-changed', annotated, {
        kind: 'policy-changed',
        reason: `${prior.priorSelected.provider}/${prior.priorSelected.model} is no longer an eligible candidate under policy revision ${request.policyRevision}`,
        exclusionCode: priorCandidate?.exclusionCode,
      });
    }
  }

  if (eligibleCandidates.length === 0) {
    return terminal('no-candidate', annotated, {
      kind: 'no-candidate',
      reason: 'no eligible candidate remains after filtering',
      exclusionCode: sharedExclusionCode(annotated),
    });
  }

  const sorted = [...eligibleCandidates].sort((a, b) => {
    const scoreA = rankingScore(
      a.rankingInputs ?? {},
      options.user?.costPreference,
      options.user?.latencyPreference,
    );
    const scoreB = rankingScore(
      b.rankingInputs ?? {},
      options.user?.costPreference,
      options.user?.latencyPreference,
    );
    if (scoreA !== scoreB) return scoreB - scoreA;
    // Compare the (provider, model) tuple field-by-field rather than via a
    // joined `candidateKey` string: a delimiter-joined comparison is only
    // equivalent to tuple order when the delimiter sorts below every
    // character a provider name can contain, which is not a guarantee this
    // module should depend on (e.g. a provider name that is a prefix of
    // another would otherwise invert the documented lexicographic order).
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if (a.model !== b.model) return a.model < b.model ? -1 : 1;
    return 0;
  });

  const winner = sorted[0]!;
  const winnerEffort =
    requested === undefined
      ? undefined
      : evaluateEffort(winner.descriptorSnapshot, requested, effortMode).effort;

  const fallbackPlan = buildFallbackPlan(eligibleCandidates, options.user?.fallbackOrder);

  return Object.freeze({
    ...common,
    candidates: Object.freeze(annotated),
    selected: Object.freeze({
      provider: winner.provider,
      model: winner.model,
      ...(winner.route === undefined ? {} : { route: winner.route }),
      ...(winnerEffort === undefined ? {} : { effort: winnerEffort }),
    }),
    fallbackPlan,
    outcome: 'selected',
  });
}

/**
 * Folds a completed generation's actual effective backend into `plan`.
 * Only meaningful against a plan that reached `outcome: 'selected'` — there
 * is no completed response to diverge from otherwise, so `plan` is returned
 * unchanged for every other outcome. `plan.selected` is never rewritten:
 * when `effective.divergedFromPlan` is `true`, a new terminal plan is
 * returned with `outcome: 'provider-effective-divergence'` and the original
 * `selected` retained unchanged alongside it. When
 * `effective.divergedFromPlan` is `false`, `plan` is returned unchanged.
 */
export function recordEffectiveGeneration(
  plan: SelectionPlan,
  effective: EffectiveGenerationResult,
): SelectionPlan {
  if (plan.outcome !== 'selected' || plan.selected === undefined) return plan;
  if (!effective.divergedFromPlan) return plan;

  const diverged: SelectionPlan = {
    ...plan,
    outcome: 'provider-effective-divergence',
    failure: {
      kind: 'provider-effective-divergence',
      reason: `effective backend ${effective.provider}/${effective.model} diverged from the plan's selected ${plan.selected.provider}/${plan.selected.model}`,
    },
  };
  return Object.freeze(diverged);
}

// AgentPreferences is re-exported for callers who only import from this
// module's subpath; policy.ts remains its single defining home.
export type { AgentPreferences };
