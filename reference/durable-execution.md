# Durable Execution and Checkpointing

## Overview

Session persistence (covered separately) saves agent state at step boundaries on clean stops. Durable execution is the stronger guarantee: checkpoint after _every_ LLM call, tool return, and decision so the agent can survive a process crash mid-execution and resume from the exact point of failure without data loss or duplicate side effects.

This work adds a checkpointing system to operative that captures fine-grained state within steps, integrates with idempotent tool execution (covered separately), and provides crash recovery.

## What Exists Today

Read these files to understand the current state:

- `packages/operative/src/agent-session.ts` — `AgentSession`, `saveAgentSession()`, `loadAgentSession()`
- `packages/operative/src/loop.ts` — the main execution loop
- `packages/operative/src/types.ts` — `RunOptions`, `StepResult`, `RunResult`
- `packages/operative/src/events.ts` — event types emitted during execution
- `packages/storage/src/types.ts` — `KeyValueStore` interface

## Product Requirements

### PR-1: Checkpoint Types

Define the state captured at each checkpoint:

```typescript
type CheckpointPhase =
  | 'step-start'
  | 'generate-complete'
  | 'tool-execution-complete'
  | 'step-complete'
  | 'run-complete';

interface Checkpoint {
  id: string;
  runId: string;
  phase: CheckpointPhase;
  step: number;
  timestamp: number;
  conversation: ConversationHistory;
  pendingToolCalls?: readonly ToolCall[];
  completedToolResults?: readonly ToolExecutionResult[];
  usage: TokenUsage;
  metadata: Record<string, JSONValue>;
}
```

### PR-2: Checkpoint Store

A `createCheckpointStore()` factory that manages checkpoint persistence:

```typescript
interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(runId: string): Promise<Checkpoint | undefined>;
  loadLatest(runId: string): Promise<Checkpoint | undefined>;
  list(runId: string): Promise<Checkpoint[]>;
  delete(runId: string): Promise<void>;
  cleanup(options: { olderThan: number }): Promise<number>;
}

function createCheckpointStore(store: KeyValueStore): CheckpointStore;
```

Checkpoints are stored under `checkpoint:<runId>:<step>:<phase>` keys. `loadLatest()` returns the most recent checkpoint for a run (for crash recovery).

### PR-3: Checkpoint Integration in the Loop

Add checkpointing to the operative loop via a `checkpointing` option:

```typescript
interface CheckpointingOptions {
  store: CheckpointStore;
  /** Which phases to checkpoint. Default: all phases. */
  phases?: CheckpointPhase[];
  /** Called before saving a checkpoint. Can veto by returning false. */
  beforeSave?: (checkpoint: Checkpoint) => Promise<boolean>;
  /** Called after a checkpoint is saved. */
  afterSave?: (checkpoint: Checkpoint) => Promise<void>;
}

interface RunOptions {
  // ... existing fields
  checkpointing?: CheckpointingOptions;
}
```

The loop saves checkpoints at each configured phase:

1. **`step-start`**: Before calling generate. Captures conversation state.
2. **`generate-complete`**: After generate returns. Captures response and pending tool calls.
3. **`tool-execution-complete`**: After all tools in the step have executed. Captures results.
4. **`step-complete`**: After tool results are appended to conversation.
5. **`run-complete`**: When the run finishes (any finish reason).

### PR-4: Crash Recovery

`resumeFromCheckpoint()` loads the latest checkpoint and continues execution:

```typescript
interface ResumeOptions {
  checkpointStore: CheckpointStore;
  runId: string;
  /** The same RunOptions used for the original run. */
  runOptions: Omit<RunOptions, 'conversation'>;
}

function resumeFromCheckpoint(options: ResumeOptions): Promise<{
  activeRun: ActiveRun;
  resumedFrom: Checkpoint;
} | undefined>;
```

Resume logic by checkpoint phase:

- **`step-start`**: Re-run the step from the beginning (call generate).
- **`generate-complete`**: Skip generate, re-execute pending tool calls.
- **`tool-execution-complete`**: Skip tool execution, append results to conversation, continue to next step.
- **`step-complete`**: Start the next step.
- **`run-complete`**: Run is already finished, return the result.

### PR-5: Checkpoint Pruning

Old checkpoints consume storage. Provide automatic pruning:

- **Per-run**: Keep only the latest N checkpoints per run (default: 10). Older ones deleted after each save.
- **Global**: `checkpointStore.cleanup({ olderThan })` deletes checkpoints older than a threshold.
- **On completion**: When a run completes successfully, optionally delete all intermediate checkpoints (keeping only `run-complete`).

```typescript
interface CheckpointingOptions {
  // ... existing fields
  /** Max checkpoints to keep per run. Default: 10. */
  maxPerRun?: number;
  /** Delete intermediate checkpoints on successful completion. Default: true. */
  pruneOnComplete?: boolean;
}
```

## Architecture

### New Files

In `packages/operative/src/checkpointing/`:

- `types.ts` — `Checkpoint`, `CheckpointPhase`, `CheckpointStore`, `CheckpointingOptions`, `ResumeOptions`
- `create-checkpoint-store.ts` — `createCheckpointStore()` factory
- `checkpoint-serialization.ts` — serialize/deserialize checkpoints (conversation, tool results)
- `resume-from-checkpoint.ts` — `resumeFromCheckpoint()` function
- `index.ts` — re-exports

### Extended Files

- `packages/operative/src/types.ts` — add `checkpointing` to `RunOptions`
- `packages/operative/src/loop.ts` — save checkpoints at each phase
- `packages/operative/src/index.ts` — re-export checkpointing modules

## Implementation Order (TDD)

### Phase 1: Checkpoint Serialization

1. Write tests:
   - Serialize checkpoint with conversation → valid JSON string
   - Deserialize JSON string → identical checkpoint
   - Tool calls with complex arguments survive round-trip
   - Tool results with various types survive round-trip
   - Usage counters preserved
   - Metadata preserved
2. Implement `checkpoint-serialization.ts`
3. Verify: `bun test packages/operative/src/checkpointing/checkpoint-serialization.test.ts`

### Phase 2: Checkpoint Store

1. Write tests for `createCheckpointStore()`:
   - `save()` persists checkpoint, retrievable via `load()`
   - `loadLatest()` returns the most recent checkpoint for a run
   - `loadLatest()` returns undefined for nonexistent run
   - `list()` returns all checkpoints for a run in order
   - `delete()` removes all checkpoints for a run
   - `cleanup()` deletes checkpoints older than threshold
   - `cleanup()` returns count of deleted entries
   - Multiple runs stored independently
   - Key format matches `checkpoint:<runId>:<step>:<phase>`
2. Implement `create-checkpoint-store.ts`
3. Verify: `bun test packages/operative/src/checkpointing/create-checkpoint-store.test.ts`

### Phase 3: Loop Integration

1. Write tests:
   - Checkpoint saved at `step-start` before generate call
   - Checkpoint saved at `generate-complete` after generate returns
   - Checkpoint saved at `tool-execution-complete` after tool execution
   - Checkpoint saved at `step-complete` after conversation update
   - Checkpoint saved at `run-complete` when run finishes
   - `phases` option limits which checkpoints are saved
   - `beforeSave` returning false prevents checkpoint
   - `afterSave` called after successful save
   - `maxPerRun` prunes old checkpoints
   - `pruneOnComplete` deletes intermediate checkpoints on success
   - Existing behavior unchanged when `checkpointing` not provided
2. Update `loop.ts`
3. Verify: `bun test packages/operative/`

### Phase 4: Crash Recovery

1. Write tests for `resumeFromCheckpoint()`:
   - Resume from `step-start` → re-runs generate
   - Resume from `generate-complete` → re-executes tool calls
   - Resume from `tool-execution-complete` → appends results, continues
   - Resume from `step-complete` → starts next step
   - Resume from `run-complete` → returns finished result
   - Returns undefined when no checkpoint exists
   - Resumed run emits events from the resume point onward
   - Conversation state matches checkpoint exactly
2. Implement `resume-from-checkpoint.ts`
3. Verify: `bun test packages/operative/src/checkpointing/resume-from-checkpoint.test.ts`

### Phase 5: Full Integration

1. Run full suite: `turbo run validate`

## Acceptance Criteria

- [ ] `createCheckpointStore()` exported from `operative`
- [ ] `resumeFromCheckpoint()` exported from `operative`
- [ ] Checkpoints saved at 5 phases: step-start, generate-complete, tool-execution-complete, step-complete, run-complete
- [ ] `CheckpointingOptions.phases` limits which phases checkpoint
- [ ] `beforeSave` hook can veto checkpoint saves
- [ ] `loadLatest()` returns most recent checkpoint for a run
- [ ] Resume from `step-start` re-runs generate
- [ ] Resume from `generate-complete` re-executes tools (requires idempotent tools)
- [ ] Resume from `step-complete` starts next step
- [ ] `maxPerRun` prunes old checkpoints
- [ ] `pruneOnComplete` deletes intermediate checkpoints on success
- [ ] `cleanup()` deletes checkpoints older than threshold
- [ ] Existing run behavior unchanged when `checkpointing` not provided
- [ ] Checkpoint serialization survives round-trip for all data types
- [ ] 100% test coverage: `bun test --coverage packages/operative/src/checkpointing/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/operative/src/checkpointing/  # Checkpointing tests
bun test --coverage packages/operative/          # Coverage
turbo run check-types --filter=operative         # Type check
turbo run lint --filter=operative                # Lint
turbo run validate                               # Full pipeline
```

<promise>DURABLE_EXECUTION_COMPLETE</promise>
<promise>DURABLE_EXECUTION_FAILED</promise>
