import { type GrantStateStore } from './approval-binding';
import type { ApprovalPolicyConfiguration } from './approval-policy';
import { approvalStatusToDecision, evaluateCapabilityApproval } from './approval-policy';
import { narrowToolAuthority } from './execution-context';
import { policyPauseDecisionsSymbol, policyPauseTierSymbol } from './internal/approval-resume';
import type {
  ToolPolicyContext,
  ToolPolicyContextProvider,
  ToolPolicyDecision,
  ToolPolicyHooks,
} from './is-tool';
import type { GrantUsedDetail } from './toolbox-contracts';
import { findMatchingGrant } from './toolbox-grants';
import { isPausePolicyDecision, resolvePolicyDecision } from './toolbox-policy-decisions';
import { readPolicyRequestContext } from './toolbox-policy-primitives';
import { isDangerousToolContext, isMutatingToolContext } from './toolbox-risk';
export function mergePolicyContexts(
  registryContext?: ToolPolicyContextProvider | Record<string, unknown>,
  toolContext?: ToolPolicyContextProvider,
): ToolPolicyContextProvider | undefined {
  const registryProvider = toPolicyContextProvider(registryContext);
  const toolProvider = toPolicyContextProvider(toolContext);
  if (!registryProvider && !toolProvider) {
    return undefined;
  }
  return async (context) => {
    const base = registryProvider ? await registryProvider(context) : undefined;
    const next = toolProvider ? await toolProvider(context) : undefined;
    return {
      ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}),
      ...(next && typeof next === 'object' && !Array.isArray(next) ? next : {}),
    };
  };
}
export function toPolicyContextProvider(
  input?: ToolPolicyContextProvider | Record<string, unknown>,
): ToolPolicyContextProvider | undefined {
  if (!input) return undefined;
  if (typeof input === 'function') return input;
  if (typeof input === 'object' && !Array.isArray(input)) {
    return () => input;
  }
  return undefined;
}
type PolicyMergeOptions = {
  readOnly: boolean;
  allowMutation: boolean;
  allowDangerous: boolean;
  approvalPolicy?: ApprovalPolicyConfiguration;
  grantStateStore?: GrantStateStore;
  grantSecret?: string;
  grantNow?: () => number;
  grantPolicyRevision?: string;
  onGrantUsed?: (detail: GrantUsedDetail) => void;
};
type PolicyPhaseOptions = Pick<
  PolicyMergeOptions,
  | 'approvalPolicy'
  | 'grantStateStore'
  | 'grantSecret'
  | 'grantNow'
  | 'grantPolicyRevision'
  | 'onGrantUsed'
>;
export function mergePolicies(
  registryPolicy: ToolPolicyHooks | undefined,
  toolPolicy: ToolPolicyHooks | undefined,
  options: PolicyMergeOptions,
): ToolPolicyHooks | undefined {
  const enforceMutating = options.readOnly || !options.allowMutation;
  const enforceDangerous = !options.allowDangerous;
  const hasBefore = hasBeforePolicies(
    enforceMutating,
    enforceDangerous,
    options,
    registryPolicy,
    toolPolicy,
  );
  const hasAfter = Boolean(registryPolicy?.afterExecute || toolPolicy?.afterExecute);
  if (!hasBefore && !hasAfter) return undefined;
  return {
    beforeExecute: (context) =>
      runBeforeExecute(
        context,
        registryPolicy,
        toolPolicy,
        enforceMutating,
        enforceDangerous,
        options,
      ),
    async afterExecute(context) {
      await toolPolicy?.afterExecute?.(context);
      await registryPolicy?.afterExecute?.(context);
    },
  };
}
function hasBeforePolicies(
  enforceMutating: boolean,
  enforceDangerous: boolean,
  options: PolicyMergeOptions,
  registryPolicy: ToolPolicyHooks | undefined,
  toolPolicy: ToolPolicyHooks | undefined,
): boolean {
  return Boolean(
    enforceMutating ||
    enforceDangerous ||
    options.approvalPolicy ||
    registryPolicy?.beforeExecute ||
    toolPolicy?.beforeExecute,
  );
}
async function runBeforeExecute(
  context: ToolPolicyContext,
  registryPolicy: ToolPolicyHooks | undefined,
  toolPolicy: ToolPolicyHooks | undefined,
  enforceMutating: boolean,
  enforceDangerous: boolean,
  options: PolicyMergeOptions,
): Promise<ToolPolicyDecision> {
  const admission = checkBaselineAdmission(context, enforceMutating, enforceDangerous);
  if (admission) return admission;
  const capability = await consumeCapabilityApproval(context, options);
  if (capability.decision) return capability.decision;
  const ordered = await evaluateOrderedPolicies(
    context,
    registryPolicy,
    toolPolicy,
    capability.pauses,
  );
  if (ordered.decision) return ordered.decision;
  return finalizePolicyDecision(ordered.pauses, ordered.capabilities);
}
function checkBaselineAdmission(
  context: ToolPolicyContext,
  enforceMutating: boolean,
  enforceDangerous: boolean,
): ToolPolicyDecision | undefined {
  if (enforceMutating && isMutatingToolContext(context)) {
    return {
      allow: false,
      status: 'deny',
      reason: `Mutating tool "${context.toolName}" is not allowed`,
    };
  }
  if (enforceDangerous && isDangerousToolContext(context)) {
    return {
      allow: false,
      status: 'deny',
      reason: `Dangerous tool "${context.toolName}" is not allowed`,
    };
  }
  return undefined;
}
async function consumeCapabilityApproval(
  context: ToolPolicyContext,
  options: PolicyPhaseOptions,
): Promise<{ decision?: ToolPolicyDecision; pauses: ToolPolicyDecision[] }> {
  if (!options.approvalPolicy) return { pauses: [] };
  const result = evaluateCapabilityApproval(context, options.approvalPolicy);
  if (result.status === 'deny')
    return { decision: approvalStatusToDecision(context.toolName, result), pauses: [] };
  if (result.status !== 'ask') return { pauses: [] };
  const grant = await findGrant(context, options);
  if (grant && options.grantStateStore) {
    await reportGrantUse(context, grant, options);
    return { decision: { allow: true }, pauses: [] };
  }
  return {
    pauses: [
      {
        ...approvalStatusToDecision(context.toolName, result),
        [policyPauseTierSymbol]: 'capability',
      },
    ],
  };
}
async function findGrant(context: ToolPolicyContext, options: PolicyPhaseOptions) {
  if (!options.grantStateStore || !options.grantSecret) return undefined;
  return findMatchingGrant(
    context,
    options.grantStateStore,
    options.grantSecret,
    (options.grantNow ?? Date.now)(),
    options.grantPolicyRevision,
  );
}
async function reportGrantUse(
  context: ToolPolicyContext,
  grant: NonNullable<Awaited<ReturnType<typeof findMatchingGrant>>>,
  options: PolicyPhaseOptions,
): Promise<void> {
  if (!options.grantStateStore) return;
  const { usesRemaining } = await options.grantStateStore.decrementUse(grant.id);
  const requestContext = readPolicyRequestContext(context);
  options.onGrantUsed?.({
    grantId: grant.id,
    toolName: context.toolName,
    call: context.toolCall,
    principalId: grant.principalId,
    usesRemaining,
    ...(requestContext?.runId !== undefined ? { runId: requestContext.runId } : {}),
    ...(requestContext?.agentId !== undefined ? { agentId: requestContext.agentId } : {}),
  });
}

async function evaluateOrderedPolicies(
  context: ToolPolicyContext,
  registryPolicy: ToolPolicyHooks | undefined,
  toolPolicy: ToolPolicyHooks | undefined,
  pauses: ToolPolicyDecision[],
): Promise<{
  pauses: ToolPolicyDecision[];
  capabilities: readonly string[] | undefined;
  decision?: ToolPolicyDecision;
}> {
  const registry = await resolvePolicyDecision(registryPolicy?.beforeExecute, context);
  const registryDecision = appendDecision(pauses, registry, 'registry');
  if (registryDecision)
    return { pauses, capabilities: registry?.capabilities, decision: registryDecision };
  const toolContext = narrowPolicyContext(context, registry?.capabilities);
  const tool = await resolvePolicyDecision(toolPolicy?.beforeExecute, toolContext);
  const toolDecision = appendDecision(pauses, tool, 'tool');
  if (toolDecision) return { pauses, capabilities: tool?.capabilities, decision: toolDecision };
  return {
    pauses,
    capabilities: intersectCapabilities(registry?.capabilities, tool?.capabilities),
  };
}

function narrowPolicyContext(
  context: ToolPolicyContext,
  capabilities: readonly string[] | undefined,
): ToolPolicyContext {
  return capabilities ? withNarrowedPolicyContextCapabilities(context, capabilities) : context;
}

function appendDecision(
  pauses: ToolPolicyDecision[],
  decision: ToolPolicyDecision | undefined,
  tier: 'registry' | 'tool',
): ToolPolicyDecision | undefined {
  if (isPausePolicyDecision(decision)) {
    pauses.push({ ...decision, [policyPauseTierSymbol]: tier });
    return undefined;
  }
  return decision?.allow === false ? decision : undefined;
}

function intersectCapabilities(
  ...sets: Array<readonly string[] | undefined>
): readonly string[] | undefined {
  const present = sets.filter((set): set is readonly string[] => set !== undefined);
  return present.reduce<readonly string[] | undefined>((current, next) => {
    if (!current || current.includes('*')) return [...next];
    if (next.includes('*')) return current;
    return current.filter((capability) => next.includes(capability));
  }, undefined);
}

function finalizePolicyDecision(
  pauses: ToolPolicyDecision[],
  capabilities?: readonly string[],
): ToolPolicyDecision {
  const first = pauses[0];
  if (first)
    return {
      ...first,
      ...(capabilities ? { capabilities } : {}),
      [policyPauseDecisionsSymbol]: pauses,
    };
  return { allow: true, ...(capabilities ? { capabilities } : {}) };
}

export function withNarrowedPolicyContextCapabilities(
  context: ToolPolicyContext,
  capabilities: readonly string[],
): ToolPolicyContext {
  const requestContext = readPolicyRequestContext(context);
  if (!requestContext) {
    return context;
  }
  const narrowedRequestContext = narrowToolAuthority(requestContext, capabilities);
  return {
    ...context,
    policyContext: {
      ...context.policyContext,
      requestContext: narrowedRequestContext,
      capabilities: narrowedRequestContext.authority.capabilities,
    },
  };
}
