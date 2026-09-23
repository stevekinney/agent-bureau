// Re-export environment type
export { withEnvironment } from '../environment';
export type { ConversationEnvironment } from '../environment';

// Create
export { buildMessage, createConversationHistory, createConversationHistoryUnsafe } from './create';
export type { BuildMessageOptions } from './create';

// Append
export {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendUnsafeMessage,
  appendUserMessage,
  prependMessages,
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
export { removeMessage, replaceToolResult, setMessageHidden, updateMessage } from './modify';
export type { MessageUpdate } from './mutation-plugins';
export { redactMessageAtPosition, type RedactMessageOptions } from './redaction';

// Serialization
export { deserializeConversationHistory } from './serialization';

// Integrity
export {
  assertConversationHistoryIntegrity,
  validateConversationHistoryIntegrity,
} from './integrity';
export type { IntegrityIssue, IntegrityIssueCode } from './integrity';

// Transform
export { toChatMessages } from './transform';

// Tool interactions
export type {
  AppendableToolAction,
  AppendableToolCallInput,
  AppendableToolError,
  AppendableToolResult,
  ToolCallInput,
} from '../types';
export {
  appendToolCall,
  appendToolCalls,
  appendToolResult,
  appendToolResultAsync,
  appendToolResults,
  appendToolResultsAsync,
  getPendingToolCalls,
  getToolInteractions,
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from './tool-interactions';
export type {
  AppendToolCallOptions,
  AppendToolResultOptions,
  MaterializeToolCallOptions,
  ToolInteraction,
} from './tool-interactions';

export { resolveToolResult, resolveToolResultAsync } from './tool-resolution';
