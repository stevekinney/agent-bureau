import { createToolbox } from 'armorer';

import type { GenerateContext } from '../types';
import type { RetryMutator } from './types';

const TOOL_NAME_PATTERNS = [
  /Tool "([^"]+)"/,
  /tool[_ ](?:name|called)[:\s]+"?([^\s"]+)"?/i,
  /tool '([^']+)'/,
];

function extractToolName(error: unknown): string | undefined {
  // Check for explicit toolName or tool_name properties
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record['toolName'] === 'string') return record['toolName'];
    if (typeof record['tool_name'] === 'string') return record['tool_name'];
  }

  // Fall back to pattern matching on the error message
  const message = error instanceof Error ? error.message : String(error);
  for (const pattern of TOOL_NAME_PATTERNS) {
    const match = pattern.exec(message);
    if (match?.[1]) return match[1];
  }

  return undefined;
}

/**
 * Creates a retry mutator that removes a failing tool from the toolbox.
 *
 * When the error identifies a specific tool (via a `toolName` property,
 * `tool_name` property, or a recognizable pattern in the error message),
 * the mutator returns a new context with that tool excluded. The original
 * toolbox is never modified.
 */
export function createToolRemovalMutator(): RetryMutator {
  return (context: GenerateContext, error: unknown, _attempt: number) => {
    const toolName = extractToolName(error);
    if (!toolName) return;

    const existingTool = context.toolbox.getTool(toolName);
    if (!existingTool) return;

    const remainingTools = context.toolbox.tools().filter((t) => t.name !== toolName);
    const newToolbox = createToolbox(remainingTools);

    return {
      ...context,
      toolbox: newToolbox,
    };
  };
}
