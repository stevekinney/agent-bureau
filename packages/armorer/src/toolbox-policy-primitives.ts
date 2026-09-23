import type { ToolRequestContext } from './execution-context';
import type { ToolPolicyContext } from './is-tool';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isToolRequestContext(value: unknown): value is ToolRequestContext {
  if (!isRecord(value) || !isRecord(value['authority'])) return false;
  const authority = value['authority'];
  return (
    typeof authority['principalId'] === 'string' &&
    typeof authority['tenantId'] === 'string' &&
    typeof authority['ownerId'] === 'string' &&
    typeof authority['authorizationRevision'] === 'string' &&
    isStringArray(authority['capabilities'])
  );
}

export function readPolicyRequestContext(
  context: ToolPolicyContext,
): ToolRequestContext | undefined {
  const requestContext = context.policyContext?.['requestContext'];
  return isToolRequestContext(requestContext) ? requestContext : undefined;
}
