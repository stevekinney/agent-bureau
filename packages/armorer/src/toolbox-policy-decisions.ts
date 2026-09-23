import type { ToolPolicyContext, ToolPolicyDecision, ToolPolicyHooks } from './is-tool';
import { resolveToolPolicyAllow } from './is-tool';

export function isPausePolicyDecision(
  decision: ToolPolicyDecision | undefined,
): decision is ToolPolicyDecision & { status: 'needs_approval' | 'needs_input' } {
  return decision?.status === 'needs_approval' || decision?.status === 'needs_input';
}

export async function resolvePolicyDecision(
  hook: ToolPolicyHooks['beforeExecute'] | undefined,
  context: ToolPolicyContext,
): Promise<ToolPolicyDecision | undefined> {
  if (!hook) return undefined;
  const decision = await hook(context);
  if (decision === undefined) return undefined;
  return typeof decision === 'boolean' ? { allow: decision } : resolveToolPolicyAllow(decision);
}
