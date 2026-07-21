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

// ---------------------------------------------------------------------------
// Headless deny-by-default permission mode (AB-94)
// ---------------------------------------------------------------------------

/**
 * The verdict a synchronous per-call gate returns for a single tool call.
 * Mirrors the shape (not the identity) of Tribunal's `canUseTool` callback:
 * a deny carries a human-readable reason that gets fed back to the model as
 * the tool's error result, rather than thrown or silently swallowed.
 */
export type PermissionGateDecision = { allow: true } | { allow: false; reason: string };

/**
 * A synchronous per-call gate re-checking a tool's name AND its parsed input
 * immediately before execution — Tribunal's `canUseTool` parity. This is
 * deliberately synchronous: unlike `ToolPolicyHooks.beforeExecute` (which may
 * be async for policies that need to await something), a headless gate's
 * entire job is a fast, local check against already-validated arguments
 * (e.g. "does this path escape the jail root?"), so there is nothing to await.
 *
 * This differs from a name-list filter (`ToolPolicy.allowList`/`denyList`,
 * `operative`'s `createPolicyEnforcementHook`): a filter removes a tool from
 * the array before the model ever sees it exists. A gate runs per call
 * against the actual arguments the model chose, so it can catch
 * input-dependent violations a static name list can't express.
 */
export type PermissionGate = (toolName: string, input: unknown) => PermissionGateDecision;

/**
 * Configuration for the headless deny-by-default permission preset (AB-94).
 * Built entirely on the AB-22 two-axis surface (`combineApprovalStatuses`,
 * `evaluateCapabilityApproval`) — this is not a parallel policy system, it's
 * a run-level composition of it plus a name list and a per-call gate, with
 * one behavioral change: `approvalMode` is fixed to headless `'never'` — this
 * run never parks on a human, so anything the capability tier would `ask`
 * about is denied instead.
 *
 * `allowList` field names match `interoperability`'s `ToolPolicy` shape
 * (the same one `operative`'s `createPolicyEnforcementHook` filters tool
 * arrays with) for consistency, but `allowList` is REQUIRED here — unlike a
 * filter, where an absent allowlist just means "don't restrict by name,"
 * deny-by-default is this preset's entire point: any tool name absent from
 * `allowList` is denied outright, not merely hidden from the model.
 */
export type HeadlessPermissionPolicyConfiguration = {
  /** Tool names permitted to run. Any tool name not in this list is denied. */
  allowList: readonly string[];
  /** Tool names always denied, even when also present in `allowList`. */
  denyList?: readonly string[];
  /**
   * Optional capability-tier policy (AB-22) layered on top of the name list.
   * A tier that would normally `ask` is denied instead, since this run is
   * headless.
   */
  capability?: ApprovalPolicyConfiguration;
  /** Optional synchronous per-call gate re-checking parsed input. */
  gate?: PermissionGate;
};

export type HeadlessPermissionResult = {
  status: ApprovalStatus;
  reason?: string;
};

const MAX_REDACTED_REASON_LENGTH = 300;

/**
 * Collapses whitespace and caps length so a gate's denial message can't leak
 * an unbounded, formatting-laden echo of the offending input (e.g. a full
 * stack trace, or a very long path) into the audit trail — the
 * `policy-denied` event this decision's `reason` feeds flows straight into
 * `operative`'s `tool.policy-denied` bubble event and from there into the
 * AB-96 `tool-post` frame's `error` field, which an out-of-process consumer
 * may render directly.
 */
function redactGateReason(reason: string): string {
  const collapsed = reason.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_REDACTED_REASON_LENGTH
    ? `${collapsed.slice(0, MAX_REDACTED_REASON_LENGTH)}…`
    : collapsed;
}

/**
 * Evaluates the headless deny-by-default permission verdict for a single
 * tool call: `deny > ask > allow` precedence (`combineApprovalStatuses`)
 * across three independent axes — the name list, the optional capability
 * tier, and the optional synchronous gate — followed by one headless-only
 * resolution step: a combined `'ask'` (which can only come from the
 * capability tier; the name list and gate are allow/deny-only) becomes
 * `'deny'`, since this run never parks on a human.
 */
export function evaluateHeadlessPermission(
  context: {
    toolName: string;
    params: unknown;
    metadata?: ToolMetadata;
    tags?: readonly string[];
  },
  configuration: HeadlessPermissionPolicyConfiguration,
): HeadlessPermissionResult {
  const { toolName, params, metadata, tags } = context;
  const { allowList, denyList = [], capability, gate } = configuration;

  const isDenied = denyList.includes(toolName);
  const isUnlisted = !allowList.includes(toolName);
  const nameStatus: ApprovalStatus = isDenied || isUnlisted ? 'deny' : 'allow';

  const capabilityResult = capability
    ? evaluateCapabilityApproval({ metadata, tags }, capability)
    : undefined;
  const capabilityStatus: ApprovalStatus = capabilityResult?.status ?? 'allow';

  const gateResult = gate ? gate(toolName, params) : undefined;
  const gateStatus: ApprovalStatus = gateResult && !gateResult.allow ? 'deny' : 'allow';

  const combined = combineApprovalStatuses(nameStatus, capabilityStatus, gateStatus);
  // Headless: approvalMode is fixed to 'never' park-on-human. An 'ask' can
  // only have come from the capability tier (name list and gate are
  // allow/deny-only) — deny instead of parking.
  const status: ApprovalStatus = combined === 'ask' ? 'deny' : combined;

  if (status === 'allow') {
    return { status: 'allow' };
  }

  if (nameStatus === 'deny') {
    const reason = isDenied
      ? `Tool "${toolName}" is on the headless permission policy's deny list.`
      : `Tool "${toolName}" is not on the headless permission policy's allowlist; unlisted tools are denied by default.`;
    return { status: 'deny', reason };
  }

  // The gate is checked ahead of the capability tier for reason attribution
  // (though every axis was already evaluated above for the combined status):
  // it's the most specific, input-derived signal — e.g. "this exact path
  // escapes the jail root" — and must not be masked by a more generic
  // capability-tier message when both axes independently deny the same call.
  if (gateResult && !gateResult.allow) {
    return { status: 'deny', reason: redactGateReason(gateResult.reason) };
  }

  // Name-list and gate denials returned above, so a remaining denial can only
  // come from the capability policy.
  const tierLabel = capabilityResult?.tier ?? 'unrecognized';
  const reason =
    capabilityStatus === 'ask'
      ? `Tool "${toolName}" (${tierLabel} tier) would require human approval, but this run is headless (approvalMode: never) — denying instead of parking.`
      : `Tool "${toolName}" (${tierLabel} tier) is denied by the capability-tier policy (mode: ${capabilityResult?.mode}).`;
  return { status: 'deny', reason };
}

/**
 * Creates a `ToolPolicyHooks.beforeExecute` implementing the headless
 * deny-by-default permission preset (AB-94): explicit tool allowlist/denylist
 * plus an optional capability-tier policy and an optional synchronous
 * per-call gate (`canUseTool` parity), composed with `deny > ask > allow`
 * precedence and headless `ask -> deny` resolution.
 *
 * The returned hook is synchronous — no `Promise` is ever returned — so it
 * composes cleanly as a toolbox's registry-level `policy` alongside (or
 * instead of) the tier-only `approvalPolicy` option. A denial here reaches
 * `create-tool.ts`'s standard deny path: the model receives a tool-error
 * result and the run loop continues — this preset never throws and never
 * parks on `needs_approval`.
 */
export function createHeadlessPermissionPolicyHooks(
  configuration: HeadlessPermissionPolicyConfiguration,
): ToolPolicyHooks {
  return {
    beforeExecute(context: ToolPolicyContext): ToolPolicyDecision {
      const result = evaluateHeadlessPermission(
        {
          toolName: context.toolName,
          params: context.params,
          metadata: context.metadata,
          tags: context.tags,
        },
        configuration,
      );
      if (result.status === 'allow') {
        return { allow: true, status: 'allow' };
      }
      return { allow: false, status: 'deny', reason: result.reason };
    },
  };
}
