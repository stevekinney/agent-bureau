---
'armorer': minor
'@lostgradient/operative': patch
---

Carry run identity on armorer toolbox events and scope tool bubble events to the owning run on a shared toolbox (AB-290).

armorer's `execute-start`, `progress`, and `settled` events — at both the tool level and the toolbox level — now carry `executionId`, an id armorer mints fresh for every execution, and echo back an optional caller-supplied `ownerId` verbatim (`Tool.execute(call, { ownerId })` / `Toolbox.execute(calls, { ownerId })`, or `requestContext.authority.ownerId` when no explicit `ownerId` is given). `ownerId` stays `undefined` when nothing was supplied — it is never fabricated from armorer's internal bookkeeping default. Existing listeners that ignore the new fields keep working unchanged.

This also fixes two related armorer defects surfaced while wiring this up: a toolbox-registered tool's `context.dispatch`/`context.progress()` previously silently dropped to a no-op (the toolbox's internal re-wrap of a registered tool built a reduced context missing both fields), and two concurrent `Toolbox.execute()` calls to the SAME tool instance could cross-talk — each call's bubble-listener subscription broadcast every other concurrent call's tool-level events too, duplicating and mislabeling toolbox-level events when the underlying provider issued the same `ToolCall.id` to more than one call.

`@lostgradient/operative` replaces the `ownedToolCallIds`/`ToolCall.id`-based ownership tracking (never guaranteed unique across concurrent runs) with `ownerId`-based ownership: `Toolbox.execute()` calls now carry this run's own id as `ownerId`, and `tool.started`, `tool.settled`, and `tool.progress` — along with the in-flight tool accounting `closed()` depends on — are scoped to just the owning run, on both the in-memory and durable paths. Two concurrent runs sharing one `Toolbox`, even when the provider issues them the exact same `ToolCall.id`, now each see only their own accounting and bubble events.
