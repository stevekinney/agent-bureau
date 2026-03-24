export { combineToolbox, combineToolboxes } from './combine-toolboxes';
export type { ToolError, ToolErrorCategory } from './core/errors';
export type { CreateToolOptions, WithContext } from './create-tool';
export { createTool, createToolCall, lazy, withContext } from './create-tool';
export type {
  ImportedToolboxOptions,
  ImportedToolConfiguration,
  LoopDetectionOptions,
  LoopDetectionResult,
  LoopDetectorInstance,
  SerializedToolbox,
  SerializedToolboxJSONSchema,
  Toolbox,
  ToolboxCallInputForTools,
  ToolboxContext,
  ToolboxEntries,
  ToolboxEntry,
  ToolboxEvents,
  ToolboxOptions,
  ToolboxRuntimeContext,
  ToolMiddleware,
  ToolsFromEntries,
  ToolStatusUpdate,
} from './create-toolbox';
export { createMiddleware, createToolbox, isToolbox } from './create-toolbox';
export type {
  AddEventListenerOptionsLike,
  AsyncIteratorOptions,
  DefaultToolEvents,
  MinimalAbortSignal,
  ObservableLike,
  Observer,
  Subscription,
  Tool,
  ToolCallWithArguments,
  ToolConfiguration,
  ToolContext,
  ToolCustomEvent,
  ToolDiagnostics,
  ToolDiagnosticsAdapter,
  ToolDigestOptions,
  ToolEventsMap,
  ToolExecuteOptions,
  ToolExecuteWithOptions,
  ToolMetadata,
  ToolParametersSchema,
  ToolPolicyAfterContext,
  ToolPolicyContext,
  ToolPolicyContextProvider,
  ToolPolicyDecision,
  ToolPolicyHooks,
  ToolRepairHint,
  ToolValidationReport,
  ToolValidationWarning,
} from './is-tool';
export { isTool } from './is-tool';
export {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from './tool-materialization';

// Embedding search API
export type { Embedder, EmbeddingEntry, EmbeddingVector } from './core/registry/embeddings';
export { awaitToolEmbeddings, registerToolEmbeddings } from './core/registry/embeddings';

// Types
export type {
  JSONValue,
  MinimalToolConfiguration,
  ToolAction,
  ToolActionInput,
  ToolCall,
  ToolCallInput,
  ToolErrorInput,
  ToolExecutionResult,
  ToolProvider,
  ToolResult,
  ToolResultInput,
  ToolResultLike,
} from './types';
