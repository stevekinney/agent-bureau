import type { ToolExecutionIdentity } from '../event-types';
import { freezeToolRequestContext, type ToolRequestContext } from '../execution-context';
import {
  resolveToolPolicyAllow,
  type MinimalAbortSignal,
  type ToolPolicyAfterContext,
  type ToolPolicyContext,
  type ToolPolicyDecision,
} from '../is-tool';
import { isAbortRejection, racePreExecution } from './cancellation';

type Emit = (type: string, detail: unknown) => boolean;

export async function resolvePolicyDecision(
  hooksBeforeExecute:
    | ((
        context: ToolPolicyContext,
      ) => ToolPolicyDecision | boolean | void | Promise<ToolPolicyDecision | boolean | void>)
    | undefined,
  context: ToolPolicyContext,
  signal?: MinimalAbortSignal,
): Promise<ToolPolicyDecision | undefined> {
  if (!hooksBeforeExecute) return undefined;
  const decision = await racePreExecution(() => hooksBeforeExecute(context), signal);
  if (decision === undefined) return undefined;
  return typeof decision === 'boolean' ? { allow: decision } : resolveToolPolicyAllow(decision);
}

export function attachRequestContextPolicyFacts(
  context: ToolPolicyContext,
  requestContext: ToolRequestContext | undefined,
): void {
  if (!requestContext) return;
  const frozenRequestContext = freezeToolRequestContext(requestContext);
  context.policyContext = {
    ...context.policyContext,
    requestContext: frozenRequestContext,
    capabilities: frozenRequestContext.authority.capabilities,
  };
}

export async function runPolicyAfter(
  afterExecute: ((context: ToolPolicyAfterContext) => void | Promise<void>) | undefined,
  context: ToolPolicyAfterContext,
  signal: MinimalAbortSignal | undefined,
  identity: ToolExecutionIdentity | undefined,
  emit: Emit,
): Promise<void> {
  if (!afterExecute) return;
  try {
    await racePreExecution(() => afterExecute(context), signal);
  } catch (error) {
    if (isAbortRejection(error)) throw error;
    emit('log', {
      level: 'warn',
      message: 'policy afterExecute failed',
      data: error,
      executionId: identity?.executionId,
      ownerId: identity?.ownerId,
    });
  }
}
