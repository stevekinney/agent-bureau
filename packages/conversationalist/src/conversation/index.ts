// Re-export environment type
export type { ConversationEnvironment } from '../environment';
export { withEnvironment } from '../environment';

// Create
export type { BuildMessageOptions } from './create';
export { buildMessage, createConversationHistory, createConversationHistoryUnsafe } from './create';

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
export type { RedactMessageOptions } from './modify';
export { redactMessageAtPosition } from './modify';

// Serialization
export { deserializeConversationHistory } from './serialization';

// Integrity
export type { IntegrityIssue, IntegrityIssueCode } from './integrity';
export {
  assertConversationHistoryIntegrity,
  validateConversationHistoryIntegrity,
} from './integrity';

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
export type {
  AppendToolCallOptions,
  AppendToolResultOptions,
  MaterializeToolCallOptions,
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
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
  resolveToolResult,
} from './tool-interactions';
