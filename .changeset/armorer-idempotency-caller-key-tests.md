---
"armorer": patch
---

Add regression tests for externally-supplied idempotency keys with crash recovery, pinning the at-least-once executor safety contract: a caller-supplied key left in the durable "started" state (driven directly via the cache primitive, decoupled from any thrown-error path) reports unknown-outcome on retry rather than blindly re-running the side effect. A second test pins the thrown-uncategorized-error orphaned-start path explicitly.
