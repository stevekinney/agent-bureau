import type { ToolResult } from '../types';

/**
 * Returns a shallow copy of a tool result.
 */
export function copyToolResult(toolResult: ToolResult): ToolResult {
  return { ...toolResult };
}

/**
 * Redacts tool result payload fields while preserving the original shape.
 */
export function redactToolResult(
  toolResult: ToolResult,
  placeholder: string,
): ToolResult {
  return { ...toolResult, content: placeholder };
}
