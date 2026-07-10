---
'armorer': minor
---

Add MCP Tasks-extension support to `createMCP` (`armorer/mcp`), implemented against `@modelcontextprotocol/sdk`'s experimental Tasks module (MCP spec revision `2025-11-25`, methods `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` — there is no `tasks/update`; clients poll status via repeated `tasks/get` calls and fetch the final payload via `tasks/result`).

A tool becomes task-backed by giving it an MCP `execution.taskSupport` of `'required'` or `'optional'` (via `tool.metadata.mcp.execution` or `createMCP`'s `toolConfiguration()` callback). `createMCP` then:

- Registers the tool with `server.experimental.tasks.registerToolTask(...)` instead of `server.registerTool(...)`, and advertises the server `tasks` capability (`requests.tools.call`, `list`, `cancel`) required for clients to negotiate task-augmented `tools/call`.
- Runs the tool's execution in the background against a per-task `AbortController`, recording the outcome via the request-scoped `RequestTaskStore` so `tasks/get` can poll status and `tasks/result` can retrieve the completed/failed result.
- Defaults to a fresh `InMemoryTaskStore` when no `taskStore` is supplied in `CreateMCPOptions` (still overridable, since `taskStore` flows straight through the underlying `ServerOptions`/`ProtocolOptions`).
- Wraps whichever `TaskStore` is in play so that a client's `tasks/cancel` — which the SDK implements as `taskStore.updateTaskStatus(taskId, 'cancelled', ...)` — actually aborts the tool's `AbortSignal` instead of only flipping a status flag, so cancellation stops real work.

Covered by an in-memory client/server pair (`InMemoryTransport`) exercising the full lifecycle: create a task-backed tool call, poll `tasks/get` while it's `working`, resolve it and confirm `tasks/get` reports `completed` with the correct `tasks/result` payload; a second scenario cancels a running task via `tasks/cancel` and asserts the tool's `AbortSignal` actually fired (neuter-verified: reverting the cancel→abort wiring makes that assertion fail); a third confirms the `tasks` server capability is only advertised when at least one tool opts in.

Bumps the `@modelcontextprotocol/sdk` peer/dev dependency floor to `^1.29.0` — the `types` export condition for the `./experimental/tasks` subpath (where the Tasks extension's runtime and types live) was only added in that release.
