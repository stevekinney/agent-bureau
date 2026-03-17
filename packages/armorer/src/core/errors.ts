import type { JsonValue } from './serialization/json';

export type ToolErrorCategory =
  | 'validation'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'transient'
  | 'timeout'
  | 'cancelled'
  | 'internal';

export type ToolError = {
  code: string;
  category: ToolErrorCategory;
  retryable: boolean;
  message: string;
  details?: JsonValue;
};

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
