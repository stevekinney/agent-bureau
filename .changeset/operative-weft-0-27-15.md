---
'@lostgradient/operative': minor
---

Adopt Weft 0.27.15 and add the managed-goal workflow and decision APIs used by Bureau goal persistence and recovery.

- Add the durable goal workflow: `createGoalWorkflow`, the `goalRun` workflow type and its ports, signals, record and result types, and the goal workflow transition helpers. `createRunEngine` accepts an optional `goalWorkflow`, registered beside `agentRun` on the same engine and store.
- Export the pure goal decision layer from the package root: `decideOutcome`, `decideRunFinish`, `decideRetryOrExhaust`, `decideCancellation`, `decideAttemptRunFailure` and `decideDeterminismRequirement`, `validateGoalConfiguration` and the budget, retry and conversation-policy validators, `goalAttemptInput`, the terminal-status constants, and the `GoalDecision` and projected validator types. `startGoal` routes attempt outcomes through them and keeps its public signature; whole-goal cancellation still finishes the goal directly. It now ends a goal as duration-elapsed when a validator verdict arrives after the goal's maximum total duration.
- Add `executeValidator`, `createFreshAttemptSession`, `readDurableRunResult`, and the reserved goal identifier prefixes and helpers. Export `reconcileTerminalRunRef` and `conversationThroughRun` from the session entry point; `reconcileTerminalRunRef` accepts `requireConversation`. The `CheckpointStore` load methods accept `{ strict: true }`, so a persisted value that is not valid JSON rejects instead of reading as absent.
- `DurableEventOwnerKind` gains `'goal'` for goal audit events.
- Add the `beforeBackgroundCompaction` hook, which can withdraw a background compaction request. `BeforeCompactionHookContext` gains an optional `signal`, which is also passed to `beforeCompaction`.
- A durable run whose checkpoint compare-and-swap is won by another engine (`WorkflowCheckpointConflictError`) now stops without writing a terminal record, as for a disposed engine.

Upgrade notes:

- `OperativeHookMap` has a new required `beforeBackgroundCompaction` member. Code that builds a complete `OperativeHookMap` object literal must add it; registering handlers needs no change. Exhaustive switches over `DurableEventOwnerKind` need a `'goal'` case.
- Checkpoint keys now escape `:` and `%` in run ids, so one run's keys can no longer fall under another run's prefix. Checkpoints written by 0.15.x stay readable: for an id whose keys changed (every session run id, `${sessionId}:${sequence}`, and any id with `:` or `%`), reads fall back to the 0.15.x keys and `clear` removes both. One exception: a caller-chosen id that is itself the escaped form of a different id (no `:`, and every `%` begins `%25` or `%3A`, such as `a%3Ab`) does not read its 0.15.x checkpoint: that key is now the other id's (`a:b`), which reads it as its own.
- `createAgentSchedule` rejects a `session` that, after trimming surrounding whitespace, starts with a reserved goal prefix (`goal:`, `goal-` or `bureau-goal-audit:`).
