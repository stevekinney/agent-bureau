export type {
  CompactionResult,
  Summarizer,
  CompactionOptions as SummarizingCompactionOptions,
} from './compaction/index';
export { compactConversation as compactConversationWithSummarizer } from './compaction/index';
export type {
  ConditionalInstructionComposer,
  ConditionalInstructionComposerRenderOptions,
  ConditionalInstructionSection,
  InstructionComposer,
  InstructionComposerRenderOptions,
  InstructionContext,
  InstructionSection,
  InstructionTemplate,
  MissingVariableStrategy,
  TemplateOptions,
} from './composition/index';
export {
  createConditionalInstructionComposer,
  createInstructionComposer,
  createInstructionTemplate,
  extractTemplateVariables,
  renderTemplate,
  whenAnyToolAvailable,
  whenMetadata,
  whenMetadataPresent,
  whenStep,
  whenToolsAvailable,
} from './composition/index';
export type {
  AppendToolCallOptions,
  AppendToolResultOptions,
  CompactionOptions,
  ConversationEnvironment,
  IntegrityIssue,
  IntegrityIssueCode,
  MaterializeToolCallOptions,
  MessageSummarizer,
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
  compactConversation,
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
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
  prependSystemMessage,
  redactMessageAtPosition,
  replaceSystemMessage,
  searchConversationMessages,
  stripToolResultDetails,
  toChatMessages,
  validateConversationHistoryIntegrity,
} from './conversation/index';
export type { SessionInfo, SessionPersistenceAdapter } from './environment';
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
export type {
  ConversationActionType,
  ConversationEvent,
  ConversationEventDetail,
  ConversationEvents,
  ConversationEventType,
} from './history';
export { Conversation } from './history';
export type { ImageContent, MultiModalContent, TextContent } from './multi-modal';
export type { InMemoryPersistenceAdapterOptions } from './persistence/in-memory-adapter';
export { createInMemoryPersistenceAdapter } from './persistence/in-memory-adapter';
export { JsonlSessionPersistenceAdapter } from './persistence/jsonl-adapter';
export type {
  SQLitePersistenceAdapter,
  SQLitePersistenceAdapterOptions,
} from './persistence/sqlite-adapter';
export { createSQLitePersistenceAdapter } from './persistence/sqlite-adapter';
export type {
  AppendableToolAction,
  AppendableToolCallInput,
  AppendableToolError,
  AppendableToolResult,
  AssistantMessage,
  ChatMessage,
  ChatMessageRole,
  ConversationHistory,
  ConversationProvider,
  ConversationStatus,
  JSONValue,
  Message,
  MessageInput,
  MessageRole,
  TokenUsage,
  ToolAction,
  ToolActionInput,
  ToolCall,
  ToolCallInput,
  ToolError,
  ToolErrorCategory,
  ToolErrorInput,
  ToolResult,
  ToolResultInput,
} from './types';
export type { ConversationNodeSnapshot, ConversationSnapshot } from './types';
export type { ConversationHistoryDraft } from './with-conversation';
export { pipeConversationHistory, withConversationHistory } from './with-conversation';
