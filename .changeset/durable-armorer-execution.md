---
'armorer': minor
---

Add durable approval resume, parent trace context, structured head/tail truncation, and explicit fresh/deduped/unknown idempotency outcomes for at-least-once tool executors.

Pending approvals are now signed with a toolbox `approvalSecret`. Approvals created before this release do not have an `approvalToken`, so recreate and re-approve them before resuming. Idempotency entries are now scoped by tool name; clear existing idempotency caches or migrate keys to the `toolName:key` format before rollout.
