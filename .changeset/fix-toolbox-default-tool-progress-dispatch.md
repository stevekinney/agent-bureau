---
'armorer': patch
---

Fix `buildDefaultTool` (`packages/armorer/src/create-toolbox.ts`) dropping `progress` and `dispatch` off the runtime tool context handed to a tool body registered on a toolbox as a raw configuration (as opposed to an already-built `createTool(...)` `Tool`). Previously `context.progress(...)` and `context.dispatch(...)` silently no-opped inside such a tool's body, so no consumer of `tool.progress` — operative's curated bubble, the gateway live stream, or AB-88's liveness — ever saw progress reported by a real tool executed through a toolbox.

`buildDefaultTool` now merges the runtime tool context onto the tool body's execution context through a new shared helper, `mergeRuntimeToolContext` (`packages/armorer/src/runtime-tool-context.ts`), instead of hand-listing each field — so `context.progress`/`context.dispatch` behave exactly as they do on the direct `createTool(...).execute` path, and a future field added to `RuntimeToolContext` reaches both paths without needing a matching update here.
