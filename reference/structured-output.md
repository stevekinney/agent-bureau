# Structured Output at Generation Time

## Overview

Herald passes tools to providers but never sets `tool_choice` or `response_format`. Operative validates responses post-hoc via `responseSchema` with Zod, consuming tokens on invalid outputs before rejecting them. Provider-native structured output modes guarantee valid JSON at generation time, eliminating wasted tokens and retry loops.

This work adds provider-native structured output support to herald's generate factories and integrates `tool_choice` control into operative's step-level tool selection.

## What Exists Today

Read these files to understand the current state:

- `packages/herald/src/anthropic.ts` — `createAnthropicGenerate()` builds params but never sets `tool_choice`
- `packages/herald/src/openai.ts` — `createOpenAIGenerate()` builds params but never sets `response_format` or `tool_choice`
- `packages/herald/src/gemini.ts` — `createGeminiGenerate()` builds params
- `packages/herald/src/types.ts` — `BaseProviderOptions`, provider option types
- `packages/operative/src/types.ts` — `RunOptions.responseSchema`, `GenerateContext`
- `packages/operative/src/loop.ts` — post-hoc `responseSchema.parse()` with `schemaRetries`

## Product Requirements

### PR-1: Tool Choice in Herald

Add `toolChoice` to all provider option types:

```typescript
type ToolChoice =
  | 'auto'      // Model decides (current default behavior)
  | 'required'  // Model MUST call at least one tool
  | 'none'      // Model must NOT call any tools
  | { tool: string }; // Model must call this specific tool

interface BaseProviderOptions {
  model: string;
  maximumTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** Controls tool selection behavior. Default: 'auto'. */
  toolChoice?: ToolChoice;
}
```

Each provider factory maps `ToolChoice` to the provider's native format:

- **Anthropic**: `tool_choice: { type: 'auto' | 'any' | 'tool', name?: string }`
- **OpenAI**: `tool_choice: 'auto' | 'required' | 'none' | { type: 'function', function: { name } }`
- **Gemini**: `tool_config: { function_calling_config: { mode: 'AUTO' | 'ANY' | 'NONE', allowed_function_names?: [] } }`

### PR-2: Response Format in Herald

Add `responseFormat` to provider options for native structured output:

```typescript
type ResponseFormat =
  | { type: 'text' }       // Default, no constraints
  | { type: 'json' }       // Force JSON output (OpenAI json_mode)
  | { type: 'json_schema'; schema: Record<string, unknown>; name?: string }; // Strict schema

interface BaseProviderOptions {
  // ... existing fields
  /** Controls response format. Only applicable when no tools are called. */
  responseFormat?: ResponseFormat;
}
```

Provider mapping:

- **OpenAI**: `response_format: { type: 'json_object' }` or `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`
- **Anthropic**: Not natively supported for general responses—fall back to post-hoc validation. For tool use, Anthropic already enforces JSON via tool schemas.
- **Gemini**: `generation_config: { response_mime_type: 'application/json', response_schema: ... }`

### PR-3: Dynamic Tool Choice in Operative

Add `toolChoice` to `GenerateContext` so operative can control tool selection per step:

```typescript
interface GenerateContext {
  conversation: Conversation;
  step: number;
  signal?: AbortSignal;
  toolbox: Toolbox;
  /** Per-step tool choice override. Passed through to the generate function. */
  toolChoice?: ToolChoice;
}
```

This enables patterns like:
- Step 0: `toolChoice: { tool: 'search' }` — force the agent to search first
- Step N (final): `toolChoice: 'none'` — force a text-only summary

The `selectTools` hook already controls _which_ tools are available. `toolChoice` controls _whether_ tools must be used.

### PR-4: Schema-Aware Generate

When `responseSchema` is set on `RunOptions`, operative should pass the Zod schema as a JSON Schema to herald via `responseFormat: { type: 'json_schema' }` for providers that support it, while falling back to post-hoc validation for providers that don't.

```typescript
function zodToJsonSchema(schema: ZodType): Record<string, unknown>;
```

This bridges operative's Zod schemas to herald's `responseFormat` without requiring users to maintain two schema formats.

### PR-5: Tool Choice Hook

Add a `selectToolChoice` hook to `OperativeHookMap` for dynamic per-step control:

```typescript
interface OperativeHookMap extends HookMap {
  // ... existing hooks
  selectToolChoice: (context: StepContext) => Promise<ToolChoice | void>;
}
```

When the hook returns a `ToolChoice`, it overrides the default. When it returns void, the default from `RunOptions` applies.

## Architecture

### New Files

In `packages/herald/src/structured-output/`:

- `types.ts` — `ToolChoice`, `ResponseFormat`
- `tool-choice-adapters.ts` — `toAnthropicToolChoice()`, `toOpenAIToolChoice()`, `toGeminiToolChoice()`
- `response-format-adapters.ts` — `toOpenAIResponseFormat()`, `toGeminiResponseFormat()`
- `index.ts` — re-exports

In `packages/operative/src/structured-output/`:

- `zod-to-json-schema.ts` — `zodToJsonSchema()` converter
- `index.ts` — re-exports

### Extended Files

- `packages/herald/src/types.ts` — add `toolChoice` and `responseFormat` to `BaseProviderOptions`
- `packages/herald/src/anthropic.ts` — map `toolChoice` to Anthropic format, pass to params
- `packages/herald/src/openai.ts` — map `toolChoice` and `responseFormat` to OpenAI format
- `packages/herald/src/gemini.ts` — map `toolChoice` and `responseFormat` to Gemini format
- `packages/operative/src/types.ts` — add `toolChoice` to `GenerateContext` and `RunOptions`
- `packages/operative/src/hooks.ts` — add `selectToolChoice` to `OperativeHookMap`
- `packages/operative/src/loop.ts` — integrate `toolChoice` into generate context, bridge `responseSchema` to `responseFormat`

## Implementation Order (TDD)

### Phase 1: Tool Choice Adapters

1. Write tests for each adapter:
   - `toAnthropicToolChoice('auto')` → `{ type: 'auto' }`
   - `toAnthropicToolChoice('required')` → `{ type: 'any' }`
   - `toAnthropicToolChoice('none')` → `undefined` (Anthropic doesn't support 'none', omit tools instead)
   - `toAnthropicToolChoice({ tool: 'search' })` → `{ type: 'tool', name: 'search' }`
   - `toOpenAIToolChoice('auto')` → `'auto'`
   - `toOpenAIToolChoice('required')` → `'required'`
   - `toOpenAIToolChoice('none')` → `'none'`
   - `toOpenAIToolChoice({ tool: 'search' })` → `{ type: 'function', function: { name: 'search' } }`
   - `toGeminiToolChoice('auto')` → `{ function_calling_config: { mode: 'AUTO' } }`
   - `toGeminiToolChoice('required')` → `{ function_calling_config: { mode: 'ANY' } }`
   - `toGeminiToolChoice({ tool: 'search' })` → `{ function_calling_config: { mode: 'ANY', allowed_function_names: ['search'] } }`
2. Implement `tool-choice-adapters.ts`
3. Verify: `bun test packages/herald/src/structured-output/tool-choice-adapters.test.ts`

### Phase 2: Response Format Adapters

1. Write tests:
   - `toOpenAIResponseFormat({ type: 'json' })` → `{ type: 'json_object' }`
   - `toOpenAIResponseFormat({ type: 'json_schema', schema, name })` → `{ type: 'json_schema', json_schema: { name, schema, strict: true } }`
   - `toGeminiResponseFormat({ type: 'json' })` → `{ response_mime_type: 'application/json' }`
   - `toGeminiResponseFormat({ type: 'json_schema', schema })` → includes `response_schema`
   - `{ type: 'text' }` → undefined (no override)
2. Implement `response-format-adapters.ts`
3. Verify: `bun test packages/herald/src/structured-output/response-format-adapters.test.ts`

### Phase 3: Zod to JSON Schema

1. Write tests:
   - `z.string()` → `{ type: 'string' }`
   - `z.number()` → `{ type: 'number' }`
   - `z.object({ name: z.string() })` → `{ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }`
   - `z.array(z.string())` → `{ type: 'array', items: { type: 'string' } }`
   - `z.enum(['a', 'b'])` → `{ type: 'string', enum: ['a', 'b'] }`
   - `z.optional()` fields not in `required`
   - Nested objects handled recursively
   - `z.union()` → `{ anyOf: [...] }`
   - `z.literal()` → `{ const: ... }`
2. Implement `zod-to-json-schema.ts`
3. Verify: `bun test packages/operative/src/structured-output/zod-to-json-schema.test.ts`

### Phase 4: Provider Integration

1. Write tests for each provider:
   - Anthropic generate passes `tool_choice` when set
   - Anthropic generate omits tools when `toolChoice: 'none'`
   - OpenAI generate passes `tool_choice` and `response_format` when set
   - Gemini generate passes `tool_config` and `generation_config` when set
   - Default behavior (no toolChoice) unchanged
2. Update provider factories
3. Verify: `bun test packages/herald/src/`

### Phase 5: Operative Integration

1. Write tests:
   - `toolChoice` flows from `RunOptions` to `GenerateContext`
   - `selectToolChoice` hook overrides default
   - `responseSchema` bridges to `responseFormat` via `zodToJsonSchema()`
   - Post-hoc validation still runs as fallback
   - Per-step `toolChoice` works via hook
2. Update loop and types
3. Verify: `bun test packages/operative/`

### Phase 6: Full Integration

1. Run full herald suite: `turbo run test --filter=herald`
2. Run full operative suite: `turbo run test --filter=operative`
3. Run full pipeline: `turbo run validate`

## Acceptance Criteria

- [ ] `ToolChoice` type exported from `herald`
- [ ] `ResponseFormat` type exported from `herald`
- [ ] `toolChoice` supported in `createAnthropicGenerate()` options
- [ ] `toolChoice` supported in `createOpenAIGenerate()` options
- [ ] `toolChoice` supported in `createGeminiGenerate()` options
- [ ] `responseFormat` supported in `createOpenAIGenerate()` options
- [ ] `responseFormat` supported in `createGeminiGenerate()` options
- [ ] Provider adapters correctly map `ToolChoice` to native formats
- [ ] `toolChoice: 'required'` forces tool calls in all providers
- [ ] `toolChoice: 'none'` prevents tool calls
- [ ] `toolChoice: { tool: 'name' }` forces specific tool
- [ ] `zodToJsonSchema()` converts common Zod types to JSON Schema
- [ ] `responseSchema` in `RunOptions` auto-bridges to `responseFormat`
- [ ] `selectToolChoice` hook in `OperativeHookMap` enables per-step control
- [ ] Default behavior (no `toolChoice`, no `responseFormat`) unchanged
- [ ] Post-hoc `responseSchema` validation still works as fallback
- [ ] 100% test coverage on new modules
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/herald/src/structured-output/   # Herald tests
bun test packages/operative/src/structured-output/ # Operative tests
bun test --coverage packages/herald/               # Coverage
bun test --coverage packages/operative/            # Coverage
turbo run validate                                 # Full pipeline
```

<promise>STRUCTURED_OUTPUT_COMPLETE</promise>
<promise>STRUCTURED_OUTPUT_FAILED</promise>
