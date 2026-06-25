---
"@lostgradient/armorer": patch
---

Add regression tests for externally-supplied idempotency keys with crash recovery, pinning the at-least-once executor safety contract: a caller-supplied key that was started but never recorded reports unknown-outcome on retry rather than blindly re-running the side effect.
