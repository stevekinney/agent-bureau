# Hook System Expansion

## Overview

The lifecycle package provides `HookRegistry` with priority ordering and error handling. The operative package defines `OperativeHookMap` with 7 hooks: `prepareStep`, `beforeToolExecution`, `afterToolExecution`, `onStep`, `selectTools`, `validateResponse`, `validateToolResult`. This is a good start but doesn't cover many important lifecycle moments—prompt assembly, LLM I/O monitoring, compaction events, error recovery, and run lifecycle.

This work expands `OperativeHookMap` with additional hooks that cover the full agent lifecycle, adds read-only monitoring hooks for LLM traffic, and provides hook composition utilities.

## What Exists Today

Read these files to understand the current state:

- `packages/lifecycle/src/hooks/hook-registry.ts` — `HookRegistry` class
- `packages/lifecycle/src/hooks/types.ts` — `HookMap`, `HookRegistrationOptions`, `HookErrorHandler`
- `packages/lifecycle/src/hooks/merge-hook-registries.ts` — `mergeHookRegistries()`
- `packages/operative/src/hooks.ts` — `OperativeHookMap` (7 hooks)
- `packages/operative/src/types.ts` — `RunOptions` (has `hooks` field), all hook type aliases
- `packages/operative/src/loop.ts` — where hooks are called
- `packages/operative/src/create-run.ts` — `ActiveRun` event target

## Product Requirements

### PR-1: Prompt Lifecycle Hooks

Add hooks around the prompt assembly and generate call:

```typescript
interface PromptLifecycleHooks {
  /**
   * Called after the conversation is assembled but before the generate call.
   * Receives the full message array that will be sent to the LLM.
   * Can modify messages (e.g., inject additional context, rewrite instructions).
   * Return modified messages or void to keep originals.
   */
  beforeGenerate: (context: BeforeGenerateContext) => Promise<GenerateContext | void>;

  /**
   * Called after the generate call returns but before the response is processed.
   * Can modify the response (e.g., filter content, inject metadata).
   * Return modified response or void to keep original.
   */
  afterGenerate: (context: AfterGenerateContext) => Promise<GenerateResponse | void>;
}

interface BeforeGenerateContext {
  conversation: Conversation;
  step: number;
  toolbox: Toolbox;
  signal?: AbortSignal;
}

interface AfterGenerateContext {
  conversation: Conversation;
  step: number;
  response: GenerateResponse;
  duration: number; // ms
}
```

### PR-2: LLM I/O Monitoring Hooks

Read-only hooks for observing LLM traffic. These are critical for logging, debugging, cost tracking, and compliance:

```typescript
interface MonitoringHooks {
  /**
   * Called with the raw input sent to the LLM provider. Read-only — modifications
   * are ignored. Runs after all beforeGenerate hooks. Useful for logging, auditing,
   * and cost estimation.
   */
  onLLMInput: (context: LLMInputContext) => Promise<void>;

  /**
   * Called with the raw output from the LLM provider. Read-only — modifications
   * are ignored. Runs before afterGenerate hooks. Useful for logging, auditing,
   * and monitoring.
   */
  onLLMOutput: (context: LLMOutputContext) => Promise<void>;
}

interface LLMInputContext {
  conversation: Conversation;
  step: number;
  messageCount: number;
  estimatedTokens?: number;
}

interface LLMOutputContext {
  conversation: Conversation;
  step: number;
  response: Readonly<GenerateResponse>;
  duration: number;
  usage?: TokenUsage;
}
```

These hooks must never block the main loop. They run in parallel with `Promise.allSettled` and errors are caught and forwarded to the hook error handler.

### PR-3: Run Lifecycle Hooks

Hooks for the overall run lifecycle:

```typescript
interface RunLifecycleHooks {
  /** Called when a run starts, before the first step. */
  onRunStart: (context: RunStartContext) => Promise<void>;

  /** Called when a run completes, after the last step. */
  onRunComplete: (context: RunCompleteContext) => Promise<void>;

  /** Called when a run errors, with the error and partial results. */
  onRunError: (context: RunErrorContext) => Promise<void>;

  /** Called when a run is aborted via AbortSignal or abort(). */
  onRunAbort: (context: RunAbortContext) => Promise<void>;
}

interface RunStartContext {
  conversation: Conversation;
  toolbox: Toolbox;
  maximumSteps: number;
}

interface RunCompleteContext {
  result: RunResult;
  totalDuration: number;
}

interface RunErrorContext {
  error: unknown;
  partialSteps: ReadonlyArray<StepResult>;
  conversation: Conversation;
}

interface RunAbortContext {
  reason?: string;
  partialSteps: ReadonlyArray<StepResult>;
  conversation: Conversation;
}
```

### PR-4: Error Recovery Hook

A hook that gives plugins a chance to recover from errors before the run terminates:

```typescript
interface ErrorRecoveryHooks {
  /**
   * Called when a generate call or tool execution throws. The hook can:
   * - Return 'retry' to retry the current step
   * - Return 'skip' to skip the current step and continue
   * - Return 'abort' or void to let the error propagate
   * Only the first hook to return a non-void value wins.
   */
  onError: (context: ErrorContext) => Promise<ErrorRecoveryAction | void>;
}

type ErrorRecoveryAction = 'retry' | 'skip' | 'abort';

interface ErrorContext {
  error: unknown;
  step: number;
  phase: 'generate' | 'tool-execution';
  conversation: Conversation;
  retryCount: number;
  maxRetries: number;
}
```

### PR-5: Hook Composition Utilities

Add utilities for common hook patterns:

```typescript
/**
 * Creates a hook that only runs on specific steps.
 * Example: onlyOnStep(0, identityInjectionHook)
 */
function onlyOnStep<H extends (...args: any[]) => any>(
  step: number,
  hook: H,
): H;

/**
 * Creates a hook that runs at most once per run.
 * Useful for one-time initialization.
 */
function runOnce<H extends (...args: any[]) => any>(hook: H): H;

/**
 * Creates a hook that runs every N steps.
 * Useful for periodic tasks (e.g., save checkpoint every 5 steps).
 */
function everyNSteps<H extends (...args: any[]) => any>(
  n: number,
  hook: H,
): H;

/**
 * Creates a hook with a timeout. If the hook doesn't resolve within
 * the timeout, it's treated as a no-op (or error, configurable).
 */
function withTimeout<H extends (...args: any[]) => any>(
  ms: number,
  hook: H,
  onTimeout?: 'ignore' | 'error',
): H;

/**
 * Composes multiple hooks of the same type into a single hook.
 * For modifying hooks, the output of one is the input to the next.
 * For void hooks, all run in parallel.
 */
function composeHooks<H extends (...args: any[]) => any>(
  ...hooks: H[]
): H;
```

## Architecture

### New Files

In `packages/operative/src/hooks/`:

- `types.ts` — all new hook context types and `ErrorRecoveryAction`
- `composition.ts` — `onlyOnStep()`, `runOnce()`, `everyNSteps()`, `withTimeout()`, `composeHooks()`
- `index.ts` — re-exports

### Extended Files

- `packages/operative/src/hooks.ts` — expand `OperativeHookMap` with all new hooks
- `packages/operative/src/loop.ts` — call new hooks at appropriate lifecycle points
- `packages/operative/src/create-run.ts` — call run lifecycle hooks
- `packages/operative/src/types.ts` — add new hook type aliases to exports
- `packages/operative/src/index.ts` — re-export composition utilities

### Hook Execution Semantics

| Hook | Execution | Can Modify? | Error Handling |
|---|---|---|---|
| `beforeGenerate` | Sequential (waterfall) | Yes — return modified context | Error aborts step |
| `afterGenerate` | Sequential (waterfall) | Yes — return modified response | Error aborts step |
| `onLLMInput` | Parallel (`allSettled`) | No — read-only | Errors caught silently |
| `onLLMOutput` | Parallel (`allSettled`) | No — read-only | Errors caught silently |
| `onRunStart` | Sequential | No | Error aborts run |
| `onRunComplete` | Parallel (`allSettled`) | No | Errors caught silently |
| `onRunError` | Parallel (`allSettled`) | No | Errors caught silently |
| `onRunAbort` | Parallel (`allSettled`) | No | Errors caught silently |
| `onError` | Sequential (first-wins) | Yes — return action | Error propagates |

## Implementation Order (TDD)

### Phase 1: Hook Composition Utilities

1. Write tests for each utility:
   - `onlyOnStep(0, hook)` — runs on step 0, skips all others
   - `onlyOnStep(3, hook)` — runs on step 3 only
   - `runOnce(hook)` — runs first time, returns undefined on subsequent calls
   - `everyNSteps(3, hook)` — runs on steps 0, 3, 6, 9...
   - `withTimeout(100, hook, 'ignore')` — returns undefined if hook takes >100ms
   - `withTimeout(100, hook, 'error')` — throws if hook takes >100ms
   - `composeHooks(h1, h2)` for void hooks — both run in parallel
   - `composeHooks(h1, h2)` for modifying hooks — output chains through
2. Implement `composition.ts`
3. Verify: `bun test packages/operative/src/hooks/composition.test.ts`

### Phase 2: Prompt Lifecycle Hooks

1. Write tests:
   - `beforeGenerate` receives correct context with conversation and toolbox
   - `beforeGenerate` returning modified context passes it to generate
   - `beforeGenerate` returning void uses original context
   - Multiple `beforeGenerate` hooks chain (waterfall)
   - `afterGenerate` receives response and duration
   - `afterGenerate` returning modified response passes it downstream
   - `afterGenerate` returning void uses original response
   - Error in `beforeGenerate` stops the step
2. Add to `OperativeHookMap`, integrate into `loop.ts`
3. Verify: `bun test packages/operative/` (run all tests to catch regressions)

### Phase 3: LLM I/O Monitoring Hooks

1. Write tests:
   - `onLLMInput` fires with conversation and step info
   - `onLLMInput` errors don't block the generate call
   - `onLLMOutput` fires with response and duration
   - `onLLMOutput` errors don't block response processing
   - Multiple monitoring hooks all fire (parallel)
   - Monitoring hooks can't modify the data (read-only)
2. Add to `OperativeHookMap`, integrate into `loop.ts`
3. Verify: `bun test packages/operative/`

### Phase 4: Run Lifecycle Hooks

1. Write tests:
   - `onRunStart` fires before first step with conversation and toolbox
   - `onRunComplete` fires after last step with result and duration
   - `onRunError` fires on error with partial steps
   - `onRunAbort` fires on abort with partial steps
   - Error in `onRunStart` prevents run from starting
   - Error in `onRunComplete` doesn't lose the result
   - `onRunError` and `onRunAbort` are mutually exclusive
2. Add to `OperativeHookMap`, integrate into `loop.ts` and `create-run.ts`
3. Verify: `bun test packages/operative/`

### Phase 5: Error Recovery Hook

1. Write tests:
   - `onError` returning `'retry'` retries the current step
   - `onError` returning `'skip'` skips to next step
   - `onError` returning `'abort'` terminates the run
   - `onError` returning void lets error propagate normally
   - Multiple `onError` hooks — first non-void return wins
   - Retry respects `maxRetries` to prevent infinite loops
   - `retryCount` increments on each retry
   - Works for both generate errors and tool execution errors
2. Add to `OperativeHookMap`, integrate into `loop.ts`
3. Verify: `bun test packages/operative/`

### Phase 6: Integration

1. Run full operative suite: `turbo run test --filter=operative`
2. Verify existing hooks still work unchanged
3. Run cross-package suite: `turbo run validate`

## Acceptance Criteria

- [ ] `OperativeHookMap` extended with: `beforeGenerate`, `afterGenerate`, `onLLMInput`, `onLLMOutput`, `onRunStart`, `onRunComplete`, `onRunError`, `onRunAbort`, `onError`
- [ ] All 7 existing hooks still work unchanged
- [ ] `beforeGenerate` can modify the generate context (waterfall)
- [ ] `afterGenerate` can modify the generate response (waterfall)
- [ ] `onLLMInput` and `onLLMOutput` are read-only and non-blocking
- [ ] Monitoring hook errors don't crash the run
- [ ] `onRunStart` fires before first step
- [ ] `onRunComplete` fires after successful completion with full result
- [ ] `onRunError` fires on error with partial state
- [ ] `onRunAbort` fires on abort with partial state
- [ ] `onError` recovery hook supports retry/skip/abort actions
- [ ] Error recovery respects max retry count
- [ ] `onlyOnStep()`, `runOnce()`, `everyNSteps()`, `withTimeout()`, `composeHooks()` exported from operative
- [ ] Hook composition works with all hook types
- [ ] 100% test coverage on new hooks and composition utilities
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All new types exported from operative
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/operative/src/hooks/       # Hook composition tests
bun test packages/operative/                 # Full operative test suite
bun test --coverage packages/operative/      # Coverage
turbo run check-types --filter=operative     # Type check
turbo run lint --filter=operative            # Lint
turbo run validate                           # Full pipeline
```

<promise>HOOK_SYSTEM_EXPANSION_COMPLETE</promise>
<promise>HOOK_SYSTEM_EXPANSION_FAILED</promise>
