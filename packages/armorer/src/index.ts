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
export { combineToolboxes } from './combine-toolboxes';
export type { ToolboxBudgetExceededToolError } from './core/errors';
export type { ToolError, ToolErrorCategory } from './core/errors';
export { isToolboxBudgetExceededToolError, TOOLBOX_BUDGET_EXCEEDED_MARKER } from './core/errors';
export type {
  EffectiveToolExecutionContext,
  ExternalExecutionProjection,
  ExternalFieldClass,
  ExternalProjectionAudience,
  ExternalProjectionOptions,
  ToolAuthority,
  ToolRequestContext,
} from './execution-context';
export {
  EXTERNAL_PROJECTION_VERSION,
  freezeEffectiveToolExecutionContext,
  freezeToolRequestContext,
  narrowToolAuthority,
  privilegedExecutionSnapshot,
  projectExecutionSnapshot,
} from './execution-context';
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
export { createExecutionLifecycle } from './execution-lifecycle';
// AB-92/AB-254 — the RuntimeServices contract and its real-globals default
// implementation live in `lifecycle` (a private foundation package) and are
// re-exported here so a consumer never has to depend on `lifecycle`
// directly; inlined into this package's shipped artifact at build time,
// the existing treatment `ObservableLike`/`Subscription` already receive.
// The manual (deterministic) implementation is exported from
// `armorer/test` instead — see `./test/index.ts`.
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
} from 'lifecycle';
export { createDefaultRuntimeServices } from 'lifecycle';
// `ToolDefinition` is part of the public `Tool` type's structure, so downstream
// packages must be able to name it to emit their own declarations (TS2883).
export type {
  ApprovalBindingContext,
  ApprovalBindingPayload,
  ApprovalState,
  ApprovalStateStore,
} from './approval-binding';
export {
  APPROVAL_BINDING_VERSION,
  ApprovalBindingError,
  createProcessLocalApprovalStateStore,
  validateApprovalBinding,
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
export type { SerializedToolDefinition } from './core/serialization';
export type { CreateToolOptions, WithContext } from './create-tool';
export { createTool, createToolCall, lazy, withContext } from './create-tool';
export type {
  AnyToolbox,
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
  ToolboxExecuteOptions,
  ToolboxOptions,
  ToolboxRuntimeContext,
  ToolMiddleware,
  ToolsFromEntries,
  ToolStatusUpdate,
} from './create-toolbox';
export { createMiddleware, createToolbox, isToolbox } from './create-toolbox';
export type {
  CachedToolResult,
  CreateToolResultCacheOptions,
  DirectIdempotencyExecuteOptions,
  IdempotencyOptions,
  IdempotencyResolutionReceipt,
  IdempotentTool,
  LegacyIdempotencyResolutionReceipt,
  ToolResultCache,
  WithToolboxIdempotencyOptions,
} from './idempotency';
export {
  compositeKey,
  createToolResultCache,
  fieldKey,
  fullInputKey,
  namespacedKey,
  withIdempotency,
  withToolboxIdempotency,
} from './idempotency';
export { jsonSchemaToZod } from './json-schema-to-zod';

// Guardrail detector pipeline shared across operative (input guardrail) and
// retrieval surfaces (memory recall, ingested documents, skill resources).
export type { InputLengthDetectorOptions } from './guardrails/detectors/input-length';
export { createInputLengthDetector } from './guardrails/detectors/input-length';
export type { PromptInjectionDetectorOptions } from './guardrails/detectors/prompt-injection';
export {
  createPromptInjectionDetector,
  DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD,
  withMinimumTripwireConfidence,
} from './guardrails/detectors/prompt-injection';
export type { TopicBoundaryDetectorOptions } from './guardrails/detectors/topic-boundary';
export { createTopicBoundaryDetector } from './guardrails/detectors/topic-boundary';
export type { DetectorPipelineResult } from './guardrails/pipeline';
export { runDetectorPipeline } from './guardrails/pipeline';
export type { ScanContentOptions, ScanContentResult } from './guardrails/scan';
export { scanContent } from './guardrails/scan';
export type {
  DetectionResult,
  DetectorContext,
  GuardrailProvenance,
  GuardrailTriggeredEvent,
  InputDetector,
} from './guardrails/types';

// Event classes and event maps
export {
  ToolboxBudgetExceededEvent,
  ToolboxCallEvent,
  ToolboxCancelledEvent,
  ToolboxCompleteEvent,
  ToolboxErrorEvent,
  type ToolboxEventMap,
  ToolboxExecuteErrorEvent,
  ToolboxExecuteStartEvent,
  ToolboxExecuteSuccessEvent,
  ToolboxLogEvent,
  ToolboxLoopBlockedEvent,
  ToolboxLoopWarningEvent,
  ToolboxNameResolvedEvent,
  ToolboxNotFoundEvent,
  ToolboxOutputChunkEvent,
  ToolboxPolicyDeniedEvent,
  ToolboxProgressEvent,
  ToolboxQueryEvent,
  ToolboxSearchEvent,
  ToolboxSettledEvent,
  ToolboxStatusUpdateEvent,
  ToolboxStreamChunkEvent,
  ToolboxStreamEndEvent,
  ToolboxStreamErrorEvent,
  ToolboxStreamStartEvent,
  ToolboxToolFinishedEvent,
  ToolboxToolStartedEvent,
  ToolboxValidateErrorEvent,
  ToolboxValidateSuccessEvent,
  ToolCancelledEvent,
  type ToolEventMap,
  ToolExecuteErrorEvent,
  ToolExecuteStartEvent,
  ToolExecuteSuccessEvent,
  ToolFinishedEvent,
  ToolLogEvent,
  ToolOutputChunkEvent,
  ToolPolicyActionRequiredEvent,
  ToolPolicyDeniedEvent,
  ToolProgressEvent,
  ToolSettledEvent,
  ToolStartedEvent,
  ToolStatusUpdateEvent,
  ToolStreamChunkEvent,
  ToolStreamEndEvent,
  ToolStreamErrorEvent,
  ToolStreamStartEvent,
  ToolValidateErrorEvent,
  ToolValidateSuccessEvent,
} from './events';
export type {
  AddEventListenerOptionsLike,
  AsyncIteratorOptions,
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
export { isTool, resolveToolPolicyAllow } from './is-tool';
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
  PendingToolApproval,
  PolicyPauseTier,
  SatisfiedPolicyPause,
  SignedPendingToolApproval,
  ToolAction,
  ToolActionInput,
  ToolCall,
  ToolCallInput,
  ToolErrorInput,
  ToolExecutionIdempotency,
  ToolExecutionResult,
  ToolProvider,
  ToolResult,
  ToolResultInput,
  ToolResultLike,
} from './types';
