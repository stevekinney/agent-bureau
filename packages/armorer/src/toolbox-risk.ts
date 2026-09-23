import type { ToolPolicyContext } from './is-tool';

export function isMutatingToolContext(context: ToolPolicyContext): boolean {
  const tags = new Set(context.tags?.map((tag) => tag.toLowerCase()) ?? []);
  if (context.metadata?.mutates === true) return true;
  if (context.metadata?.readOnly === true) return false;
  return tags.has('mutating') && !tags.has('readonly') && !tags.has('read-only');
}

export function isDangerousToolContext(context: ToolPolicyContext): boolean {
  return (
    context.metadata?.dangerous === true ||
    (context.tags?.map((tag) => tag.toLowerCase()).includes('dangerous') ?? false)
  );
}
