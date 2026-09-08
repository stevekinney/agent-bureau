---
'armorer': patch
---

Fix `combineToolboxes` silently dropping the first toolbox's approval configuration (AB-362). `combineToolboxes(...)` rebuilt a fresh toolbox forwarding only the shallow-merged `context`, so the first toolbox's `policy` (including any `needs_approval` `beforeExecute` hook), `approvalPolicy`, `approvalSecret`, `approvalStateStore`, and `grantStateStore` — along with the rest of its `ToolboxOptions` — were all lost. Any caller combining a toolbox that gates calls behind approval with additional tools (for example, Bureau's `wireDurableOptInTools`, which grafts the durable `requestHumanInput`/`scheduleWakeup` tools onto a run's toolbox) got a combined toolbox that executed every gated tool call immediately, with no pending review ever created and no reusable-approval-grant matching in effect — a live security-relevant regression.

`combineToolboxes` now forwards the first toolbox's own options into the combined toolbox, the same way `Toolbox.extend()` already forwards its own options into an extended toolbox. Combining multiple toolboxes is not a merge of approval configuration across them: only the first toolbox's approval gating governs calls to the combined toolbox, exactly as `extend()` already behaves for the toolbox `extend()` is called on.
