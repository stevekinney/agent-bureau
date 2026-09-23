export {
  approvalStatusToDecision,
  combineApprovalStatuses,
  createApprovalPolicyHooks,
  createHeadlessPermissionPolicyHooks,
  evaluateApprovalStatus,
  evaluateCapabilityApproval,
  evaluateHeadlessPermission,
  resolveApprovalMode,
  resolveCapabilityTier,
} from './approval-policy';
export type {
  ApprovalMode,
  ApprovalPolicyConfiguration,
  ApprovalStatus,
  CapabilityApprovalContext,
  CapabilityApprovalResult,
  CapabilityTier,
  HeadlessPermissionPolicyConfiguration,
  HeadlessPermissionResult,
  PermissionGate,
  PermissionGateDecision,
} from './approval-policy';
export { combineToolboxes } from './combine-toolboxes';
export * from './core';
export { TOOLBOX_BUDGET_EXCEEDED_MARKER, isToolboxBudgetExceededToolError } from './core/errors';
export type { ToolError, ToolErrorCategory, ToolboxBudgetExceededToolError } from './core/errors';
export {
  EXTERNAL_PROJECTION_VERSION,
  freezeEffectiveToolExecutionContext,
  freezeToolRequestContext,
  narrowToolAuthority,
  privilegedExecutionSnapshot,
  projectExecutionSnapshot,
} from './execution-context';
export type {
  EffectiveToolExecutionContext,
  ExternalExecutionProjection,
  ExternalFieldClass,
  ExternalProjectionAudience,
  ExternalProjectionOptions,
  ToolAuthority,
  ToolRequestContext,
} from './execution-context';
export { createExecutionLifecycle } from './execution-lifecycle';
export type {
  BeginExecutionOptions,
  ExecutionAbortSource,
  ExecutionCleanupOutcome,
  ExecutionCleanupReport,
  ExecutionHandle,
  ExecutionIdentity,
  ExecutionLifecycle,
  ExecutionLifecycleEvent,
  ExecutionSelector,
  ExecutionSnapshot,
  ExecutionState,
} from './execution-lifecycle';
// RuntimeServices is part of this package's public execution contract.
// Its implementation and types have one source owner: @lostgradient/lifecycle.
// Deterministic callers can use createManualRuntimeServices from that workspace.
export { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
export type {
  DeferredDrainReport,
  RuntimeClock,
  RuntimeDeferred,
  RuntimeIdentifiers,
  RuntimeMonotonic,
  RuntimeRandom,
  RuntimeServices,
  RuntimeTimeoutHandle,
  RuntimeTimers,
} from '@lostgradient/lifecycle';
// `ToolDefinition` is part of the public `Tool` type's structure, so downstream
// packages must be able to name it to emit their own declarations (TS2883).
export {
  APPROVAL_BINDING_VERSION,
  ApprovalBindingError,
  GRANT_VERSION,
  GrantError,
  createProcessLocalApprovalStateStore,
  createProcessLocalGrantStateStore,
  signGrant,
  validateApprovalBinding,
  verifyGrantSignature,
} from './approval-binding';
export type {
  ApprovalBindingContext,
  ApprovalBindingPayload,
  ApprovalState,
  ApprovalStateStore,
  GrantStateStore,
  ReusableApprovalGrant,
} from './approval-binding';
export type {
  AnyToolDefinition,
  ToolAvailabilityContext,
  ToolAvailabilityHook,
  ToolDefinition,
} from './core/tool-definition';
// `Tool.toJSON()` (see `./is-tool`) returns `SerializedToolDefinition`, so
// it must be part of the top-level public surface: a downstream package
// whose own exported function infers a `Tool` return type (no explicit
// annotation) needs to be able to name this type, not just reach it through
// the `armorer/core` subpath.
export type { LoopDetectionOptions, LoopDetectionResult } from './core/loop-detection';
export type { SerializedToolDefinition } from './core/serialization';
export {
  createTool,
  createToolCall,
  internalToolTestUtilities,
  lazy,
  withContext,
} from './create-tool';
// `NamedTool` is what `createTool` returns, so it belongs on the top-level surface for the same
// reason as `SerializedToolDefinition` above: a downstream package whose exported function
// infers a tool's type must be able to name it in its declarations. Operative's tool factories
// did, and their declarations failed with TS2883 until it was exported (COR-1291).
export type {
  AsyncToolMetadataInput,
  CreateToolOptions,
  NamedTool,
  SyncToolMetadataInput,
  ToolMetadataInput,
  WithContext,
} from './create-tool/options';
export { createToolbox } from './create-toolbox';
export {
  compositeKey,
  createToolResultCache,
  fieldKey,
  fullInputKey,
  namespacedKey,
  withIdempotency,
  withToolboxIdempotency,
} from './idempotency';
export type {
  CachedToolResult,
  CreateToolResultCacheOptions,
  DirectIdempotencyExecuteOptions,
  IdempotencyOptions,
  IdempotencyResolutionReceipt,
  IdempotentTool,
  LegacyIdempotencyResolutionReceipt,
  StartedToolExecution,
  ToolResultCache,
  ToolResultCacheEntry,
  WithToolboxIdempotencyOptions,
} from './idempotency';
export { jsonSchemaToZod } from './json-schema-to-zod';
export type { ToolboxResolveApprovalOptions } from './toolbox-approval-api';
export type { GrantListFilter, ReusableApprovalGrantInput } from './toolbox-approval-contracts';
export { createMiddleware } from './toolbox-contracts';
export type {
  GrantUsedDetail,
  ImportedToolboxOptions,
  SerializedToolbox,
  SerializedToolboxJSONSchema,
  ToolMiddleware,
  ToolStatusUpdate,
  ToolboxContext,
  ToolboxEntries,
  ToolboxEntry,
  ToolboxEvents,
  ToolboxExecuteOptions,
  ToolboxOptions,
  ToolboxRuntimeContext,
} from './toolbox-contracts';
export { isToolbox } from './toolbox-instance';
export type { AnyToolbox, LoopDetectorInstance, Toolbox } from './toolbox-interface';
export type {
  ImportedToolConfiguration,
  ToolboxCallInputForTools,
  ToolsFromEntries,
} from './toolbox-type-inference';

// Guardrail detector pipeline shared across operative (input guardrail) and
// retrieval surfaces (memory recall, ingested documents, skill resources).
export { createInputLengthDetector } from './guardrails/detectors/input-length';
export type { InputLengthDetectorOptions } from './guardrails/detectors/input-length';
export {
  DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD,
  createPromptInjectionDetector,
  withMinimumTripwireConfidence,
} from './guardrails/detectors/prompt-injection';
export type { PromptInjectionDetectorOptions } from './guardrails/detectors/prompt-injection';
export { createTopicBoundaryDetector } from './guardrails/detectors/topic-boundary';
export type { TopicBoundaryDetectorOptions } from './guardrails/detectors/topic-boundary';
export { runDetectorPipeline } from './guardrails/pipeline';
export type { DetectorPipelineResult } from './guardrails/pipeline';
export { scanContent } from './guardrails/scan';
export type { ScanContentOptions, ScanContentResult } from './guardrails/scan';
export type {
  DetectionResult,
  DetectorContext,
  GuardrailProvenance,
  GuardrailTriggeredEvent,
  InputDetector,
} from './guardrails/types';

// Event classes and event maps
export type { ToolEventMap, ToolboxEventMap } from './event-types';
export * from './tool-lifecycle-events';
export * from './tool-stream-events';
export * from './toolbox-discovery-events';
export * from './toolbox-lifecycle-events';
export * from './toolbox-policy-events';
export * from './toolbox-stream-events';

export { isTool, resolveToolPolicyAllow } from './is-tool';
export type {
  DefaultToolEvents,
  EventIteratorOptions,
  MinimalAbortSignal,
  ObservableLike,
  Observer,
  ResolvedToolPolicyDecision,
  Subscription,
  Tool,
  ToolCallWithArguments,
  ToolConfiguration,
  ToolConfigurationInput,
  ToolConfigurationShorthand,
  ToolContext,
  ToolCustomEvent,
  ToolDiagnostics,
  ToolDiagnosticsAdapter,
  ToolDigestOptions,
  ToolElicitationFormRequest,
  ToolElicitationRequest,
  ToolElicitationRequester,
  ToolElicitationResult,
  ToolElicitationUrlRequest,
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
export {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from './tool-materialization';

// Embedding search API
export { awaitToolEmbeddings, registerToolEmbeddings } from './core/registry/embeddings';
export type { Embedder, EmbeddingEntry, EmbeddingVector } from './core/registry/embeddings';

// Types
export * from './adapters/anthropic';
export * from './adapters/gemini';
export * from './adapters/open-ai/agents';
export * from './adapters/openai';
export * from './coding';
export * from './inspect';
export * from './instrumentation';
export * from './integrations/mcp';
export * from './integrations/mcp/oauth';
export * from './integrations/openapi';
export * from './middleware';
export * from './query';
export * from './resolution';
export * from './test';
export * from './tools';
export * from './truncation';
export type {
  JSONValue,
  MinimalToolConfiguration,
  PendingToolApproval,
  PolicyPauseTier,
  SatisfiedPolicyPause,
  SignedPendingToolApproval,
  ToolAction,
  ToolActionInput,
  ToolCall,
  ToolCallInput,
  ToolCallReturn,
  ToolErrorInput,
  ToolExecutionIdempotency,
  ToolExecutionResult,
  ToolProvider,
  ToolResult,
  ToolResultInput,
  ToolResultLike,
} from './types';
export * from './utilities';
