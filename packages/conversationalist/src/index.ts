export type {
  AppendToolCallOptions,
  AppendToolResultOptions,
  ConversationEnvironment,
  IntegrityIssue,
  IntegrityIssueCode,
  RedactMessageOptions,
  ToolInteraction,
} from './conversation/index';
export {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendToolCall,
  appendToolCalls,
  appendToolResult,
  appendToolResultAsync,
  appendToolResults,
  appendToolResultsAsync,
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
export { ConversationHistory } from './history';
export type { ImageContent, TextContent } from './multi-modal';
export type {
  AssistantMessage,
  Conversation,
  ConversationStatus,
  JSONValue,
  Message,
  MessageInput,
  MessageRole,
  TokenUsage,
  ToolAction,
  ToolCall,
  ToolCallInput,
  ToolError,
  ToolErrorCategory,
  ToolResult,
} from './types';
export type { ConversationHistorySnapshot, HistoryNodeSnapshot } from './types';
export type { ConversationDraft } from './with-conversation';
export { pipeConversation, withConversation } from './with-conversation';
export type {
  Message as ExternalMessage,
  MultiModalContent,
} from '@lasercat/homogenaize';
