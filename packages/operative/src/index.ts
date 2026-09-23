export * from './agent-run';
export { createAgentSession, loadAgentSession, saveAgentSession } from './agent-session';
export type { AgentSession, RunRef } from './agent-session';
export * from './backpressure';
export * from './cache/index';
export {
  attenuateDelegatedAuthority,
  createChildRunRegistry,
  dispatchChildRun,
  listChildRuns,
} from './child-run';
export type {
  ChildEventEmitter,
  ChildRunDescriptor,
  ChildRunHandle,
  ChildRunRegistry,
  ChildRunStatus,
  ChildRunSummary,
  ChildRunTerminalStatus,
  DispatchChildRunOptions,
  MutableChildRunRegistry,
} from './child-run';
export * from './conditions/index';
export * from './context/index';

export * from './cost-budget-monitor';
export * from './cost-estimation';
export * from './create-agent';
export { createContextCompactor } from './create-context-compactor';
export type { CreateContextCompactorOptions } from './create-context-compactor';
export { createEarlyStoppingHandler } from './create-early-stopping-handler';
export type { EarlyStoppingHandlerOptions } from './create-early-stopping-handler';
export { HANDOFF_MARKER, createHandoffTool, extractHandoffTarget } from './create-handoff-tool';
export type { CreateHandoffToolOptions, HandoffTarget } from './create-handoff-tool';
export { createIdentityHook } from './create-identity-hook';
export type { CreateIdentityHookOptions } from './create-identity-hook';
export { createDeferredAgentRun, createLazyAgent } from './create-lazy-agent';
export type { AgentModule, CreateLazyAgentOptions, LazyAgentLoader } from './create-lazy-agent';
export { createLazyGenerate } from './create-lazy-generate';
export type { CreateLazyGenerateOptions, LazyGenerateLoader } from './create-lazy-generate';
export { createMcpElicitationResponder } from './create-mcp-elicitation-responder';
export type { CreateMcpElicitationResponderOptions } from './create-mcp-elicitation-responder';
export { createMemoryBridge } from './create-memory-bridge';
export type { CreateMemoryBridgeOptions, MemoryLike } from './create-memory-bridge';
export * from './create-policy-enforcement-hook';
export { createActiveRun } from './create-run';
export type { ActiveRun, DurableRunRouting } from './create-run';
export {
  EntryDeletedEvent,
  EntrySetEvent,
  ScratchpadClearedEvent,
  createScratchpad,
  createScratchpadReadTool,
  createScratchpadWriteTool,
  createTypedScratchpad,
} from './create-scratchpad';
export type {
  CreateScratchpadOptions,
  Scratchpad,
  ScratchpadEventMap,
  ScratchpadEvents,
  TypedScratchpad,
} from './create-scratchpad';
export * from './create-subagent-tool';
export {
  AbortAgentRunError,
  AgentContractError,
  AgentRunError,
  AsyncDefinitionLoadError,
  BudgetExceededError,
  ElicitationDeniedError,
  GuardrailTripwireError,
  MaximumStepsExceededError,
  NonJsonOutputError,
  OutputSchemaConversionError,
  OutputValidationError,
  SelectionRevalidationError,
  SubagentRunError,
  agentRunErrorToJSON,
  classifyError,
  serializeAgentRunError,
} from './errors';
export type {
  AgentRunErrorCode,
  AgentRunErrorKind,
  AsyncDefinitionLoadCode,
  ClassifiedError,
  ErrorCategory,
  GuardrailTripwireDetail,
  SerializedAgentRunError,
} from './errors';
export {
  BackpressureAppliedEvent,
  BackpressureReleasedEvent,
  BudgetExceededEvent,
  BudgetThresholdEvent,
  ContextBudgetWarningEvent,
  ContextCompactedEvent,
  ElicitationRequestedEvent,
  ElicitationResolvedEvent,
  GenerateCompletedEvent,
  GenerateErrorEvent,
  GenerateRetryEvent,
  GenerateStartedEvent,
  ResponseSchemaFailedEvent,
  ResponseValidatedEvent,
  RunAbortedEvent,
  RunCompletedEvent,
  RunErrorEvent,
  RunStartedEvent,
  RunTripwireEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionLoadedEvent,
  SessionOutboxAppendedEvent,
  SessionSavedEvent,
  StepAbortedEvent,
  StepCompletedEvent,
  StepGeneratedEvent,
  StepStartedEvent,
  ToolResultValidatedEvent,
  ToolsExecutedEvent,
  ToolsExecutingEvent,
  UsageAccumulatedEvent,
} from './events';
export type {
  CombinedOperativeEventMap,
  CombinedOperativeEventType,
  CombinedOperativeEvents,
  ForwardedEvents,
  OperativeEventEmitter,
  OperativeEventMap,
  OperativeEventType,
  OperativeEvents,
} from './events';
export * from './generation-profile';
export * from './runnable-agent';
export * from './selection-gate';
// RuntimeServices is part of this package's public execution contract.
// Its implementation and types have one source owner: @lostgradient/lifecycle.
// Deterministic callers can use createManualRuntimeServices from that workspace.
export { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
// COR-1268 — `HookRegistry` is the ONLY way to configure hooks on a run, so
// it has to be reachable from this package. Before the legacy `RunOptions`
// hook arrays were removed a consumer could configure hooks without ever
// naming the registry; now it cannot, and re-exporting here spares every
// caller a direct dependency on @lostgradient/lifecycle for the one type the
// operative run contract requires. Source owner is still lifecycle.
export { HookRegistry, mergeHookRegistries } from '@lostgradient/lifecycle';
export type {
  DeferredDrainReport,
  HookErrorHandler,
  HookPlanDescription,
  HookPlanEntryDescription,
  HookPlanObservation,
  HookPlanObserver,
  HookRegistrationOptions,
  HookRegistryOptions,
  HookReplayPolicy,
  RuntimeClock,
  RuntimeDeferred,
  RuntimeIdentifiers,
  RuntimeMonotonic,
  RuntimeRandom,
  RuntimeServices,
  RuntimeTimeoutHandle,
  RuntimeTimers,
} from '@lostgradient/lifecycle';
// C3 — curated tool.* bubble events
export {
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from './events';
export type {
  GenerationBackendRecord,
  GenerationDivergence,
  GenerationSelectionRecord,
  ToolEventStamp,
} from './events';
// COR-581 — effective-context epochs
export { createContextEpochSealer, digestText, epochSourcesUnchanged } from './context-epoch';
export type {
  ContextEpochConsumer,
  ContextEpochSealInput,
  ContextEpochSealer,
  ContextSourceAvailability,
  ContextSourceDisposition,
  ContextSourceRecord,
  ContextSourceRedaction,
  ContextSourceTrust,
  CreateContextEpochSealerOptions,
  EffectiveContextEpoch,
  SkillActivationBinding,
  SkillActivationContext,
} from './context-epoch';
// C3 — session verb events
export {
  SessionCancelEvent,
  SessionForkEvent,
  SessionMonitorDoneEvent,
  SessionMonitorTickEvent,
  SessionQueryEvent,
  SessionRecoverEvent,
  SessionSignalEvent,
  SessionSleepEvent,
  SessionUpdateEvent,
} from './events';
export type { SessionRecoverFailure } from './events';
// F1/F2/F3 — durable multi-agent transition events
export { ChildWorkflowStartedEvent, HandoffOccurredEvent, HumanWaitParkedEvent } from './events';
// AB-90 child ab90-01 / AB-221 — steering events (AB-67's decision record)
export {
  SteeringAcceptedEvent,
  SteeringAppliedEvent,
  SteeringFailedEvent,
  SteeringRejectedEvent,
  SteeringSupersededEvent,
} from './events';
// AB-50 — child dispatch lifecycle correlation (terminal events)
export {
  ChildWorkflowAbortedEvent,
  ChildWorkflowCompletedEvent,
  ChildWorkflowFailedEvent,
} from './events';
export type { ChildWorkflowCorrelation } from './events';
// AB-90 child ab90-02 / AB-222 — child reattachment and progress events
export { ChildWorkflowProgressEvent, ChildWorkflowReattachedEvent } from './events';
// Hook plan (COR-766). No `HookPlanReplayedEvent` — see the block comment
// above these classes in `events.ts`.
export {
  HookPlanFailedEvent,
  HookPlanInvokedEvent,
  HookPlanRegisteredEvent,
  HookPlanRemovedEvent,
} from './events';
export type { ChildWorkflowProgressPayload, ChildWorkflowReattachedPayload } from './events';
export { observeHookPlan } from './hook-plan-events';
// D6 — scheduling events
export * from './create-request-human-input-tool';
export { createScheduleSelfTool } from './create-schedule-self-tool';
export type {
  CreateScheduleSelfToolOptions,
  ScheduleSelfFn,
  ScheduleSelfInput,
  ScheduleSelfResult,
  ScheduleSelfTool,
} from './create-schedule-self-tool';
export * from './create-schedule-wakeup-tool';
// F3/D6 — thrown by scheduleWakeup/requestHumanInput when invoked outside a
// durable run (AB-41's decision record, implemented by AB-43).
export { DurableCapabilityUnavailableError } from './durable/durable-capability-unavailable-error';
export * from './durable/schedule-agent';
export {
  AgentScheduledEvent,
  ScheduleAttemptedEvent,
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  ScheduleSkippedEvent,
  WakeupScheduledEvent,
} from './events';
// AB-10 — workflow versioning for in-flight durable runs
export * from './durable';
export { WorkflowVersionMismatchEvent } from './events';
export { composeGenerate, createFallbackGenerate } from './generate-middleware';
export * from './guardrails';
export * from './hooks';
export * from './hooks/index';
export * from './inheritance';
export * from './liveness';
export type { EventDispatcher } from './loop';
export * from './providers';
export * from './retry';
export * from './run-envelope';
/*
 * `operative.runs.events`, declared with Weft's `defineOperation` so a client
 * subscribing to a run speaks the same dialect and obeys the same access
 * policy as one subscribing to a workflow. A host registers this into its
 * catalog and passes `{ runFeeds }` as the operation's engine value.
 */
export {
  createAgentRunEventRegistry,
  runEventEnvelopeSchema,
  runEventsSubscriptionOperation,
  type AgentRunEventRegistry,
  type RunEventsOperationEngine,
  type RunEventsSubscriptionInput,
} from './run-events-operation';
export { DEFAULT_MAXIMUM_STEPS } from './run-step';
export * from './scheduler/index';

export * from './session/index';
export { MissingRunOptionsError } from './session/session-handle-types';
export * from './store';
export { withStreaming } from './streaming';
export * from './streaming/index';
export * from './structured-output/index';
export * from './test';
export type {
  AfterGenerateHook,
  AfterToolExecutionHook,
  AnyToolbox,
  BeforeGenerateHook,
  BeforeToolExecutionHook,
  CleanupAcknowledgement,
  CleanupAcknowledgementReason,
  ClosedOptions,
  ContextManagementOptions,
  Conversation,
  ConversationHistory,
  ElicitationOptions,
  ElicitationRequest,
  ElicitationResponse,
  FinishReason,
  GenerateContext,
  GenerateFunction,
  GenerateMiddleware,
  GenerateResponse,
  JSONValue,
  OnElicitation,
  OnErrorHook,
  OnLLMInputHook,
  OnLLMOutputHook,
  OnRunAbortHook,
  OnRunCompleteHook,
  OnRunErrorHook,
  OnRunStartHook,
  OnStepHook,
  OperativeExecuteOptions,
  PrepareStepHook,
  RetryOptions,
  RunOptions,
  RunOptionsBase,
  RunOutcome,
  RunResult,
  RunResultBase,
  SelectToolsHook,
  SteeringGate,
  StepContext,
  StepResult,
  StopCondition,
  StreamingGenerateFunction,
  StreamingHandle,
  TokenUsage,
  ToolCall,
  ToolCallInput,
  ToolExecutionHookContext,
  ToolExecutionResult,
  ToolExecutionResultContext,
  Toolbox,
  ValidateResponseHook,
  ValidateToolResultHook,
} from './types';

export * from './providers/test';

export { instrumentRun, type RunInstrumentationOptions } from './instrumentation';
export {
  instrumentGenerate,
  type GenerateInstrumentationOptions,
  type InstrumentableGenerateOptions,
} from './providers/instrumentation';

/*
 * An agent run's events, projected onto a replay-plus-live feed.
 *
 * Built on Weft's `createReplayLiveFeed`, which this package already depends
 * on, so a subscriber watching a run gets the same cursors and resume
 * semantics as one watching a workflow. See `run-event-feed.ts` for why the
 * projection names every field rather than serializing events generically.
 */
export {
  PUBLISHED_RUN_EVENT_KINDS,
  createAgentRunEventFeed,
  projectRunEvent,
  publishedRunEventKinds,
  type AgentRunEventEnvelope,
  type AgentRunEventFeed,
  type AgentRunEventFeedOptions,
  type PublishedRunEventKind,
} from './run-event-feed';
