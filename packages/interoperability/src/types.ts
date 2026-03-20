export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | ReadonlyArray<JSONValue> | { [key: string]: JSONValue };

export type ToolErrorCategory =
  | 'validation'
  | 'permission'
  | 'not_found'
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
