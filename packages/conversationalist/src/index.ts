export type { CompactionOptions, CompactionResult, Summarizer } from './compaction/index';
export { compactConversation, stripToolResultDetails } from './compaction/index';
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
  ConversationEnvironment,
  IntegrityIssue,
  IntegrityIssueCode,
  MaterializeToolCallOptions,
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
export type { ConversationEventMap } from './events';
export {
  CompactionCompletedEvent,
  CompactionStartedEvent,
  ConversationChangeEvent,
  ConversationPushEvent,
  ConversationRedoEvent,
  ConversationSwitchEvent,
  ConversationUndoEvent,
  MessagesAppendedEvent,
  MessagesRemovedEvent,
  MessagesUpdatedEvent,
  PersistenceErrorEvent,
  SessionForkedEvent,
  SessionRenamedEvent,
  SessionTaggedEvent,
  StreamCancelledEvent,
  StreamFinalizedEvent,
  StreamStartedEvent,
  StreamUpdatedEvent,
  ToolCallsAppendedEvent,
  ToolResultsAppendedEvent,
} from './events';
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
