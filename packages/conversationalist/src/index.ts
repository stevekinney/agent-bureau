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
  assertConversationHistoryIntegrity,
  collapseSystemMessages,
  createConversationHistory,
  createConversationHistoryUnsafe,
  deserializeConversationHistory,
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
  validateConversationHistoryIntegrity,
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
  isConversationHistory,
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
export { Conversation } from './history';
export type { ImageContent, TextContent } from './multi-modal';
export type {
  AssistantMessage,
  ConversationHistory,
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
export type { ConversationNodeSnapshot, ConversationSnapshot } from './types';
export type { ConversationHistoryDraft } from './with-conversation';
export {
  pipeConversationHistory,
  withConversationHistory,
} from './with-conversation';
export type {
  Message as ExternalMessage,
  MultiModalContent,
} from '@lasercat/homogenaize';
