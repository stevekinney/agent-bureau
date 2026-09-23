import type { ToolConfiguration, ToolMetadata, ToolPolicyContext } from '../is-tool';
import type { ToolCall } from '../types';

export function buildToolPolicyContext(input: {
  configuration: ToolConfiguration;
  inputDigest: string | undefined;
  metadataValue: ToolMetadata | undefined;
  name: string;
  normalizedTags: readonly string[];
  params: unknown;
  toolCall: ToolCall;
}): ToolPolicyContext {
  const context: ToolPolicyContext = {
    toolName: input.name,
    toolCall: input.toolCall,
    params: input.params,
    configuration: input.configuration,
  };
  if (input.inputDigest !== undefined) context.inputDigest = input.inputDigest;
  if (input.normalizedTags.length) context.tags = input.normalizedTags;
  if (input.metadataValue !== undefined) context.metadata = input.metadataValue;
  return context;
}
