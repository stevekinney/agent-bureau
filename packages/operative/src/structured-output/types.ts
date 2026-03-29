/**
 * Controls which tools the model is allowed to call on a per-step basis.
 *
 * - `'auto'`: Model decides whether to call tools (default).
 * - `'required'`: Model must call at least one tool.
 * - `'none'`: Model must not call any tools.
 * - `{ tool: string }`: Model must call the specified tool.
 */
export type ToolChoice = 'auto' | 'required' | 'none' | { tool: string };

/**
 * Provider-agnostic response format description, computed by the loop
 * when a `responseSchema` is present. Providers can use this to enable
 * native structured output support.
 *
 * - `{ type: 'text' }`: Free-form text (default).
 * - `{ type: 'json' }`: Respond with valid JSON.
 * - `{ type: 'json_schema', schema, name? }`: Respond with JSON matching the given schema.
 */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json' }
  | { type: 'json_schema'; schema: Record<string, unknown>; name?: string };
