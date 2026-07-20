---
conversationalist: patch
---

Convert `web_search_tool_result` Anthropic server-tool blocks through `toAnthropicMessagesForSdk` instead of throwing, since the installed `@anthropic-ai/sdk` accepts it as a request content block. Block types that remain response-only in the installed SDK (`code_execution_tool_result`, `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result`, `web_fetch_tool_result`, `container_upload`) still throw, now with an explanatory comment documenting the SDK boundary.
