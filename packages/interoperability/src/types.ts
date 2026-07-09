// ── Tool Policy ──────────────────────────────────────────────────────

/**
 * Reusable allow/deny list for tool and skill filtering.
 * Used by persona tool policies, persona skill policies, and skill tool policies.
 * Deny always wins over allow.
 */
export interface ToolPolicy {
  /** If set, ONLY these are available. */
  allowList?: string[];
  /** These are never available, even if in the allowList. Deny wins. */
  denyList?: string[];
}

// ── JSON Types ────────────────────────────────────────────────────────

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | ReadonlyArray<JSONValue> | { [key: string]: JSONValue };

export type ToolErrorCategory =
  | 'validation'
  | 'permission'
  | 'not_found'
  | 'unavailable'
  | 'conflict'
  | 'transient'
  | 'timeout'
  | 'cancelled'
  | 'internal';

export interface ToolError {
  code: string;
  category: ToolErrorCategory;
  retryable: boolean;
  message: string;
  details?: JSONValue | undefined;
}

export interface ToolErrorInput {
  code: string;
  category: ToolErrorCategory;
  retryable: boolean;
  message: string;
  details?: unknown;
}

export interface ToolAction {
  type: 'approval' | 'input';
  message?: string | undefined;
  schema?: JSONValue | undefined;
}

export interface ToolActionInput {
  type: 'approval' | 'input';
  message?: string | undefined;
  schema?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JSONValue;
}

export interface ToolCallInput {
  id?: string | undefined;
  name: string;
  arguments?: unknown;
}

export interface ToolResult {
  callId: string;
  outcome: 'success' | 'error' | 'action_required';
  content: JSONValue;
  error?: ToolError | undefined;
  action?: ToolAction | undefined;
  inputDigest?: string | undefined;
  outputDigest?: string | undefined;
}

export interface ToolResultInput {
  callId: string;
  outcome: 'success' | 'error' | 'action_required';
  content: unknown;
  error?: ToolErrorInput | undefined;
  action?: ToolActionInput | undefined;
  inputDigest?: string | undefined;
  outputDigest?: string | undefined;
  result?: unknown;
  stream?: AsyncIterable<unknown> | undefined;
}
