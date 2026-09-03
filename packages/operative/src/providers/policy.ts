/**
 * The five-layer model policy precedence composition (AB-64's decision
 * record, implemented by AB-248).
 *
 * Five layers — deployment invariants, Bureau invariants, Agent
 * requirements and preferences, delegated authority, and user constraints
 * and preferences — apply top to bottom over a fixed set of
 * `BackendDescriptor`s. Each layer's candidate set is the intersection of
 * its rules with what the layer above allowed: a layer can narrow what it
 * inherited but can never widen it. The first layer to exclude a candidate
 * owns that candidate's `exclusionCode`; no later layer overwrites it.
 *
 * `composePolicy` is pure, synchronous, and reads no clock: it performs no
 * input or output, and its result depends only on its argument's object
 * graph. Out of scope here: ranking, tie-breaking, and the `SelectionPlan`
 * itself (AB-66's `SelectionCandidate`, `SelectionPlan`, and the
 * `select()` function are a separate, later module); Bureau wiring and
 * boundary revalidation; cross-mode replay fixtures; and `DelegatedAuthority`'s
 * grant shape, signing, or budgets (AB-52), which this module consumes only
 * as an opaque narrowing input per AB-64's decision record.
 */

import type { AgentPreferences } from '../generation-profile.ts';
import type { BackendDescriptor } from './model-catalog.ts';
import type { Effort, ProviderName } from './types.ts';

export type { AgentPreferences };

/**
 * The deployment-invariants layer — the first and most authoritative
 * narrowing layer. Nothing below it may re-admit a candidate it denies.
 */
export interface DeploymentInvariants {
  readonly deniedProviders?: readonly ProviderName[];
  readonly deniedModels?: readonly string[];
  readonly deniedRoutes?: readonly string[];
  readonly deniedRegions?: readonly string[];
  readonly requireDataPolicy?: 'no-retention' | 'zero-day-retention' | 'standard';
}

/**
 * The Bureau-invariants layer. May add denials of its own; may never
 * remove a deployment denial — this module enforces that structurally by
 * only ever evaluating this layer against candidates the deployment layer
 * has not already excluded.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- AB-64's decision record fixes this as a bare re-declaration of DeploymentInvariants's shape, distinguished only by its position in the layer order.
export interface BureauInvariants extends DeploymentInvariants {}

/**
 * The delegated-authority layer — AB-52's not-yet-decided grant, consumed
 * here only as an opaque narrowing input. Narrows by omission: an absent
 * `grantedProviders`/`grantedModels` array narrows nothing, a present one
 * excludes everything it does not name. `policyVersion` is copied into
 * every exclusion this layer produces so a child's attenuation is
 * traceable to the grant that caused it.
 */
export interface DelegatedAuthority {
  readonly grantedProviders?: readonly ProviderName[];
  readonly grantedModels?: readonly string[];
  readonly maximumEffort?: Effort;
  readonly policyVersion: string;
}

/**
 * The user constraints and preferences layer — the last narrowing layer
 * before the provider's effective response. Allow lists narrow by
 * inclusion (present and not naming a candidate excludes it); deny lists
 * narrow by exclusion; both are absent-means-no-op.
 */
export interface UserModelConfiguration {
  readonly allowedProviders?: readonly ProviderName[];
  readonly deniedProviders?: readonly ProviderName[];
  readonly allowedModels?: readonly string[];
  readonly deniedModels?: readonly string[];
  readonly allowedRoutes?: readonly string[];
  readonly deniedRoutes?: readonly string[];
  readonly allowedRegions?: readonly string[];
  readonly deniedRegions?: readonly string[];
  readonly dataPolicy?: 'no-retention' | 'zero-day-retention' | 'standard';
  readonly defaultEffort?: Effort;
  readonly exactOverride?: {
    readonly provider?: ProviderName;
    readonly model?: string;
    readonly route?: string;
    readonly effort?: Effort;
  };
  readonly costPreference?: 'lowest-cost' | 'balanced' | 'no-preference';
  readonly latencyPreference?: 'lowest-latency' | 'balanced' | 'no-preference';
  readonly fallbackOrder?: readonly string[];
  readonly effortFallbackMode?: 'reject' | 'degrade';
}

/**
 * Every way a candidate can be excluded, verbatim from AB-64's `##
 * Selector and selection plan (AC5, AC6, AC7)` section. `composePolicy`
 * itself only ever produces `unavailable`, `unhealthy`,
 * `denied-by-deployment`, `denied-by-bureau`, `missing-required-capability`,
 * `exceeds-delegated-authority`, and `denied-by-user`: `incompatible-modality`
 * and `incompatible-effort` are AB-66's compatibility layer, and
 * `stale-catalog` is a plan-level outcome (a catalog's `stale` flag marks
 * every candidate without excluding any) that AB-66's selector, not this
 * module, turns into an outcome. The union is reused here rather than
 * redeclared so both modules always agree on it.
 */
export type SelectionExclusionCode =
  | 'denied-by-deployment'
  | 'denied-by-bureau'
  | 'missing-required-capability'
  | 'exceeds-delegated-authority'
  | 'denied-by-user'
  | 'incompatible-modality'
  | 'incompatible-effort'
  | 'unavailable'
  | 'unhealthy'
  | 'stale-catalog';

/** One evaluated candidate: an input descriptor plus its policy verdict. */
export interface PolicyCandidate {
  readonly provider: ProviderName;
  readonly model: string;
  readonly route?: string;
  readonly descriptor: BackendDescriptor;
  readonly eligible: boolean;
  readonly exclusionCode?: SelectionExclusionCode;
  readonly exclusionReason?: string;
}

/** `composePolicy`'s input: a fixed descriptor set plus the five layers, each optional. */
export interface ComposePolicyInput {
  readonly descriptors: readonly BackendDescriptor[];
  readonly deployment?: DeploymentInvariants;
  readonly bureau?: BureauInvariants;
  readonly agent?: AgentPreferences;
  readonly delegated?: DelegatedAuthority;
  readonly user?: UserModelConfiguration;
}

const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function effortRank(effort: Effort): number {
  return EFFORT_ORDER.indexOf(effort);
}

/** The highest effort tier `descriptor` portably supports, or `undefined` if none. */
function highestPortableEffort(descriptor: BackendDescriptor): Effort | undefined {
  let highest: Effort | undefined;
  for (const tier of descriptor.effort.portable) {
    if (highest === undefined || effortRank(tier) > effortRank(highest)) highest = tier;
  }
  return highest;
}

/** A required capability is "present" when the descriptor's field for it is non-empty/truthy. */
function hasCapability(descriptor: BackendDescriptor, key: keyof BackendDescriptor): boolean {
  const value = descriptor[key];
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

interface Verdict {
  readonly eligible: boolean;
  readonly exclusionCode?: SelectionExclusionCode;
  readonly exclusionReason?: string;
}

const ELIGIBLE: Verdict = Object.freeze({ eligible: true });

/**
 * Applies one denied/allowed pair of a `readonly T[] | undefined` narrowing
 * rule against `value`. A present `denied` list excludes `value` when
 * named; an absent one narrows nothing. A present `allowed` list excludes
 * everything not named in it — including a candidate with no `value` to
 * compare, since this layer has nothing to admit it by; an absent one
 * narrows nothing.
 */
function narrowedByList<T>(
  value: T | undefined,
  denied: readonly T[] | undefined,
  allowed: readonly T[] | undefined,
): boolean {
  if (denied !== undefined && value !== undefined && denied.includes(value)) return true;
  if (allowed !== undefined && (value === undefined || !allowed.includes(value))) return true;
  return false;
}

/** The deployment/Bureau invariants layer, shared by both since `BureauInvariants` reuses the same shape. */
function evaluateInvariants(
  descriptor: BackendDescriptor,
  invariants: DeploymentInvariants | undefined,
  code: 'denied-by-deployment' | 'denied-by-bureau',
): Verdict {
  if (invariants === undefined) return ELIGIBLE;
  if (narrowedByList(descriptor.provider, invariants.deniedProviders, undefined)) {
    return {
      eligible: false,
      exclusionCode: code,
      exclusionReason: `provider denied: ${descriptor.provider}`,
    };
  }
  if (narrowedByList(descriptor.model, invariants.deniedModels, undefined)) {
    return {
      eligible: false,
      exclusionCode: code,
      exclusionReason: `model denied: ${descriptor.model}`,
    };
  }
  // `route` and `region` are not fields BackendDescriptor carries yet, so a
  // denied-routes/denied-regions rule has nothing to compare against and
  // narrows nothing at this layer. `requireDataPolicy` is the same: no
  // per-descriptor data-policy field exists to check it against.
  return ELIGIBLE;
}

/** The Agent requirements-and-preferences layer: expresses needs, never denials. */
function evaluateAgent(
  descriptor: BackendDescriptor,
  agent: AgentPreferences | undefined,
): Verdict {
  if (agent === undefined) return ELIGIBLE;
  for (const capability of agent.requiredCapabilities ?? []) {
    if (!hasCapability(descriptor, capability)) {
      return {
        eligible: false,
        exclusionCode: 'missing-required-capability',
        exclusionReason: `missing required capability: ${String(capability)}`,
      };
    }
  }
  if (
    agent.minimumContextWindowTokens !== undefined &&
    descriptor.contextWindowTokens < agent.minimumContextWindowTokens
  ) {
    return {
      eligible: false,
      exclusionCode: 'missing-required-capability',
      exclusionReason: `contextWindowTokens ${descriptor.contextWindowTokens} below minimum ${agent.minimumContextWindowTokens}`,
    };
  }
  // `preferredProviders`, `preferredModels` exclude nothing: carried
  // through untouched for the selector's ranking, not this layer's job.
  return ELIGIBLE;
}

/** The delegated-authority layer: narrows by omission, `policyVersion` traceable in the reason. */
function evaluateDelegated(
  descriptor: BackendDescriptor,
  delegated: DelegatedAuthority | undefined,
): Verdict {
  if (delegated === undefined) return ELIGIBLE;
  const tag = `policyVersion=${delegated.policyVersion}`;
  if (narrowedByList(descriptor.provider, undefined, delegated.grantedProviders)) {
    return {
      eligible: false,
      exclusionCode: 'exceeds-delegated-authority',
      exclusionReason: `${tag}: provider not granted: ${descriptor.provider}`,
    };
  }
  if (narrowedByList(descriptor.model, undefined, delegated.grantedModels)) {
    return {
      eligible: false,
      exclusionCode: 'exceeds-delegated-authority',
      exclusionReason: `${tag}: model not granted: ${descriptor.model}`,
    };
  }
  if (delegated.maximumEffort !== undefined) {
    const highest = highestPortableEffort(descriptor);
    if (highest === undefined || effortRank(delegated.maximumEffort) > effortRank(highest)) {
      return {
        eligible: false,
        exclusionCode: 'exceeds-delegated-authority',
        exclusionReason: `${tag}: maximumEffort ${delegated.maximumEffort} exceeds supported tier ${highest ?? 'none'}`,
      };
    }
  }
  return ELIGIBLE;
}

/** The user constraints-and-preferences layer's general allow/deny checks (not `exactOverride`, handled separately). */
function evaluateUser(
  descriptor: BackendDescriptor,
  user: UserModelConfiguration | undefined,
): Verdict {
  if (user === undefined) return ELIGIBLE;
  if (narrowedByList(descriptor.provider, user.deniedProviders, user.allowedProviders)) {
    return {
      eligible: false,
      exclusionCode: 'denied-by-user',
      exclusionReason: `provider not permitted: ${descriptor.provider}`,
    };
  }
  if (narrowedByList(descriptor.model, user.deniedModels, user.allowedModels)) {
    return {
      eligible: false,
      exclusionCode: 'denied-by-user',
      exclusionReason: `model not permitted: ${descriptor.model}`,
    };
  }
  // `route` and `region` are not fields BackendDescriptor carries yet, so
  // there is nothing to name in an `allowed*` list — an absent list still
  // narrows nothing, but a present one excludes every candidate, since none
  // can ever be named in it. `deniedRoutes`/`deniedRegions` stay effective
  // no-ops: `undefined` can never appear in a `denied*` list. `dataPolicy`
  // has the same no-op treatment as `requireDataPolicy` above — no
  // per-descriptor data-policy field exists yet to check it against.
  if (narrowedByList(undefined, user.deniedRoutes, user.allowedRoutes)) {
    return {
      eligible: false,
      exclusionCode: 'denied-by-user',
      exclusionReason: 'route not permitted',
    };
  }
  if (narrowedByList(undefined, user.deniedRegions, user.allowedRegions)) {
    return {
      eligible: false,
      exclusionCode: 'denied-by-user',
      exclusionReason: 'region not permitted',
    };
  }
  return ELIGIBLE;
}

/** Availability/health: "known, and reachable now" — evaluated before any policy layer. */
function evaluateAvailability(descriptor: BackendDescriptor): Verdict {
  if (descriptor.availability === 'unavailable') {
    return {
      eligible: false,
      exclusionCode: 'unavailable',
      exclusionReason: 'descriptor availability: unavailable',
    };
  }
  if (descriptor.health === 'unhealthy') {
    return {
      eligible: false,
      exclusionCode: 'unhealthy',
      exclusionReason: 'descriptor health: unhealthy',
    };
  }
  return ELIGIBLE;
}

/**
 * Runs `descriptor` through the deployment, Bureau, Agent, and delegated
 * layers (in that order), stopping at the first exclusion. Shared by the
 * normal per-descriptor evaluation and by `exactOverride` resolution,
 * which checks an override against exactly these four layers before the
 * user layer is even considered.
 */
function evaluateThroughDelegated(
  descriptor: BackendDescriptor,
  input: ComposePolicyInput,
): Verdict {
  const availability = evaluateAvailability(descriptor);
  if (!availability.eligible) return availability;

  const deployment = evaluateInvariants(descriptor, input.deployment, 'denied-by-deployment');
  if (!deployment.eligible) return deployment;

  const bureau = evaluateInvariants(descriptor, input.bureau, 'denied-by-bureau');
  if (!bureau.eligible) return bureau;

  const agent = evaluateAgent(descriptor, input.agent);
  if (!agent.eligible) return agent;

  return evaluateDelegated(descriptor, input.delegated);
}

function toCandidate(descriptor: BackendDescriptor, verdict: Verdict): PolicyCandidate {
  return Object.freeze({
    provider: descriptor.provider,
    model: descriptor.model,
    descriptor,
    eligible: verdict.eligible,
    ...(verdict.exclusionCode === undefined ? {} : { exclusionCode: verdict.exclusionCode }),
    ...(verdict.exclusionReason === undefined ? {} : { exclusionReason: verdict.exclusionReason }),
  });
}

function matchesOverride(
  descriptor: BackendDescriptor,
  override: NonNullable<UserModelConfiguration['exactOverride']>,
): boolean {
  // An "exact" override must name exactly one descriptor: provider and
  // model are both required to identify it unambiguously. A partially
  // specified override (e.g. only `effort`, or only `provider`) cannot
  // resolve to one candidate, so it matches nothing.
  if (override.provider === undefined || override.model === undefined) return false;
  if (descriptor.provider !== override.provider) return false;
  if (descriptor.model !== override.model) return false;
  // `route` is not a field BackendDescriptor carries: an override naming a
  // route can never match a descriptor on that basis.
  if (override.route !== undefined) return false;
  return true;
}

/**
 * Composes the five precedence layers over `input.descriptors`, in order:
 * deployment invariants, Bureau invariants, Agent requirements and
 * preferences, delegated authority, and user constraints and preferences.
 * Pure and synchronous: no input/output, no clock read.
 *
 * Without `input.user.exactOverride`, returns one frozen `PolicyCandidate`
 * per input descriptor, in input order — never dropping a candidate
 * silently.
 *
 * With `input.user.exactOverride`, the override is checked only against
 * the four layers above the user's (deployment, Bureau, Agent, delegated)
 * before being honored: a rejected override yields a single-candidate
 * result carrying the denying layer's own exclusion code, never
 * `denied-by-user`. An override must name both `provider` and `model` to
 * identify exactly one descriptor — a partially specified override (only
 * `route`, or only `effort`) cannot resolve to a single candidate and
 * yields an empty result, as does one naming no matching descriptor. Input
 * order is the tie-break if `descriptors` ever contains more than one row
 * for the same `(provider, model)` pair — at most one candidate is ever
 * returned.
 */
export function composePolicy(input: ComposePolicyInput): readonly PolicyCandidate[] {
  const override = input.user?.exactOverride;

  if (override === undefined) {
    return Object.freeze(
      input.descriptors.map((descriptor) => {
        const verdict = evaluateThroughDelegated(descriptor, input);
        const resolved = verdict.eligible ? evaluateUser(descriptor, input.user) : verdict;
        return toCandidate(descriptor, resolved);
      }),
    );
  }

  const matched = input.descriptors.find((descriptor) => matchesOverride(descriptor, override));
  if (matched === undefined) return Object.freeze([]);
  return Object.freeze([toCandidate(matched, evaluateThroughDelegated(matched, input))]);
}
