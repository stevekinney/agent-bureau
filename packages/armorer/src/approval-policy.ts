import type {
  ToolMetadata,
  ToolPolicyContext,
  ToolPolicyDecision,
  ToolPolicyHooks,
} from './is-tool';

/**
 * What a tool may technically do — the capability axis of the two-axis
 * approval model (AB-22). Fed by declarative tool metadata (armorer's coding
 * toolbox, AB-90) and verb-derived OpenAPI metadata (AB-72) without
 * modification: both already emit `{ readOnly, mutates, dangerous }`.
 *
 * `dangerous` implies capability to do anything up to and including
 * irreversible or sandbox-requiring execution (AB-42: this package only
 * models the contract — it does not bundle a sandbox executor).
 */
export type CapabilityTier = 'read-only' | 'mutating' | 'dangerous';

/**
 * When a human must be asked before a tool call proceeds — the approval axis.
 * Orthogonal to {@link CapabilityTier}: the same tier can be configured to
 * never ask, always ask, ask only when the tier is at least `mutating`, or be
 * denied outright regardless of who's asking.
 */
export type ApprovalMode = 'never' | 'on-mutation' | 'always' | 'deny';

/** The three-way verdict a policy check can produce. */
export type ApprovalStatus = 'allow' | 'ask' | 'deny';

/**
 * Configuration for the two-axis approval policy. `mode` is the fallback
 * approval mode used when a tool's capability tier has no `tierModes`
 * override.
 */
export type ApprovalPolicyConfiguration = {
  /** Approval mode applied when a tool's tier has no explicit override. */
  mode: ApprovalMode;
  /** Per-capability-tier approval mode overrides. */
  tierModes?: Partial<Record<CapabilityTier, ApprovalMode>>;
};

const STATUS_RANK: Record<ApprovalStatus, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * Combines any number of approval verdicts into the single most restrictive
 * one: `deny > ask > allow`. This is the composition rule that lets
 * persona/skill tool policies (`createPolicyEnforcementHook` in `operative`)
 * layer on top of the capability-tier policy without ever being able to
 * loosen it — the combined result can only get stricter, never looser.
 */
export function combineApprovalStatuses(...statuses: readonly ApprovalStatus[]): ApprovalStatus {
  return statuses.reduce<ApprovalStatus>(
    (mostRestrictive, status) =>
      STATUS_RANK[status] > STATUS_RANK[mostRestrictive] ? status : mostRestrictive,
    'allow',
  );
}

/**
 * Resolves a tool's capability tier from its declared metadata (falling back
 * to risk tags such as `dangerous`/`mutating`/`readonly` for tools that only
 * carry tags). Returns `undefined` when the tier cannot be determined —
 * callers must treat that as "unrecognized," never as "read-only."
 */
export function resolveCapabilityTier(
  metadata: ToolMetadata | undefined,
  tags?: readonly string[],
): CapabilityTier | undefined {
  const tagSet = new Set((tags ?? []).map((tag) => tag.toLowerCase()));
  if (metadata?.dangerous === true || tagSet.has('dangerous')) {
    return 'dangerous';
  }
  if (metadata?.mutates === true || tagSet.has('mutating')) {
    return 'mutating';
  }
  if (metadata?.readOnly === true || tagSet.has('readonly') || tagSet.has('read-only')) {
    return 'read-only';
  }
  return undefined;
}

/** Resolves the effective approval mode for a resolved capability tier. */
export function resolveApprovalMode(
  tier: CapabilityTier | undefined,
  configuration: ApprovalPolicyConfiguration,
): ApprovalMode {
  const override = tier ? configuration.tierModes?.[tier] : undefined;
  return override ?? configuration.mode;
}

/**
 * Evaluates the approval status for a resolved tier and mode.
 *
 * Precedence: `deny` mode always denies, regardless of tier. An unrecognized
 * tier always escalates to `ask` — an action armorer can't classify is never
 * silently allowed, even under `mode: 'never'`. Otherwise the mode decides:
 * `never` allows, `always` asks, and `on-mutation` asks for anything at or
 * above the `mutating` tier while allowing `read-only`.
 */
export function evaluateApprovalStatus(
  tier: CapabilityTier | undefined,
  mode: ApprovalMode,
): ApprovalStatus {
  if (mode === 'deny') {
    return 'deny';
  }
  if (!tier) {
    return 'ask';
  }
  switch (mode) {
    case 'never':
      return 'allow';
    case 'always':
      return 'ask';
    case 'on-mutation':
      return tier === 'read-only' ? 'allow' : 'ask';
  }
}

export type CapabilityApprovalContext = {
  metadata?: ToolMetadata;
  tags?: readonly string[];
};

export type CapabilityApprovalResult = {
  tier: CapabilityTier | undefined;
  mode: ApprovalMode;
  status: ApprovalStatus;
};

/**
 * The core two-axis evaluation: resolves a tool's capability tier, its
 * effective approval mode, and the resulting approval status in one call.
 */
export function evaluateCapabilityApproval(
  context: CapabilityApprovalContext,
  configuration: ApprovalPolicyConfiguration,
): CapabilityApprovalResult {
  const tier = resolveCapabilityTier(context.metadata, context.tags);
  const mode = resolveApprovalMode(tier, configuration);
  const status = evaluateApprovalStatus(tier, mode);
  return { tier, mode, status };
}

/** Converts an {@link ApprovalStatus} into a {@link ToolPolicyDecision}. */
export function approvalStatusToDecision(
  toolName: string,
  result: CapabilityApprovalResult,
): ToolPolicyDecision {
  const tierLabel = result.tier ?? 'unrecognized';
  if (result.status === 'allow') {
    return { allow: true, status: 'allow' };
  }
  if (result.status === 'deny') {
    return {
      allow: false,
      status: 'deny',
      reason: `Tool "${toolName}" (${tierLabel} tier) is denied by approval policy (mode: ${result.mode}).`,
    };
  }
  return {
    allow: false,
    status: 'needs_approval',
    reason: `Tool "${toolName}" (${tierLabel} tier) requires approval (mode: ${result.mode}).`,
  };
}

/**
 * Creates a `ToolPolicyHooks.beforeExecute` implementing the two-axis
 * approval model: capability tier (what a tool may technically do) x
 * approval mode (when a human must be asked), with `deny > ask > allow`
 * precedence and unrecognized-tier escalation to `ask`.
 *
 * This is the single documented policy surface for AB-22. Other policy
 * layers — persona/skill tool policies (`operative`'s
 * `createPolicyEnforcementHook`), per-tool `policy.beforeExecute` hooks —
 * compose with it rather than bypass it: `armorer`'s toolbox always
 * evaluates this hook (when an `approvalPolicy` is configured) before any
 * registry- or tool-level hook runs, so nothing layered on top can grant
 * what the capability tier denies.
 */
export function createApprovalPolicyHooks(
  configuration: ApprovalPolicyConfiguration,
): ToolPolicyHooks {
  return {
    beforeExecute(context: ToolPolicyContext): ToolPolicyDecision {
      const result = evaluateCapabilityApproval(context, configuration);
      return approvalStatusToDecision(context.toolName, result);
    },
  };
}
