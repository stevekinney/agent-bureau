---
'armorer': patch
---

Emit the settled event for approval and input gated tool invocations so owning runtimes can finish cleanup after an `action_required` result.

Complete cancellation before the tool callback starts while preserving cleanup tracking for callbacks still running after abort.
