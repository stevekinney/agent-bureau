# Context Engine

## Overview

The operative package has a basic `ContextManagementOptions` interface (`maxTokens`, `onCompact`, `tokenEstimator`) and a `createContextCompactor` helper that delegates to conversationalist's `Conversation.compact()`. This is not enough for production agent loops. Long conversations overflow, context windows get wasted on irrelevant history, and there's no strategy for _what_ the model sees each turn.

This work adds a pluggable context engine to the operative package that handles token budgeting, context assembly, compaction triggers, and subagent context isolation. It does _not_ create a new package—it extends operative with new modules.

## What Exists Today

Read these files to understand the current state:

- `packages/operative/src/types.ts` — `ContextManagementOptions`, `RunOptions`, `StepContext`
- `packages/operative/src/create-context-compactor.ts` — `createContextCompactor()` factory
- `packages/operative/src/hooks.ts` — `OperativeHookMap` with existing hook points
- `packages/operative/src/loop.ts` — core agent loop
- `packages/conversationalist/src/index.ts` — `Conversation`, `ConversationHistory`, compact, message types

## Product Requirements

### PR-1: Token Budget Management

The context engine must track token usage across the conversation and enforce configurable budgets:

- **Hard minimum reserve**: A floor of tokens reserved for the model's response. The engine must never assemble a prompt that leaves fewer than `minimumResponseTokens` available. Default: `1500`.
- **Warning threshold**: When remaining tokens drop below `warningThreshold`, emit a `context:budget-warning` event via the operative's `ActiveRun` event target. Default: 20% of `maxTokens`.
- **Compaction trigger**: When token count exceeds `compactionThreshold`, automatically trigger compaction. Default: 80% of `maxTokens`.
- **Token estimation**: Accept an optional `tokenEstimator` function. Default to a character-based heuristic (`Math.ceil(text.length / 4)`). The estimator must be called on the full assembled prompt, not individual messages.

### PR-2: Context Assembly Strategy

The engine must decide _what_ the model sees each turn. This is not just "all messages in order." The assembly strategy must:

- **Always include**: system messages (instructions, identity), the most recent `N` messages (configurable, default `4`), and any messages containing pending tool results.
- **Prioritize**: messages the model referenced (via tool calls), messages with high semantic relevance to the current turn (if memory integration is active), and recent user messages over old assistant messages.
- **Exclude**: messages already summarized by a prior compaction, messages marked as `redacted`.
- **Budget allocation**: system messages get a guaranteed budget slice (default 25%). The remaining budget is split between recent history (60%) and retrieved context (15%).

Expose this as a `createContextAssembler` factory that returns an `assemble` function compatible with operative's generate pipeline.

### PR-3: Pluggable Compaction Strategies

The existing `createContextCompactor` is one strategy (summarize + retain recent). The context engine should support multiple strategies:

- **Summarization** (existing): LLM-powered summary of old messages. Keep as default.
- **Sliding window**: Drop messages beyond a window size. No LLM call needed.
- **Selective pruning**: Drop tool-result messages that are older than `N` turns, keeping tool-call messages as breadcrumbs.
- **Hybrid**: Summarize old messages, prune old tool results, keep recent window intact.

Each strategy implements a `CompactionStrategy` interface:

```typescript
type CompactionStrategy = (
  conversation: Conversation,
  budget: TokenBudget,
  options: CompactionOptions,
) => Promise<void>;
```

### PR-4: Subagent Context Isolation

When a subagent spawns, it needs a _subset_ of the parent's context—not the full history. The context engine must provide:

- `prepareSubagentContext(parentConversation, options)` — returns a new `Conversation` with:
  - The parent's system messages
  - A configurable summary of recent parent context
  - The subagent's own instructions injected
- `mergeSubagentResult(parentConversation, childResult)` — merges the child's output back into the parent's conversation as a tool result.

### PR-5: Integration with Operative's Hook System

The context engine hooks into operative via the existing `OperativeHookMap`. Add these new hooks:

- `beforeContextAssembly` — called before assembling the context for a generate call. Plugins can inject additional messages or modify budget allocations.
- `afterContextAssembly` — called after assembly, receives the assembled messages and budget report. Read-only monitoring hook.
- `beforeCompaction` — called before compaction. Can cancel or modify compaction parameters.
- `afterCompaction` — called after compaction with stats (messages removed, tokens freed).

These hooks extend `OperativeHookMap` in `packages/operative/src/hooks.ts`.

## Architecture

### New Files

All new files go in `packages/operative/src/context/`:

- `types.ts` — `TokenBudget`, `AssemblyOptions`, `CompactionOptions`, `CompactionStrategy`, `ContextAssembler`, `ContextEngineOptions`
- `token-budget.ts` — `createTokenBudget()` factory, budget tracking, threshold checks
- `assembly.ts` — `createContextAssembler()` factory
- `compaction-strategies.ts` — sliding window, selective pruning, hybrid strategies
- `subagent-context.ts` — `prepareSubagentContext()`, `mergeSubagentResult()`
- `index.ts` — re-exports

### Extended Files

- `packages/operative/src/hooks.ts` — add context assembly/compaction hooks to `OperativeHookMap`
- `packages/operative/src/loop.ts` — integrate context assembler into the generate pipeline
- `packages/operative/src/index.ts` — re-export context engine modules
- `packages/operative/src/types.ts` — extend `ContextManagementOptions` with new fields

### Type Signatures

```typescript
interface TokenBudget {
  readonly maxTokens: number;
  readonly minimumResponseTokens: number;
  readonly warningThreshold: number;
  readonly compactionThreshold: number;
  readonly used: number;
  readonly remaining: number;
  readonly exceeds: boolean;
  readonly warning: boolean;
  update(tokens: number): void;
  allocate(slice: string): number; // returns allocated token count for a named slice
}

interface AssemblyOptions {
  conversation: Conversation;
  budget: TokenBudget;
  recentMessageCount?: number;
  systemBudgetRatio?: number;
  historyBudgetRatio?: number;
  retrievedBudgetRatio?: number;
  retrievedMessages?: ReadonlyArray<Message>;
  tokenEstimator?: (text: string) => number;
}

interface AssemblyResult {
  messages: ReadonlyArray<Message>;
  budgetReport: {
    systemTokens: number;
    historyTokens: number;
    retrievedTokens: number;
    totalTokens: number;
    remainingTokens: number;
  };
}

type ContextAssembler = (options: AssemblyOptions) => AssemblyResult;

interface CompactionOptions {
  strategy?: 'summarization' | 'sliding-window' | 'selective-pruning' | 'hybrid';
  retainRecentMessages?: number;
  summarize?: (messages: ReadonlyArray<Message>) => Promise<string>;
  maxToolResultAge?: number; // turns
}
```

## Implementation Order (TDD)

### Phase 1: Token Budget

1. Write tests for `createTokenBudget()`:
   - Tracks used/remaining correctly
   - `exceeds` flips at `compactionThreshold`
   - `warning` flips at `warningThreshold`
   - `allocate()` returns proportional budget for named slices
   - Budget never allows fewer than `minimumResponseTokens` remaining
   - Default values match specification
2. Implement `token-budget.ts`
3. Verify: `bun test packages/operative/src/context/token-budget.test.ts`

### Phase 2: Compaction Strategies

1. Write tests for each strategy:
   - Sliding window drops messages beyond window size, preserves system messages
   - Selective pruning drops old tool results but keeps tool calls
   - Hybrid combines summarization + pruning
   - All strategies respect `retainRecentMessages`
   - All strategies preserve pending tool call/result pairs
2. Implement `compaction-strategies.ts`
3. Verify: `bun test packages/operative/src/context/compaction-strategies.test.ts`

### Phase 3: Context Assembly

1. Write tests for `createContextAssembler()`:
   - Always includes system messages
   - Always includes recent N messages
   - Always includes pending tool results
   - Respects budget allocations per slice
   - Excludes redacted messages
   - Excludes already-summarized messages
   - Returns accurate budget report
   - Handles empty conversation
   - Handles conversation shorter than `recentMessageCount`
2. Implement `assembly.ts`
3. Verify: `bun test packages/operative/src/context/assembly.test.ts`

### Phase 4: Hook Integration

1. Write tests for new hooks in `OperativeHookMap`:
   - `beforeContextAssembly` receives correct context, can inject messages
   - `afterContextAssembly` receives assembled messages and budget report
   - `beforeCompaction` can cancel compaction by returning false
   - `afterCompaction` receives stats
2. Extend `hooks.ts` with new hook types
3. Integrate into `loop.ts`
4. Verify: `bun test packages/operative/src/context/` && `bun test packages/operative/`

### Phase 5: Subagent Context

1. Write tests for `prepareSubagentContext()`:
   - Includes parent system messages
   - Includes summary of recent parent context
   - Injects subagent instructions
   - Does not include full parent history
2. Write tests for `mergeSubagentResult()`:
   - Merges child output as tool result in parent
   - Preserves parent conversation integrity
3. Implement `subagent-context.ts`
4. Verify: `bun test packages/operative/src/context/subagent-context.test.ts`

### Phase 6: Integration

1. Wire context assembler into `loop.ts` as a `GenerateMiddleware`
2. Update `ContextManagementOptions` in `types.ts` with new fields
3. Ensure backward compatibility: existing `onCompact` usage still works
4. Run full suite: `turbo run test --filter=operative`
5. Run cross-package: `turbo run validate`

## Acceptance Criteria

- [ ] `createTokenBudget()` exported from `operative`
- [ ] `createContextAssembler()` exported from `operative`
- [ ] Sliding window, selective pruning, and hybrid compaction strategies exported
- [ ] `prepareSubagentContext()` and `mergeSubagentResult()` exported
- [ ] `OperativeHookMap` includes `beforeContextAssembly`, `afterContextAssembly`, `beforeCompaction`, `afterCompaction`
- [ ] `ContextManagementOptions` extended with `strategy`, `minimumResponseTokens`, `warningThreshold`, `compactionThreshold`
- [ ] Existing `createContextCompactor` still works unchanged (backward compatible)
- [ ] Token budget emits warning event via ActiveRun when threshold crossed
- [ ] Context assembly always reserves `minimumResponseTokens` for response
- [ ] Assembly excludes redacted and already-summarized messages
- [ ] Subagent context includes parent system messages but not full history
- [ ] 100% test coverage: `bun test --coverage packages/operative/src/context/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies added (all types/interfaces only)
- [ ] All new modules follow factory-function pattern (no classes)
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/operative/src/context/     # Unit tests
bun test --coverage packages/operative/      # Coverage
turbo run check-types --filter=operative     # Type check
turbo run lint --filter=operative            # Lint
turbo run validate                           # Full pipeline
```

<promise>CONTEXT_ENGINE_COMPLETE</promise>
<promise>CONTEXT_ENGINE_FAILED</promise>
