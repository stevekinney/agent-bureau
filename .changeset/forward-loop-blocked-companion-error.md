---
'armorer': minor
---

A `loop-blocked` toolbox rejection now dispatches a companion `error` event carrying the same rejected `ToolExecutionResult`, mirroring the existing `budget-exceeded`-then-`error` pattern (AB-231, ratifying AB-87's armorer-surface decision). Previously `loop-blocked` returned its `blocked` result directly with no companion `error` event, so operative's generic toolbox-event forwarding never observed a blocked call — the run layer saw no signal at all. `loop-warning`'s non-blocking, advisory-only semantics are unchanged.
