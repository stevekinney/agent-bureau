import type {
  ToolError as SharedToolError,
  ToolErrorCategory as SharedToolErrorCategory,
} from 'interoperability';

export type ToolErrorCategory = SharedToolErrorCategory;
export type ToolError = SharedToolError;

export function isToolError(value: unknown): value is ToolError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as ToolError;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.category === 'string' &&
    typeof candidate.retryable === 'boolean' &&
    typeof candidate.message === 'string'
  );
}
