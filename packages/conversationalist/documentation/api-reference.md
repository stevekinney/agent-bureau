# Conversationalist Public API Reference

This document tracks the published export map in [package.json](/Users/stevekinney/Developer/agent-bureau/packages/conversationalist/package.json).

## Export Map

| Entry point                            | Purpose                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `conversationalist`                    | Common runtime surface for immutable histories, the `Conversation` class, guards, errors, and core tool helpers |
| `conversationalist/conversation`       | Pure immutable conversation helpers                                                                             |
| `conversationalist/context`            | Token estimation and truncation helpers                                                                         |
| `conversationalist/streaming`          | Streaming-message helpers                                                                                       |
| `conversationalist/history`            | `Conversation` class and event types                                                                            |
| `conversationalist/message`            | Message formatting and narrowing helpers                                                                        |
| `conversationalist/utilities`          | Content, message, transient-metadata, pairing, and helper utilities                                             |
| `conversationalist/test`               | Deterministic test helpers                                                                                      |
| `conversationalist/markdown`           | Markdown serialization and parsing                                                                              |
| `conversationalist/export`             | Export helpers                                                                                                  |
| `conversationalist/schemas`            | Runtime validation schemas                                                                                      |
| `conversationalist/adapters/openai`    | OpenAI message adapter                                                                                          |
| `conversationalist/adapters/anthropic` | Anthropic message adapter                                                                                       |
| `conversationalist/adapters/gemini`    | Gemini message adapter                                                                                          |
| `conversationalist/redaction`          | PII redaction helpers                                                                                           |
| `conversationalist/versioning`         | Schema-version constant                                                                                         |
| `conversationalist/sort`               | Deterministic sort helpers                                                                                      |

## `conversationalist`

### Functions

- `appendAssistantMessage`
- `appendMessages`
- `appendSystemMessage`
- `appendToolCall`
- `appendToolCalls`
- `appendToolResult`
- `appendToolResultAsync`
- `appendToolResults`
- `appendToolResultsAsync`
- `appendUnsafeMessage`
- `appendUserMessage`
- `assertConversationHistoryIntegrity`
- `collapseSystemMessages`
- `createConversationHistory`
- `createConversationHistoryUnsafe`
- `deserializeConversationHistory`
- `getFirstSystemMessage`
- `getMessageAtPosition`
- `getMessageById`
- `getMessageIds`
- `getMessages`
- `getPendingToolCalls`
- `getStatistics`
- `getSystemMessages`
- `getToolInteractions`
- `hasSystemMessage`
- `materializeToolCall`
- `materializeToolCalls`
- `materializeToolResult`
- `materializeToolResultAsync`
- `materializeToolResults`
- `materializeToolResultsAsync`
- `pipeConversationHistory`
- `prependSystemMessage`
- `redactMessageAtPosition`
- `replaceSystemMessage`
- `searchConversationMessages`
- `toChatMessages`
- `validateConversationHistoryIntegrity`
- `withConversationHistory`

### Guards

- `isConversationHistory`
- `isConversationStatus`
- `isJSONValue`
- `isMessage`
- `isMessageInput`
- `isMessageRole`
- `isMultiModalContent`
- `isTokenUsage`
- `isToolCall`
- `isToolResult`

### Errors

- `ConversationalistError`
- `createDuplicateIdError`
- `createInvalidInputError`
- `createInvalidPositionError`
- `createInvalidToolReferenceError`
- `createLockedError`
- `createNotFoundError`
- `createSerializationError`
- `createValidationError`

### Class

- `Conversation`

### Root types

- `AppendToolCallOptions`
- `AppendToolResultOptions`
- `AppendableToolAction`
- `AppendableToolCallInput`
- `AppendableToolError`
- `AppendableToolResult`
- `AssistantMessage`
- `ChatMessage`
- `ChatMessageRole`
- `ConversationActionType`
- `ConversationEnvironment`
- `ConversationEvent`
- `ConversationEventDetail`
- `ConversationEvents`
- `ConversationEventType`
- `ConversationHistory`
- `ConversationHistoryDraft`
- `ConversationNodeSnapshot`
- `ConversationProvider`
- `ConversationSnapshot`
- `ConversationStatus`
- `ConversationalistErrorCode`
- `ImageContent`
- `IntegrityIssue`
- `IntegrityIssueCode`
- `JSONValue`
- `MaterializeToolCallOptions`
- `Message`
- `MessageInput`
- `MessageRole`
- `MultiModalContent`
- `RedactMessageOptions`
- `TextContent`
- `TokenUsage`
- `ToolAction`
- `ToolActionInput`
- `ToolCall`
- `ToolCallInput`
- `ToolError`
- `ToolErrorCategory`
- `ToolErrorInput`
- `ToolInteraction`
- `ToolResult`
- `ToolResultInput`

## `Conversation` class

### Static methods

- `Conversation.from(snapshot, environment?)`
- `Conversation.fromProvider(provider, payload, environment?)`
- `Conversation.fromOpenAIMessages(messages, environment?)`
- `Conversation.fromAnthropicMessages(payload, environment?)`
- `Conversation.fromGeminiMessages(payload, environment?)`

### Event methods

- `addEventListener(type, listener, options?)`
- `removeEventListener(type, listener, options?)`
- `dispatchEvent(event)`
- `watch(run)`
- `on(type, options?)`
- `once(type, listener, options?)`
- `subscribe(type, observerOrNext?, error?, complete?)`
- `toObservable()`
- `events(type, options?)`
- `complete()`
- `completed`

### State getters

- `current`
- `ids`
- `env`
- `branchCount`
- `branchIndex`
- `redoCount`
- `getSnapshot()`

### History methods

- `push(next)`
- `undo()`
- `redo(childIndex?)`
- `switchToBranch(index)`
- `getPath()`
- `snapshot()`

### Query methods

- `getMessages(options?)`
- `getMessageAtPosition(position)`
- `getMessageIds()`
- `getMessageById(id)`
- `get(id)`
- `searchMessages(predicate)`
- `getStatistics()`
- `hasSystemMessage()`
- `getFirstSystemMessage()`
- `getSystemMessages()`
- `toChatMessages()`
- `estimateTokens(estimator?)`
- `getRecentMessages(limit, options?)`
- `getStreamingMessage()`
- `getPendingToolCalls()`
- `getToolInteractions()`

### Mutation methods

- `appendMessages(...inputs)`
- `appendUserMessage(content, metadata?)`
- `appendAssistantMessage(content, metadata?, goalCompleted?)`
- `appendSystemMessage(content, metadata?)`
- `prependSystemMessage(content, metadata?)`
- `replaceSystemMessage(content, metadata?)`
- `collapseSystemMessages()`
- `redactMessageAtPosition(position, options?)`
- `truncateFromPosition(position, options?)`
- `truncateToTokenLimit(maxTokens, options?)`
- `appendStreamingMessage(role, metadata?)`
- `updateStreamingMessage(messageId, content)`
- `finalizeStreamingMessage(messageId, options?)`
- `cancelStreamingMessage(messageId)`
- `appendToolCall(toolCall, options?)`
- `appendToolCalls(toolCalls)`
- `appendToolResult(toolResult, options?)`
- `appendToolResultAsync(toolResult, options?)`
- `appendToolResults(toolResults)`
- `appendToolResultsAsync(toolResults)`
- `appendProvider(provider, payload)`

### Provider export methods

- `toProvider(provider, options?)`
- `toOpenAIMessages()`
- `toOpenAIMessagesGrouped()`
- `toAnthropicMessages()`
- `toGeminiMessages()`

## `conversationalist/conversation`

### Functions

- `appendAssistantMessage`
- `appendMessages`
- `appendSystemMessage`
- `appendToolCall`
- `appendToolCalls`
- `appendToolResult`
- `appendToolResultAsync`
- `appendToolResults`
- `appendToolResultsAsync`
- `appendUnsafeMessage`
- `appendUserMessage`
- `assertConversationHistoryIntegrity`
- `collapseSystemMessages`
- `createConversationHistory`
- `createConversationHistoryUnsafe`
- `deserializeConversationHistory`
- `getFirstSystemMessage`
- `getMessageAtPosition`
- `getMessageById`
- `getMessageIds`
- `getMessages`
- `getPendingToolCalls`
- `getStatistics`
- `getSystemMessages`
- `getToolInteractions`
- `hasSystemMessage`
- `materializeToolCall`
- `materializeToolCalls`
- `materializeToolResult`
- `materializeToolResultAsync`
- `materializeToolResults`
- `materializeToolResultsAsync`
- `prependSystemMessage`
- `redactMessageAtPosition`
- `replaceSystemMessage`
- `searchConversationMessages`
- `toChatMessages`
- `validateConversationHistoryIntegrity`
- `withEnvironment`

### Types

- `AppendToolCallOptions`
- `AppendToolResultOptions`
- `AppendableToolAction`
- `AppendableToolCallInput`
- `AppendableToolError`
- `AppendableToolResult`
- `ConversationEnvironment`
- `IntegrityIssue`
- `IntegrityIssueCode`
- `MaterializeToolCallOptions`
- `RedactMessageOptions`
- `ToolCallInput`
- `ToolInteraction`

## `conversationalist/context`

### Functions

- `estimateConversationTokens`
- `getRecentMessages`
- `simpleTokenEstimator`
- `truncateFromPosition`
- `truncateToTokenLimit`

### Types

- `TruncateOptions`

## `conversationalist/streaming`

- `appendStreamingMessage`
- `cancelStreamingMessage`
- `finalizeStreamingMessage`
- `getStreamingMessage`
- `isStreamingMessage`
- `updateStreamingMessage`

## `conversationalist/history`

- `Conversation`
- `ConversationActionType`
- `ConversationEvent`
- `ConversationEventDetail`
- `ConversationEvents`
- `ConversationEventType`

## `conversationalist/message`

- `createMessage`
- `isAssistantMessage`
- `messageHasImages`
- `messageParts`
- `messageText`
- `messageToJSON`
- `messageToString`

## `conversationalist/utilities`

### Content helpers

- `normalizeContent`
- `toMultiModalArray`

### Message helpers

- `createMessage`
- `isAssistantMessage`
- `messageHasImages`
- `messageParts`
- `messageText`
- `messageToJSON`
- `messageToString`

### Tool pairing

- `pairToolCallsWithResults`
- `ToolCallPair`

### Transient metadata

- `isTransientKey`
- `stripTransientFromRecord`
- `stripTransientMetadata`

### General helpers

- `hasOwnProperty`
- `toReadonly`

## `conversationalist/test`

- `ConversationRecorder`
- `createConversationRecorder`
- `createTestConversation`
- `createTestConversationEnvironment`
- `TestConversationEnvironment`
- `TestConversationEnvironmentOptions`

## `conversationalist/markdown`

### Functions

- `conversationFromMarkdown`
- `conversationToMarkdown`
- `fromMarkdown`
- `getRoleFromLabel`
- `getRoleLabel`
- `toMarkdown`

### Constants and classes

- `LABEL_TO_ROLE`
- `MarkdownParseError`
- `ROLE_LABELS`

### Types

- `ToMarkdownOptions`

## `conversationalist/export`

- `exportMarkdown`
- `normalizeLineEndings`

## `conversationalist/schemas`

- `conversationSchema`
- `conversationShape`
- `jsonValueSchema`
- `messageInputSchema`
- `messageRoleSchema`
- `messageSchema`
- `multiModalContentSchema`
- `tokenUsageSchema`
- `toolActionSchema`
- `toolCallInputSchema`
- `toolCallSchema`
- `toolErrorCategorySchema`
- `toolErrorSchema`
- `toolResultSchema`

## `conversationalist/adapters/openai`

### Functions

- `appendOpenAIMessages`
- `fromOpenAIMessages`
- `toOpenAIMessages`
- `toOpenAIMessagesGrouped`

### Adapter object

- `openAIConversationAdapter`

### Types

- `OpenAIAssistantMessage`
- `OpenAIContentPart`
- `OpenAIConversationExportOptions`
- `OpenAIImageContentPart`
- `OpenAIMessage`
- `OpenAISystemMessage`
- `OpenAITextContentPart`
- `OpenAIToolCall`
- `OpenAIToolMessage`
- `OpenAIUserMessage`

## `conversationalist/adapters/anthropic`

### Functions

- `appendAnthropicMessages`
- `fromAnthropicMessages`
- `toAnthropicMessages`

### Adapter object

- `anthropicConversationAdapter`

### Types

- `AnthropicBase64ImageSource`
- `AnthropicContentBlock`
- `AnthropicConversation`
- `AnthropicImageBlock`
- `AnthropicImageSource`
- `AnthropicMessage`
- `AnthropicTextBlock`
- `AnthropicToolResultBlock`
- `AnthropicToolUseBlock`
- `AnthropicUrlImageSource`

## `conversationalist/adapters/gemini`

### Functions

- `appendGeminiMessages`
- `fromGeminiMessages`
- `toGeminiMessages`

### Adapter object

- `geminiConversationAdapter`

### Types

- `GeminiContent`
- `GeminiConversation`
- `GeminiFileDataPart`
- `GeminiFunctionCallPart`
- `GeminiFunctionResponsePart`
- `GeminiInlineDataPart`
- `GeminiPart`
- `GeminiTextPart`

## `conversationalist/redaction`

- `createPIIRedaction`
- `createPIIRedactionPlugin`
- `DEFAULT_PII_RULES`
- `redactPii`

## `conversationalist/versioning`

- `CURRENT_SCHEMA_VERSION`

## `conversationalist/sort`

- `sortMessagesByPosition`
- `sortObjectKeys`

## Root-only supporting types

These are exported from `conversationalist` but not from a dedicated subpath:

- `ConversationProvider`
- `ExportOptions`
- `MessagePlugin`
- `TokenEstimator`
- `ChatMessage`
- `ChatMessageRole`
- `ImageContent`
- `MultiModalContent`
- `TextContent`
