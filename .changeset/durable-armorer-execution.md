---
'armorer': minor
---

Add durable approval resume, parent trace context, structured head/tail truncation, and explicit fresh/deduped/unknown idempotency outcomes for at-least-once tool executors.

Pending approvals can now be signed with a toolbox `approvalSecret`. Approvals created before this release do not have an `approvalToken`, so recreate and re-approve them before resuming. The old `ToolExecuteOptions.approved` and `proposedArguments` policy bypass path has been removed; use `Toolbox.resumeApproval()` with a `SignedPendingToolApproval` instead. Cache keys produced by `withIdempotency()` and caller-supplied toolbox `idempotencyKey` values are now scoped as `toolName:key`; migrate those entries or clear affected idempotency caches before rollout.
