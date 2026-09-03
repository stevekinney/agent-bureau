---
'@lostgradient/operative': minor
---

Adds AB-222's (AB-90 child ab90-02) child terminal lifecycle and relationship-query events, per AB-87's decision record.

Two new event classes join `events.ts`'s existing `ChildWorkflowStartedEvent`/`ChildWorkflowCompletedEvent`/`ChildWorkflowFailedEvent`/`ChildWorkflowAbortedEvent` (AB-50): `ChildWorkflowReattachedEvent` (`multiagent.child-workflow.reattached`, carrying `childRunId`/`parentRunId`) and `ChildWorkflowProgressEvent` (`multiagent.child-workflow.progress`, additionally carrying the child's own `SemanticProgress`, AB-88/AB-214). `ChildWorkflowReattachedEvent` is typed and exported but never dispatched by this package — it defines the type, payload shape, and intended dispatch point for AB-53's persisted parent-child topology recovery, which has not shipped yet. `ChildWorkflowProgressEvent` is explicitly non-cursor-advancing, an ephemeral delta rather than a durable state transition. Both are added to `OperativeEventMap`.

`child-run.ts` gains `listChildRuns(registry: ChildRunRegistry, parentRunId: string): readonly ChildRunSummary[]` — a relationship-query function that enumerates every known child of a given `parentRunId`, with each child's current terminal status (`'completed' | 'failed' | 'aborted'`) or `undefined` while still running, without throwing for a parent with zero children. Deliberately an operative-level export over `ChildRunRegistry` (AB-50), not `bureau.*` — a Bureau-namespaced wrapper, if wanted later, is built separately.

Additive only.
