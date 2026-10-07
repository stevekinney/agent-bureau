---
'@lostgradient/operative': minor
---

Adopt Weft 0.27.15 and add the managed-goal workflow and decision APIs used by Bureau goal persistence and recovery.

- Add the durable goal workflow: `createGoalWorkflow`, the `goalRun` workflow type and its ports, signals, record and result types, and the goal workflow transition helpers. `createRunEngine` accepts an optional `goalWorkflow`, registered beside `agentRun` on the same engine and store.
- Export the pure goal decision layer from the package root: the `decide*` functions, `validateGoalConfiguration` and the budget, retry and conversation-policy validators, `goalAttemptInput`, the terminal-status constants, and the `GoalDecision` and projected validator types. `startGoal` routes every outcome through them and keeps its public signature. It now ends a goal as duration-elapsed when a validator verdict arrives after the goal's maximum total duration.
- Add `executeValidator`, `createFreshAttemptSession`, `readDurableRunResult`, and the reserved goal identifier prefixes and helpers. Export `reconcileTerminalRunRef` and `conversationThroughRun` from the session entry point; `reconcileTerminalRunRef` accepts `requireConversation`. The `CheckpointStore` load methods accept `{ strict: true }` so malformed persisted data rejects instead of reading as absent.
- `DurableEventOwnerKind` gains `'goal'` for goal audit events.
- Add the `beforeBackgroundCompaction` hook, which can withdraw a background compaction request. `BeforeCompactionHookContext` gains an optional `signal`, which is also passed to `beforeCompaction`.
- A durable run whose checkpoint compare-and-swap is won by another engine (`WorkflowCheckpointConflictError`) now stops without writing a terminal record, as for a disposed engine.

Upgrade notes:

- `OperativeHookMap` has a new required `beforeBackgroundCompaction` member. Code that builds a complete `OperativeHookMap` object literal must add it; registering handlers needs no change. Exhaustive switches over `DurableEventOwnerKind` need a `'goal'` case.
- Checkpoint keys now escape `:` and `%` in run ids. Ids without either character, which includes every id the engine generates, keep their keys. A durable run with a caller-chosen id containing `:` or `%` does not find a checkpoint written by an earlier version.
- `createAgentSchedule` rejects a `session` that starts with a reserved goal prefix (`goal:`, `goal-` or `bureau-goal-audit:`).
