export { anthropicConversationAdapter } from './adapters/anthropic';
export { appendAnthropicMessages, fromAnthropicMessages } from './adapters/anthropic/inbound';
export { toAnthropicMessages } from './adapters/anthropic/outbound';
export { toAnthropicMessagesForSdk } from './adapters/anthropic/sdk';
export type * from './adapters/anthropic/types';
export { geminiConversationAdapter } from './adapters/gemini';
export { appendGeminiMessages, fromGeminiMessages } from './adapters/gemini/inbound';
export { toGeminiMessages } from './adapters/gemini/outbound';
export type * from './adapters/gemini/types';
export { openAIConversationAdapter } from './adapters/openai';
export { appendOpenAIMessages, fromOpenAIMessages } from './adapters/openai/inbound';
export { toOpenAIMessages, toOpenAIMessagesGrouped } from './adapters/openai/outbound';
export type * from './adapters/openai/types';
export { compactConversation } from './compaction/compact';
export { stripToolResultDetails } from './compaction/stripping';
export type {
  CompactionOptions,
  CompactionPreservePolicy,
  CompactionResult,
  Summarizer,
} from './compaction/types';
export {
  createConditionalInstructionComposer,
  createInstructionComposer,
  createInstructionTemplate,
  extractTemplateVariables,
  renderTemplate,
  sectionsToMessageInputs,
  whenAnyToolAvailable,
  whenMetadata,
  whenMetadataPresent,
  whenStep,
  whenToolsAvailable,
} from './composition/index';
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
  SectionsToMessageInputsOptions,
  TemplateOptions,
} from './composition/index';
export * from './context';
export * from './context-recent';
export * from './context-rewind';
export * from './context-truncation';
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
  buildMessage,
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
  prependMessages,
  prependSystemMessage,
  redactMessageAtPosition,
  removeMessage,
  replaceSystemMessage,
  replaceToolResult,
  resolveToolResult,
  resolveToolResultAsync,
  searchConversationMessages,
  setMessageHidden,
  toChatMessages,
  updateMessage,
  validateConversationHistoryIntegrity,
} from './conversation/index';
export type {
  AppendToolCallOptions,
  AppendToolResultOptions,
  BuildMessageOptions,
  ConversationEnvironment,
  IntegrityIssue,
  IntegrityIssueCode,
  MaterializeToolCallOptions,
  MessageUpdate,
  RedactMessageOptions,
  ToolInteraction,
} from './conversation/index';
export {
  defineMessagePlugin,
  getMessagePluginIdentity,
  toSessionInfo,
  withEnvironment,
} from './environment';
export type { SessionInfo } from './environment';
export {
  ConversationalistError,
  createConversationLifecycleError,
  createDuplicateIdError,
  createInvalidInputError,
  createInvalidPositionError,
  createInvalidToolReferenceError,
  createLockedError,
  createNotFoundError,
  createOperationCancelledError,
  createRevisionConflictError,
  createSerializationError,
  createToolResultNotFoundError,
  createValidationError,
} from './errors';
export type { ConversationalistErrorCode } from './errors';
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
export type {
  ConversationActionType,
  ConversationEvent,
  ConversationEventDetail,
  ConversationEventMap,
  ConversationEventType,
} from './events';
export { exportMarkdown } from './export/index';
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
export { Conversation } from './history';
export type {
  ConversationLifecycle,
  ConversationMutationOptions,
  ConversationMutationResult,
  ConversationStoreSnapshot,
} from './history';
export type {
  ContainerUploadContent,
  ContentSource,
  DocumentContent,
  DocumentSource,
  ImageContent,
  MediaLimitScope,
  MediaLimits,
  MimeFamily,
  Modality,
  ModalityMatrix,
  MultiModalContent,
  RedactedThinkingContent,
  ServerToolResultContent,
  ServerToolResultType,
  ServerToolUseContent,
  TextContent,
  ThinkingContent,
  WebSearchToolResultContent,
} from './multi-modal';
export {
  DEFAULT_PII_RULES,
  createPIIRedaction,
  createPIIRedactionPlugin,
  redactPii,
} from './plugins/pii-redaction';
export type { PIIRedactionOptions, PIIRedactionRule } from './plugins/pii-redaction';
export {
  createProjection,
  createPublicConversationProjection,
  isProjectionPrefixExtension,
} from './projection';
export type {
  Projection,
  ProjectionApplyOptions,
  ProjectionEventIdentity,
  ProjectionOptions,
  ProjectionReducer,
  ProjectionReducerContext,
  ProjectionReducerResult,
  PublicConversationProjectionOptions,
  StatefulProjectionOptions,
  StatelessProjectionOptions,
} from './projection';
export * from './schemas';
export * from './streaming';
export * from './streaming-accumulator';
export * from './test';
export type {
  AppendableToolAction,
  AppendableToolCallInput,
  AppendableToolError,
  AppendableToolResult,
  AssistantMessage,
  ChatMessage,
  ChatMessageRole,
  ConversationHistory,
  ConversationNodeSnapshot,
  ConversationProvider,
  ConversationSnapshot,
  ConversationStatus,
  JSONValue,
  Message,
  MessageInput,
  MessagePlugin,
  MessagePluginIdentity,
  MessageRole,
  ToMarkdownOptions,
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
export * from './utilities';
export { sortMessagesByPosition, sortObjectKeys } from './utilities/deterministic';
export { normalizeLineEndings } from './utilities/line-endings';
export * from './versioning';
export { pipeConversationHistory, withConversationHistory } from './with-conversation';
export type { ConversationHistoryDraft } from './with-conversation';

export { conversationFromMarkdown, conversationToMarkdown } from './markdown/index';
export { toMarkdown } from './utilities/markdown';
export { MarkdownParseError, fromMarkdown } from './utilities/markdown-parsing';
export {
  LABEL_TO_ROLE,
  ROLE_LABELS,
  getRoleFromLabel,
  getRoleLabel,
} from './utilities/markdown-roles';
