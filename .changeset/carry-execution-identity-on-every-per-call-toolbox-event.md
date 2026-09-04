---
'armorer': minor
---

Every per-call toolbox event class now carries `executionId` and, when supplied, `ownerId` (AB-318, following up on AB-290's `execute-start`/`progress`/`settled`). That's fifteen more classes, at both the tool and toolbox level: `validate-success`, `validate-error`, `execute-success`, `execute-error`, `policy-denied`, `tool.started`, `tool.finished`, `stream-start`, `stream-chunk`, `stream-end`, `stream-error`, `output-chunk`, `log`, `cancelled`, and `status-update`/`status:update` — plus the toolbox-native `complete` and the two post-execute `error` emits. A caller sharing one `Toolbox` across more than one concurrent owner can now attribute every one of these to the exact execution that produced it, the same way it already could for the AB-290 trio.

The fix required widening `create-toolbox.ts`'s bubble-listener identity filter from the three AB-290 event types to all eighteen bubbled types — previously, only `execute-start`/`progress`/`settled` were scoped per call; every other bubbled event broadcast to every concurrently-attached listener on a shared `Tool` instance regardless of which invocation produced it. `status-update` and `cancelled` are dispatched by a tool body directly via `context.dispatch(new ToolStatusUpdateEvent(...))` rather than through an internal `emit()` call, so `context.dispatch` now reconstructs a known, identity-bearing event with the calling execution's identity stamped on before dispatching it, closing the one gap the widened filter alone would have missed.

**Excluded, with reason** (see the README's event table): `call`, `not-found`, `budget-exceeded`, `loop-warning`, `loop-blocked`, and the `error` emits on those admission paths fire before the tool is resolved and before this call's execution identity is minted — there is no execution to attribute yet. `query`/`search` are toolbox-wide, not per call. `policy-action-required` is tool-level only and is never bubbled onto a `Toolbox`'s event map.

This is purely additive — every field is optional and every existing listener that ignores the new fields keeps working unchanged.
