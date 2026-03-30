# Smart Retry with Request Mutation

## Overview

Operative's retry system calls the exact same generate function with the exact same context on failure. This misses the most impactful retry pattern: mutating the request before retrying. Context overflow? Compact the conversation. Tool error? Disable the failing tool. Rate limit? Try a cheaper model. Schema validation failure? Inject the error as context.

This work extends operative's `RetryOptions` with a `mutate` callback that transforms the `GenerateContext` before each retry attempt.

## What Exists Today

Read these files to understand the current state:

- `packages/operative/src/loop.ts` — `callGenerateWithRetry()` function (the retry loop)
- `packages/operative/src/types.ts` — `RetryOptions`, `GenerateContext`, `GenerateFunction`
- `packages/herald/src/errors.ts` — `HeraldError`, `shouldRetryHeraldError()`, error classification
- `packages/operative/src/create-context-compactor.ts` — `createContextCompactor()` (can be used in mutations)

## Product Requirements

### PR-1: Retry Mutation Callback

Extend `RetryOptions` with a `mutate` field:

```typescript
interface RetryOptions {
  attempts: number;
  delay?: number | ((attempt: number) => number);
  shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
  /** Transform the generate context before retrying. */
  mutate?: RetryMutator;
}

type RetryMutator = (
  context: GenerateContext,
  error: unknown,
  attempt: number,
) => Promise<GenerateContext | void> | GenerateContext | void;
```

When `mutate` returns a new `GenerateContext`, that context is used for the retry. When it returns void, the original context is used unchanged.

### PR-2: Built-in Mutator Factories

Common retry mutations as composable factories:

**Context compaction on overflow:**

```typescript
function createOverflowMutator(options: {
  summarize: (messages: ReadonlyArray<Message>) => Promise<string>;
  retainRecentMessages?: number;
}): RetryMutator;
```

Triggers when the error looks like a context overflow (checked via `classifyProviderError()` from herald's fallover module, or by matching error message patterns). Compacts the conversation and retries with the shorter context.

**Tool removal on tool error:**

```typescript
function createToolRemovalMutator(): RetryMutator;
```

When a tool execution error causes the step to fail, removes the failing tool from the toolbox before retrying. The agent can then try a different approach.

**Temperature escalation:**

```typescript
function createTemperatureEscalationMutator(options?: {
  increment?: number; // Default: 0.2
  max?: number; // Default: 1.0
}): RetryMutator;
```

Increases temperature on each retry to get more diverse outputs. Useful when the model keeps generating the same invalid response.

**Schema error injection:**

```typescript
function createSchemaErrorMutator(): RetryMutator;
```

When a response fails schema validation, injects the validation error as a user message so the model can correct itself. This is more targeted than the existing `schemaRetryMessage` because it operates at the `GenerateContext` level and can modify the conversation directly.

### PR-3: Mutator Composition

Compose multiple mutators into a chain:

```typescript
function composeMutators(...mutators: RetryMutator[]): RetryMutator;
```

Each mutator receives the context (possibly modified by the previous mutator). The first to return a modified context "wins" for that mutation, but subsequent mutators still run on the modified context.

### PR-4: Jitter on Retry Delay

Add jitter to prevent thundering herd on retries:

```typescript
interface RetryOptions {
  // ... existing fields
  /** Add random jitter to delay. Default: true. */
  jitter?: boolean;
  /** Maximum jitter in ms. Default: half of delay. */
  maxJitter?: number;
}
```

### PR-5: Retry Events

Extend the existing `GenerateRetryEvent` with mutation info:

```typescript
interface GenerateRetryEvent extends Event {
  step: number;
  attempt: number;
  error: unknown;
  /** Whether the context was mutated for this retry. */
  mutated: boolean;
  /** Description of the mutation applied. */
  mutationDescription?: string;
}
```

## Architecture

### New Files

In `packages/operative/src/retry/`:

- `types.ts` — `RetryMutator` type (re-export from main types)
- `overflow-mutator.ts` — `createOverflowMutator()`
- `tool-removal-mutator.ts` — `createToolRemovalMutator()`
- `temperature-escalation-mutator.ts` — `createTemperatureEscalationMutator()`
- `schema-error-mutator.ts` — `createSchemaErrorMutator()`
- `compose-mutators.ts` — `composeMutators()`
- `jitter.ts` — `addJitter()` utility
- `index.ts` — re-exports

### Extended Files

- `packages/operative/src/types.ts` — add `mutate`, `jitter`, `maxJitter` to `RetryOptions`
- `packages/operative/src/loop.ts` — call `mutate()` in `callGenerateWithRetry()`, apply jitter
- `packages/operative/src/events.ts` — extend `GenerateRetryEvent` with mutation fields
- `packages/operative/src/index.ts` — re-export retry mutator factories

## Implementation Order (TDD)

### Phase 1: Jitter Utility

1. Write tests:
   - `addJitter(1000)` returns value between 500 and 1500 (default half-delay jitter)
   - `addJitter(1000, { max: 200 })` returns value between 800 and 1200
   - `addJitter(1000, { enabled: false })` returns exactly 1000
   - Distribution is uniform (statistical test over 1000 samples)
2. Implement `jitter.ts`
3. Verify: `bun test packages/operative/src/retry/jitter.test.ts`

### Phase 2: Overflow Mutator

1. Write tests:
   - Error with `"context_length_exceeded"` message → compacts conversation and returns new context
   - Error without overflow pattern → returns void (no mutation)
   - Compacted conversation has fewer messages
   - `retainRecentMessages` respected
   - `summarize` function called with old messages
   - Non-overflow errors pass through unmutated
2. Implement `overflow-mutator.ts`
3. Verify: `bun test packages/operative/src/retry/overflow-mutator.test.ts`

### Phase 3: Tool Removal Mutator

1. Write tests:
   - Tool execution error with tool name → returns context without that tool
   - Non-tool error → returns void
   - Multiple tool failures accumulate (each retry removes another)
   - Original toolbox not modified (creates new toolbox)
2. Implement `tool-removal-mutator.ts`
3. Verify: `bun test packages/operative/src/retry/tool-removal-mutator.test.ts`

### Phase 4: Temperature Escalation Mutator

1. Write tests:
   - First retry → temperature increased by increment
   - Second retry → temperature increased further
   - Temperature capped at max
   - Default increment is 0.2, default max is 1.0
2. Implement `temperature-escalation-mutator.ts`
3. Verify: `bun test packages/operative/src/retry/temperature-escalation-mutator.test.ts`

### Phase 5: Schema Error Mutator

1. Write tests:
   - Zod validation error → injects error message into conversation
   - Non-validation error → returns void
   - Injected message contains the specific validation failure
   - Conversation retains original messages plus the error injection
2. Implement `schema-error-mutator.ts`
3. Verify: `bun test packages/operative/src/retry/schema-error-mutator.test.ts`

### Phase 6: Mutator Composition

1. Write tests:
   - Single mutator → behaves like calling it directly
   - Two mutators → second receives context modified by first
   - Void-returning mutator → context passes through unchanged
   - All mutators run even if earlier ones modify context
2. Implement `compose-mutators.ts`
3. Verify: `bun test packages/operative/src/retry/compose-mutators.test.ts`

### Phase 7: Loop Integration

1. Write tests:
   - `mutate` called before each retry with error and attempt number
   - Mutated context used for retry generate call
   - Void-returning mutate uses original context
   - `GenerateRetryEvent` includes `mutated: true` when context was changed
   - Jitter applied to delay when `jitter: true`
   - Existing retry behavior unchanged when `mutate` not provided
2. Update `callGenerateWithRetry()` in `loop.ts`
3. Verify: `bun test packages/operative/`

### Phase 8: Full Integration

1. Run full suite: `turbo run validate`

## Acceptance Criteria

- [ ] `RetryOptions.mutate` callback supported in operative's retry loop
- [ ] `createOverflowMutator()` compacts conversation on context overflow errors
- [ ] `createToolRemovalMutator()` removes failing tools from toolbox
- [ ] `createTemperatureEscalationMutator()` increases temperature per retry
- [ ] `createSchemaErrorMutator()` injects validation errors into conversation
- [ ] `composeMutators()` chains multiple mutators
- [ ] Retry delay supports jitter with configurable max
- [ ] `GenerateRetryEvent` includes mutation status
- [ ] Void-returning mutate leaves context unchanged
- [ ] Original context/toolbox never modified (immutable)
- [ ] Existing retry behavior unchanged when `mutate` not provided
- [ ] 100% test coverage: `bun test --coverage packages/operative/src/retry/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/operative/src/retry/       # Retry mutator tests
bun test --coverage packages/operative/      # Coverage
turbo run check-types --filter=operative     # Type check
turbo run lint --filter=operative            # Lint
turbo run validate                           # Full pipeline
```

<promise>SMART_RETRY_COMPLETE</promise>
<promise>SMART_RETRY_FAILED</promise>
