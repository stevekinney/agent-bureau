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

/**
 * A JSON array, expressed as a named interface (rather than an inline
 * `ReadonlyArray<JSONValue>`) so TypeScript can cache instantiations by
 * type identity. Consumers that run `JSONValue` through another recursive
 * generic — e.g. Svelte 5's `$state.Snapshot<T>` mapped type — hit
 * TS2589 ("Type instantiation is excessively deep and possibly infinite")
 * when the recursive branches are anonymous; naming them breaks the
 * compound recursion. See conversationalist#245.
 *
 * The interface has no members of its own — that's the point. A plain
 * `type JSONArray = ReadonlyArray<JSONValue>` alias reintroduces the
 * TS2589 failure (verified empirically), because a type alias is
 * structurally inlined at each recursive reference while a named
 * interface has a stable identity TypeScript's instantiation cache can
 * key on.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface JSONArray extends ReadonlyArray<JSONValue> {}

/**
 * A JSON object, expressed as a named interface for the same reason as
 * {@link JSONArray}.
 */
export interface JSONObject {
  [key: string]: JSONValue;
}

export type JSONValue = JSONPrimitive | JSONArray | JSONObject;

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
