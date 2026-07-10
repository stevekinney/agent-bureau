---
"armorer": minor
---

Add MCP elicitation support in both directions, mapping onto the MCP spec's form/URL elicitation split.

- `ToolElicitationRequest` / `ToolElicitationResult` / `ToolElicitationRequester` (`armorer`): a transport-agnostic elicitation shape. `context.elicit` is now threaded through `createTool`'s execute context and `ToolExecuteOptions`/`createToolbox().execute()`, alongside `signal`/`timeout`/`stream`.
- `createMcpToolElicitationRequester` (`armorer/mcp`): the "MCP server" direction — lets a tool's `execute` ask the connected MCP client for approval or human input mid-execution via `extra.sendRequest`. Wired automatically into every tool registered through `createMCP`, so `context.elicit(...)` just works.
- `createMcpElicitationHandler` (`armorer/mcp`): the "MCP client" direction — adapts a `ToolElicitationRequester` into an MCP client request handler for `elicitation/create`. Register it with `client.setRequestHandler(ElicitRequestSchema, ...)` to answer elicitation requests raised by a connected server, including ones raised while executing a tool imported via `fromMcpTools`.
- `jsonSchemaToZod` is now exported from the package root (previously internal to the MCP integration only), so consumers can convert an elicitation's JSON Schema `requestedSchema` into a Zod schema.

Also builds the operative-side bridge: `createMcpElicitationResponder` (`operative`, unpublished) adapts an MCP elicitation request into the loop's existing `onElicitation` mechanism, dispatching the same `ElicitationRequestedEvent`/`ElicitationResolvedEvent` the in-loop `elicit()` helper already emits.
