// Re-export environment type
export type { ConversationEnvironment } from '../environment';
export { withEnvironment } from '../environment';

// Create
export { createConversation, createConversationUnsafe } from './create';

// Append
export {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendUnsafeMessage,
  appendUserMessage,
} from './append';

// Query
export {
  getMessageAtPosition,
  getMessageById,
  getMessageIds,
  getMessages,
  getStatistics,
  searchConversationMessages,
} from './query';

// System messages
export {
  collapseSystemMessages,
  getFirstSystemMessage,
  getSystemMessages,
  hasSystemMessage,
  prependSystemMessage,
  replaceSystemMessage,
} from './system-messages';

// Modify
export type { RedactMessageOptions } from './modify';
export { redactMessageAtPosition } from './modify';

// Serialization
export { deserializeConversation } from './serialization';

// Integrity
export type { IntegrityIssue, IntegrityIssueCode } from './integrity';
export { assertConversationIntegrity, validateConversationIntegrity } from './integrity';

// Transform
export { toChatMessages } from './transform';

// Tool interactions
export type { ToolCallInput } from '../types';
export type {
  AppendToolCallOptions,
  AppendToolResultOptions,
  ToolInteraction,
} from './tool-interactions';
export {
  appendToolCall,
  appendToolCalls,
  appendToolResult,
  appendToolResultAsync,
  appendToolResults,
  appendToolResultsAsync,
  getPendingToolCalls,
  getToolInteractions,
} from './tool-interactions';
