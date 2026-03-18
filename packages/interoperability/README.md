# Interoperability

`interoperability` contains the shared tool-call and tool-result model used by `armorer` and `conversationalist`.

It exists so both packages can agree on one JSON-safe public contract for:

- tool call input
- tool call materialization
- tool result input
- tool result materialization
- canonical tool error and action payloads

## Public API

### Types

- `JSONPrimitive`
- `JSONValue`
- `ToolAction`
- `ToolActionInput`
- `ToolCall`
- `ToolCallInput`
- `ToolError`
- `ToolErrorCategory`
- `ToolErrorInput`
- `ToolResult`
- `ToolResultInput`
- `MaterializeToolCallOptions`

### Functions

- `materializeToolCall`: normalize one `ToolCallInput` into a canonical `ToolCall`.
- `materializeToolCalls`: normalize multiple tool calls.
- `materializeToolResult`: normalize one non-streaming `ToolResultInput` into a canonical `ToolResult`.
- `materializeToolResultAsync`: normalize one tool result while collecting async stream payloads when present.
- `materializeToolResults`: normalize multiple non-streaming tool results.
- `materializeToolResultsAsync`: normalize multiple tool results while collecting stream payloads when present.

## Notes

- All materialized output is JSON-safe.
- Missing tool-call identifiers can be generated through `MaterializeToolCallOptions.generateId`.
- Synchronous tool-result materializers reject live streaming results and direct callers to the async variants.
- `armorer` and `conversationalist` both re-export this surface from their own package entry points.
