// Multi-modal types and helpers (re-exported from @lasercat/homogenaize)
export type { ImageContent, TextContent } from './multi-modal';
export { copyContent, copyMultiModalContent } from './multi-modal';
export type {
  Message as ExternalMessage,
  MultiModalContent,
} from '@lasercat/homogenaize';

// Types
export type {
  AssistantMessage,
  Conversation,
  ConversationStatus,
  ExportOptions,
  JSONValue,
  Message,
  MessageInput,
  MessageRole,
  TokenUsage,
  ToMarkdownOptions,
  ToolCall,
  ToolResult,
} from './types';

// Schemas
export {
  conversationSchema,
  conversationShape,
  jsonValueSchema,
  messageInputSchema,
  messageRoleSchema,
  messageSchema,
  multiModalContentSchema,
  tokenUsageSchema,
  toolCallSchema,
  toolResultSchema,
} from './schemas';

// Functional conversation API
export type {
  AppendToolResultOptions,
  AppendToolUseOptions,
  ConversationEnvironment,
  IntegrityIssue,
  IntegrityIssueCode,
  RedactMessageOptions,
  ToolInteraction,
  ToolResultInput,
  ToolUseInput,
} from './conversation/index';
export {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendToolResult,
  appendToolUse,
  appendUnsafeMessage,
  appendUserMessage,
  assertConversationIntegrity,
  collapseSystemMessages,
  createConversation,
  createConversationUnsafe,
  deserializeConversation,
  getFirstSystemMessage,
  getMessageAtPosition,
  getMessageById,
  getMessageIds,
  getMessages,
  getPendingToolCalls,
  getStatistics,
  getSystemMessages,
  getToolInteractions,
  hasSystemMessage,
  prependSystemMessage,
  redactMessageAtPosition,
  replaceSystemMessage,
  searchConversationMessages,
  toChatMessages,
  validateConversationIntegrity,
} from './conversation/index';
export { withEnvironment } from './environment';

// Message helpers
export { createMessage, isAssistantMessage } from './utilities';

// Errors
export type { ConversationalistErrorCode } from './errors';
export {
  ConversationalistError,
  createDuplicateIdError,
  createInvalidInputError,
  createInvalidPositionError,
  createInvalidToolReferenceError,
  createLockedError,
  createNotFoundError,
  createSerializationError,
  createValidationError,
} from './errors';

// Utilities
export type { ToolCallPair } from './utilities';
export {
  isTransientKey,
  normalizeContent,
  pairToolCallsWithResults,
  stripTransientFromRecord,
  stripTransientMetadata,
  toMultiModalArray,
} from './utilities';

// Type guards
export {
  isConversation,
  isConversationStatus,
  isJSONValue,
  isMessage,
  isMessageInput,
  isMessageRole,
  isMultiModalContent,
  isTokenUsage,
  isToolCall,
  isToolResult,
} from './guards';

// Builder utility
export type { ConversationDraft } from './with-conversation';
export { pipeConversation, withConversation } from './with-conversation';

// History utility
export { ConversationHistory } from './history';
export type { ConversationHistorySnapshot, HistoryNodeSnapshot } from './types';

// Streaming utilities
export {
  appendStreamingMessage,
  cancelStreamingMessage,
  finalizeStreamingMessage,
  getStreamingMessage,
  isStreamingMessage,
  updateStreamingMessage,
} from './streaming';

// Context window utilities
export {
  estimateConversationTokens,
  getRecentMessages,
  simpleTokenEstimator,
  truncateFromPosition,
  truncateToTokenLimit,
} from './context';
