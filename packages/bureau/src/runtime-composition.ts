import type { EventMap, HookReplayPolicy, RuntimeServices } from '@lostgradient/lifecycle';
import {
  createDefaultRuntimeServices,
  HookRegistry,
  mergeHookRegistries,
  TypedEventTarget,
} from '@lostgradient/lifecycle';
import type { CreateMemoryOptions, Memory } from '@lostgradient/memory';
import { createMemory } from '@lostgradient/memory';
import type {
  AgentInput,
  AgentRunContext,
  AgentSession,
  CheckpointStore,
  DurableRunDeps,
  GenerateFunction,
  GuardrailHooks,
  GuardrailsOptions,
  JSONValue,
  OnStepHook,
  OperativeHookMap,
  PrepareStepHook,
  RegistryAgnosticEngine,
  RequestHumanInputContext,
  RequestHumanInputInput,
  RunEngineObservability,
  RunOptions,
  ScheduledAgentRunInput,
  Scheduler,
  ScheduleWakeupContext,
  ScheduleWakeupInput,
  SessionStore,
  SessionSummary,
  StepRecord,
  StreamEventMap,
} from '@lostgradient/operative';
import {
  createAgentSession,
  createAnthropicProvider,
  createAnthropicProviderStream,
  createCheckpointStore,
  createComplexityStrategy,
  createCostAwareStrategy,
  createFalloverGenerate,
  createGeminiProvider,
  createGeminiProviderStream,
  createGuardrails,
  createIdentityHook,
  createOpenAIProvider,
  createOpenAIProviderStream,
  createOutputPIIValidator,
  createPolicyEnforcementHook,
  createPromptInjectionDetector,
  createRequestHumanInputTool,
  createRoutingGenerate,
  createRunEngine,
  createRunWorkflow,
  createScheduler,
  createScheduleWakeupTool,
  createSessionStore,
  createStepBasedStrategy,
  DEFAULT_MAXIMUM_STEPS,
  DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD,
  isAgentRunWorkflowInput,
  isScheduledAgentRunInput,
  ScheduleAttemptedEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SCHEDULER_ORIGIN_TAG,
  SCHEDULER_RUN_ID_PREFIX,
  ScheduleSkippedEvent,
  withCache,
  withEnhancedStreaming,
  withMinimumTripwireConfidence,
  WorkflowVersionMismatchEvent,
} from '@lostgradient/operative';
import {
  createSkillArtifactLoader,
  createSkillClient,
  createSkillClientToolbox,
  DEFAULT_SOURCE_PRECEDENCE,
  discoverSkills,
  renderActiveSkillInstructions,
  renderClientCatalog,
  type SkillActivationRecord,
  type SkillCatalogRevision,
  type SkillEventMap,
  type SkillGuardrailOptions,
  type ToolPolicy,
} from '@lostgradient/skills';
import {
  type ConditionalTextValueStore,
  decode,
  deserializeCheckpoint,
  encode,
  KEYS,
  resolveStorage,
  type Storage,
  type StorageConfiguration,
  type TextValueStore,
  textValueStore,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  type WorkflowServicesResolution,
  type WorkflowServicesResolverInfo,
} from '@lostgradient/weft';
import {
  type AnyToolbox,
  combineToolboxes,
  createTool,
  createToolbox,
  type ToolboxExecuteOptions,
  type ToolCallInput,
  type ToolRequestContext,
} from 'armorer';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
} from 'conversationalist';

import { resolveDiagnosticSink, serializeUnknownError } from './serialization';
import type {
  BureauOptions,
  CacheConfiguration,
  CreateRunRequest,
  PersistenceOptions,
  ProviderConfiguration,
  RedactedProviderConfiguration,
  RedactedProviderRouteConfiguration,
  RoutingConfiguration,
  ToolSummary,
} from './types';

export type BureauToolbox = AnyToolbox;

export function createHumanWaitContext(
  servicesRef: { current?: DurableRunDeps },
  runId: string,
): RequestHumanInputContext {
  return {
    get pendingHumanWait() {
      return servicesRef.current?.pendingHumanWait;
    },
    set pendingHumanWait(value) {
      if (servicesRef.current) {
        servicesRef.current.pendingHumanWait = value;
      }
    },
    runId,
    // Only ever constructed inside the `options.humanInput && runtime.durable`
    // guard below, so this context always backs a real durable run
    // (AB-41 / AB-43 — the durability signal threaded into the tool's context).
    durable: true,
  };
}

/**
 * AB-201 — the `scheduleWakeup` analog of {@link createHumanWaitContext}: forwards
 * reads/writes onto the run's REAL `ctx.services` object (via the same
 * `servicesRef` capture) rather than spreading it, so the tool's `pendingWakeup`
 * writes land where the durable `agentRun` workflow actually reads them.
 * `ScheduleWakeupContext` carries no `runId` field (unlike
 * `RequestHumanInputContext`), so this takes only the shared `servicesRef`.
 */
export function createWakeupContext(servicesRef: {
  current?: DurableRunDeps;
}): ScheduleWakeupContext {
  return {
    get pendingWakeup() {
      return servicesRef.current?.pendingWakeup;
    },
    set pendingWakeup(value) {
      if (servicesRef.current) {
        servicesRef.current.pendingWakeup = value;
      }
    },
    // Only ever constructed inside the `options.wakeup && runtime.durable`
    // guard (below, in `createBureau`'s run composition — same placement as
    // `createHumanWaitContext`'s own guard), so this context always backs a
    // real durable run (AB-41 / AB-43 — the durability signal threaded into
    // the tool's context).
    durable: true,
  };
}

/**
 * The narrow surface `requestHumanInput` needs to dispatch its
 * `HumanWaitParkedEvent` (matches `create-request-human-input-tool.ts`'s own
 * private `HumanInputEventDispatcher` structurally, without importing it).
 */
export interface HumanWaitEventDispatcher {
  dispatchEvent(event: Event): boolean;
}

/**
 * Type guard, not a cast: `DurableRunDeps.emitter`'s own `EventDispatcher`
 * type declares only `dispatch`, never the DOM-style `dispatchEvent` every
 * real emitter (a `CompletableEventTarget`) also carries — see
 * `buildRunDepsFromSession`'s lazy `humanInputEmitter` forwarder.
 */
export function hasDispatchEvent(value: unknown): value is HumanWaitEventDispatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { dispatchEvent?: unknown }).dispatchEvent === 'function'
  );
}

export interface WireDurableOptInToolsOptions {
  /** Wires `requestHumanInput` in when true (AB-13/AB-41/AB-43). */
  readonly humanInput?: boolean;
  /** Wires `scheduleWakeup` in when true (AB-201). */
  readonly wakeup?: boolean;
  readonly runId: string;
  /**
   * Where `requestHumanInput`'s `HumanWaitParkedEvent` dispatches. Ignored
   * when `humanInput` is falsy. A caller whose real emitter is not yet
   * assigned at wiring time (AB-336 — recovery's `services.emitter` is set
   * by `createRecoveredRunEventSurface` AFTER `buildRunDepsFromSession`
   * returns, but this wiring happens INSIDE it) passes a lazy forwarder
   * instead of the emitter itself; the tool only calls `dispatchEvent` at
   * actual tool-call time, by which point a lazy forwarder's target has
   * settled.
   */
  readonly humanInputEmitter?: HumanWaitEventDispatcher;
}

/**
 * AB-336 — the ONE place both the fresh-dispatch (`createRunFromRequest`)
 * and recovery (`buildRunDepsFromSession`) paths wire `requestHumanInput`/
 * `scheduleWakeup` into a run's toolbox, per the repository's No Duplicated
 * Code rule. Root cause this closes: `buildRunDepsFromSession` used to
 * return `runRuntime.toolbox` bare — the opt-in durable-park tools existed
 * ONLY on the fresh path. A run recovered mid-step whose replay reached a
 * `requestHumanInput` call found no such tool: armorer settled the call
 * with a tool-not-found error result, `pendingHumanWait` never got set, the
 * durable park never fired, and the step loop simply continued to the next
 * step — the exact "looped instead of parking" symptom this issue names,
 * observable only on a RECOVERED run whose replay reaches the call (a run
 * killed AFTER the call's step already committed is a different case,
 * covered by `create-bureau.ts`'s `reconstructHumanWaitReviewIfParked`).
 *
 * `servicesRef` is supplied by the caller, not created here: the tools'
 * mutable `pendingHumanWait`/`pendingWakeup` slots must be the EXACT
 * `ctx.services` object Weft hands back, and each caller has a different
 * point at which that object becomes available (a later `onServices` hook
 * for a fresh run; the object under construction, synchronously, for a
 * recovered one) — see each call site's own comment.
 */
export function wireDurableOptInTools(
  baseToolbox: BureauToolbox,
  servicesRef: { current?: DurableRunDeps },
  options: WireDurableOptInToolsOptions,
): BureauToolbox {
  let toolbox = baseToolbox;

  if (options.humanInput) {
    const humanWaitContext = createHumanWaitContext(servicesRef, options.runId);
    const rawHumanInputTool = createRequestHumanInputTool({
      context: humanWaitContext,
      ...(options.humanInputEmitter ? { emitter: options.humanInputEmitter } : {}),
    });
    const humanInputToolbox = createToolbox([
      createTool({
        ...rawHumanInputTool,
        // armorer's `execute` contract is async; the raw tool factory's
        // `execute` is synchronous (it only mutates `context` and returns a
        // plain result), so wrap it rather than changing its public shape.
        // Must stay `async` so a synchronous throw from `execute` is
        // converted into a rejected Promise instead of escaping
        // synchronously (Copilot review PRRT_kwDORvupsc6P7_8H) — awaiting
        // `Promise.resolve(...)` (a genuine thenable) keeps both
        // require-await and await-thenable satisfied.
        execute: async (input: RequestHumanInputInput) =>
          await Promise.resolve(rawHumanInputTool.execute(input)),
      }),
    ]);
    toolbox = combineToolboxes(toolbox, humanInputToolbox);
  }

  if (options.wakeup) {
    // Unlike `requestHumanInput`, `scheduleWakeup` dispatches no event on
    // park — `ctx.sleep` is itself the durable checkpoint, and recovery
    // re-arms it with no live wiring needed (AB-41's decision record) — so
    // no emitter is threaded here.
    const wakeupContext = createWakeupContext(servicesRef);
    const rawWakeupTool = createScheduleWakeupTool({ context: wakeupContext });
    const wakeupToolbox = createToolbox([
      createTool({
        ...rawWakeupTool,
        // Same async-wrap rationale as `requestHumanInput` above: the raw
        // tool's `execute` is synchronous and can throw synchronously
        // (`DurableCapabilityUnavailableError`); armorer's contract is
        // async, so wrapping converts a synchronous throw into a rejected
        // Promise instead of letting it escape synchronously.
        execute: async (input: ScheduleWakeupInput) =>
          await Promise.resolve(rawWakeupTool.execute(input)),
      }),
    ]);
    toolbox = combineToolboxes(toolbox, wakeupToolbox);
  }

  return toolbox;
}

const requestAuthorityMetadataKey = 'lastRequestAuthority';
const requestAuthoritiesMetadataKey = 'lastRequestAuthorities';
const defaultBureauAgentName = 'bureau';
const schedulerServicePrincipalId = 'service:scheduler';
const schedulerServiceAuthorizationRevision = 'bureau:scheduler:1';
const toolExecutionCapability = 'tools:execute';

function isJsonRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestContextFromAuthorityValue(
  value: JSONValue | undefined,
  runId: string | undefined,
  sessionId: string | undefined,
  agentName: string | undefined,
  now: () => number,
): ToolRequestContext | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const authority = value as Record<string, JSONValue>;
  const capabilities = authority['capabilities'];
  const audience = authority['audience'];
  const deadline = authority['deadline'];
  if (
    typeof authority['principalId'] !== 'string' ||
    typeof authority['tenantId'] !== 'string' ||
    typeof authority['ownerId'] !== 'string' ||
    typeof authority['authorizationRevision'] !== 'string' ||
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === 'string') ||
    (audience !== undefined &&
      audience !== 'public' &&
      audience !== 'tenant' &&
      audience !== 'operator') ||
    (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline)))
  ) {
    return undefined;
  }
  if (typeof deadline === 'number' && deadline <= now()) return undefined;
  return {
    authority: {
      principalId: authority['principalId'],
      tenantId: authority['tenantId'],
      ownerId: authority['ownerId'],
      capabilities: Object.freeze([...capabilities] as string[]),
      authorizationRevision: authority['authorizationRevision'],
    },
    ...(audience !== undefined ? { audience } : {}),
    ...(typeof deadline === 'number' ? { deadline } : {}),
    ...(agentName !== undefined ? { agentId: agentName } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/**
 * AB-260: exported directly rather than through the retired
 * `RuntimeCompositionTestingSeams` grouping — a genuine injection seam, not
 * introspection, since its only non-pure dependency was the wall clock
 * consulted for `requestContextFromAuthorityValue`'s deadline check. A test
 * calls this directly with a manual `now`, exactly as `createRuntimeComposition`
 * itself does with the bureau's composed `RuntimeServices.clock.now`.
 */
export function recoveredRequestContext(
  metadata: Record<string, JSONValue>,
  runId: string | undefined,
  sessionId: string | undefined,
  agentName: string | undefined,
  now: () => number,
): ToolRequestContext | undefined {
  const authorities = metadata[requestAuthoritiesMetadataKey];
  if (isJsonRecord(authorities)) {
    return requestContextFromAuthorityValue(
      runId === undefined ? undefined : authorities[runId],
      runId,
      sessionId,
      agentName,
      now,
    );
  }
  return requestContextFromAuthorityValue(
    metadata[requestAuthorityMetadataKey],
    runId,
    sessionId,
    agentName,
    now,
  );
}

function normalizedServiceAgentName(agentName: string | undefined): string {
  const trimmed = agentName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : defaultBureauAgentName;
}

export function createSchedulerServiceRequestContext(
  runId: string,
  agentName: string | undefined,
  sessionId?: string,
) {
  const ownerId = normalizedServiceAgentName(agentName);
  return {
    authority: {
      principalId: schedulerServicePrincipalId,
      tenantId: 'bureau',
      ownerId,
      capabilities: Object.freeze([toolExecutionCapability]),
      authorizationRevision: schedulerServiceAuthorizationRevision,
    },
    audience: 'operator',
    agentId: ownerId,
    runId,
    // AB-364 review finding (chatgpt-codex-connector): stamped for
    // consistency with every other request context this module builds —
    // NOT a fix for scheduled-fire grant matching, which the fixed
    // `principalId` above (always `schedulerServicePrincipalId`, never the
    // triggering user's own principal) already blocks unconditionally,
    // independent of scope or sessionId.
    ...(sessionId !== undefined ? { sessionId } : {}),
  } satisfies ToolRequestContext;
}

/**
 * COR-1228 — makes an active skill's `allowed-tools` actually narrow the tool
 * set the model sees.
 *
 * Two halves of a designed mechanism existed and were never connected:
 * `SkillSession.getActiveToolPolicy()` produced the merged policy and had no
 * consumer, and `@lostgradient/operative`'s `createPolicyEnforcementHook` consumes
 * exactly that shape through its `getActiveSkillToolPolicy` option and had no
 * consumer either. This wires them together.
 *
 * Deliberately a FILTER, not a per-call gate. `armorer`'s own
 * `PermissionGate` documentation draws the line: "a filter removes a tool from
 * the array before the model ever sees it exists. A gate runs per call against
 * the actual arguments the model chose." `ToolPolicy` is named there as the
 * filter, so implementing it as one is faithful to the contract rather than
 * inventing a stronger promise than the type makes. The per-call gate remains
 * `createHeadlessPermissionPolicyHooks`, a complementary layer — the two
 * compose, and this adds no second narrowing path.
 *
 * The policy is read live on each `tools()` call rather than captured, because
 * the active skill set changes during a run as the model activates and
 * deactivates skills. A proxy is used rather than rebuilding the toolbox so the
 * emitter, approval wiring, and request context all survive untouched.
 */
function withActiveSkillToolPolicy(
  toolbox: AnyToolbox,
  getActiveSkillToolPolicy: () => ToolPolicy | undefined,
): AnyToolbox {
  const filterTools = createPolicyEnforcementHook({ getActiveSkillToolPolicy });

  return new Proxy(toolbox, {
    get(target, property, receiver) {
      if (property === 'tools') {
        return () => filterTools([...target.tools()]);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function withDefaultToolboxRequestContext(
  toolbox: AnyToolbox,
  requestContext: ToolRequestContext | undefined,
  requestAuthorityValidator: () =>
    ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
  runtimeServices: RuntimeServices,
): AnyToolbox {
  if (!requestContext) return toolbox;

  const executeWithDefaultRequestContext = (async (
    input: ToolCallInput | ToolCallInput[],
    executeOptions?: ToolboxExecuteOptions,
  ) => {
    const options =
      executeOptions?.requestContext === undefined
        ? { ...executeOptions, requestContext }
        : executeOptions;
    const executionRequestContext = options.requestContext;
    const authorizationRevision = executionRequestContext?.authority.authorizationRevision;
    const requiresTransportValidation =
      authorizationRevision !== undefined &&
      authorizationRevision !== 'bureau:1' &&
      authorizationRevision !== 'bureau:scheduler:1';
    if (requiresTransportValidation && executionRequestContext) {
      const validator = requestAuthorityValidator();
      if (
        !validator ||
        !(await raceRequestAuthorityValidation(
          validator(executionRequestContext),
          options,
          runtimeServices,
        ))
      ) {
        throw new Error('Request authority is no longer current.');
      }
    }
    return Array.isArray(input) ? toolbox.execute(input, options) : toolbox.execute(input, options);
  }) as AnyToolbox['execute'];

  return new Proxy(toolbox, {
    get(target, property, receiver) {
      if (property === 'execute') return executeWithDefaultRequestContext;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function raceRequestAuthorityValidation(
  validation: boolean | Promise<boolean>,
  options: ToolboxExecuteOptions,
  runtimeServices: RuntimeServices,
): Promise<boolean> {
  const signal = options.signal;
  const deadline = options.requestContext?.deadline;
  const now = options.now ?? runtimeServices.clock.now;
  if (signal?.aborted) {
    return Promise.reject(new Error(String(signal.reason ?? 'Cancelled')));
  }
  if (deadline !== undefined && deadline <= now()) {
    return Promise.reject(new Error('Execution deadline exceeded'));
  }
  if (!signal && deadline === undefined) return Promise.resolve(validation);

  const maximumTimerDelay = 2_147_483_647;
  // AB-260: the timer-scheduling/clearing members are destructured once so
  // the call sites below read `scheduleTimeout(...)`/`clearTimeoutFunction(...)`
  // rather than a literal `timers` method call — see `create-bureau.ts`'s
  // equivalent pattern for why.
  const { setTimeout: defaultScheduleTimeout, clearTimeout: defaultCancelTimeout } =
    runtimeServices.timers;
  const setTimeoutFunction =
    options.setTimeoutFunction ??
    ((callback: () => void, milliseconds: number) =>
      defaultScheduleTimeout(callback, milliseconds));
  const clearTimeoutFunction = options.clearTimeoutFunction ?? defaultCancelTimeout;
  let timer: unknown;
  let onAbort: (() => void) | undefined;
  const interruption = new Promise<boolean>((_resolve, reject) => {
    onAbort = () => reject(new Error(String(signal?.reason ?? 'Cancelled')));
    signal?.addEventListener('abort', onAbort, { once: true });
    const scheduleDeadline = () => {
      if (deadline === undefined) return;
      const remaining = deadline - now();
      if (remaining <= 0) {
        reject(new Error('Execution deadline exceeded'));
        return;
      }
      timer = setTimeoutFunction(scheduleDeadline, Math.min(remaining, maximumTimerDelay));
    };
    scheduleDeadline();
  });
  return Promise.race([Promise.resolve(validation), interruption]).finally(() => {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (timer !== undefined) clearTimeoutFunction(timer);
  });
}

/**
 * AB-40 — the enabled-by-default guardrail preset. Wired whenever
 * `BureauOptions.guardrails` is omitted (`undefined`): a prompt-injection
 * input detector (gated at `confidence >= DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD`
 * — see {@link withMinimumTripwireConfidence}) and an output PII validator,
 * both in `mode: 'tripwire'` — a trip hard-halts the run (`finishReason:
 * 'tripwire'`) rather than substituting a blocked/redacted response. Pass
 * `guardrails: false` to opt out entirely, or a `GuardrailsOptions` to
 * replace this preset.
 */
function defaultGuardrailsPreset(): GuardrailsOptions {
  return {
    mode: 'tripwire',
    input: {
      detectors: [
        withMinimumTripwireConfidence(
          createPromptInjectionDetector(),
          DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD,
        ),
      ],
    },
    output: { validators: [createOutputPIIValidator()] },
  };
}

/**
 * Discriminate a {@link PersistenceOptions} object from a bare
 * `StorageConfiguration` or `ConditionalTextValueStore`. A `PersistenceOptions` is
 * identified by the presence of a `store` field that is itself a
 * `StorageConfiguration` object (has a `type` string discriminant).
 */
function isPersistenceOptions(value: BureauOptions['persistence']): value is PersistenceOptions {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    'store' in candidate &&
    typeof candidate['store'] === 'object' &&
    candidate['store'] !== null &&
    'type' in (candidate['store'] as Record<string, unknown>)
  );
}

/**
 * Discriminate a `StorageConfiguration` object from a `ConditionalTextValueStore`.
 * `StorageConfiguration` always carries a `type` string discriminant; a
 * `ConditionalTextValueStore` has callable `get`/`set` methods instead.
 */
function isStorageConfiguration(
  value: StorageConfiguration | Storage | ConditionalTextValueStore,
): value is StorageConfiguration {
  const candidate = value as Record<string, unknown>;
  return typeof candidate['type'] === 'string';
}

/**
 * Resolve the persistence options into a normalized `StorageConfiguration` (or
 * `undefined`) and any operational knobs for the durable engine.
 *
 * - `PersistenceOptions` → extracts `store` plus `history`/`observability`/`onLog`.
 * - Bare `StorageConfiguration` → `store` only, no extra knobs.
 * - `ConditionalTextValueStore` → KV-only, no durable storage config.
 * - `undefined` → no persistence.
 */
function resolvePersistenceOptions(options: RuntimeCompositionOptions): {
  storageConfig: StorageConfiguration | undefined;
  kvStore: ConditionalTextValueStore | undefined;
  persistenceHistory: PersistenceOptions['history'];
  persistenceObservability: PersistenceOptions['observability'];
  persistenceOnLog: PersistenceOptions['onLog'];
} {
  const { persistence } = options;

  if (persistence === undefined) {
    return {
      storageConfig: undefined,
      kvStore: undefined,
      persistenceHistory: undefined,
      persistenceObservability: undefined,
      persistenceOnLog: undefined,
    };
  }

  if (isPersistenceOptions(persistence)) {
    return {
      storageConfig: persistence.store,
      kvStore: undefined,
      persistenceHistory: persistence.history,
      persistenceObservability: persistence.observability,
      persistenceOnLog: persistence.onLog,
    };
  }

  if (isStorageConfiguration(persistence)) {
    // Bare StorageConfiguration: same as { store: persistence }
    return {
      storageConfig: persistence,
      kvStore: undefined,
      persistenceHistory: undefined,
      persistenceObservability: undefined,
      persistenceOnLog: undefined,
    };
  }

  // ConditionalTextValueStore: KV-only, no durable storage
  return {
    storageConfig: undefined,
    kvStore: persistence,
    persistenceHistory: undefined,
    persistenceObservability: undefined,
    persistenceOnLog: undefined,
  };
}

/**
 * Whether a `RunResult.finishReason` (or a Weft `WorkflowCompletedEvent.result`
 * carrying one) represents a failure outcome rather than a clean stop. Shared
 * by `monitorRecoveredScheduledFire` (create-bureau.ts, diagnostic logging for
 * a recovered fire) and the fire-terminal `schedule.completed`/`schedule.failed`
 * dispatch below (AB-223) — both must agree on what "failed" means for a
 * scheduled fire, so this lives in exactly one place.
 */
export function isRunFailureFinishReason(finishReason: unknown): boolean {
  return (
    finishReason === 'error' ||
    finishReason === 'tripwire' ||
    finishReason === 'maximum-steps' ||
    finishReason === 'elicitation-denied' ||
    finishReason === 'budget-exceeded'
  );
}

function isMemoryInstance(value: CreateMemoryOptions | Memory): value is Memory {
  return typeof (value as Memory).remember === 'function';
}

function persistedScheduleMarker(input: ScheduledAgentRunInput): string | undefined {
  if (typeof input.scheduleId !== 'string') return undefined;
  const scheduleId = input.scheduleId.trim();
  return scheduleId.length > 0 ? scheduleId : undefined;
}

function hasPersistedScheduleMarker(input: ScheduledAgentRunInput): boolean {
  return persistedScheduleMarker(input) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Weft 0.10+ native `KEYS.scheduleRun(...)` marker: an object of shape
 * `{ id, occurrence? }` written by `encodeScheduleRunMetadata` (see weft's
 * `src/core/engine/schedule-run-metadata.ts`). Pre-0.10 stores may still hold
 * the legacy plain-string marker, handled separately in
 * {@link decodeScheduleRunMarker}.
 */
function isScheduleRunMarkerObject(value: unknown): value is { id: string; occurrence?: number } {
  if (!isRecord(value)) return false;
  const { id, occurrence } = value;
  return typeof id === 'string' && (occurrence === undefined || typeof occurrence === 'number');
}

/**
 * Decode a `KEYS.scheduleRun(...)` storage value (already `decode()`d from
 * bytes) into its schedule id, accepting both the legacy plain-string marker
 * and Weft 0.10+'s `{ id, occurrence? }` metadata object. Returns `undefined`
 * when the value is neither shape, or the id is blank. The returned id is
 * always trimmed, so accidental whitespace never propagates into downstream
 * equality checks or embedded session ids.
 */
export function decodeScheduleRunMarker(decoded: unknown): string | undefined {
  if (typeof decoded === 'string') {
    const trimmed = decoded.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (isScheduleRunMarkerObject(decoded)) {
    const trimmed = decoded.id.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * AB-240: the recovery record `bureau.run()`'s durable catalog dispatch
 * persists BEFORE starting the durable engine, keyed by the run's workflow
 * id — a marker entirely separate from (and never correlated with)
 * `sessionStore`'s `lastRunId`/`lastRunStatus`, because a catalog run never
 * owns a bureau session. `definitionRevision` is `AgentGenerationProfile.revision`
 * (operative's existing per-agent stable-revision field, read via
 * `readGenerationProfile`) at dispatch time — the closest existing "has this
 * catalog agent's definition changed" signal, reused rather than inventing a
 * new one. `input` is the ORIGINAL `AgentInput` `bureau.run(name, input)` was
 * called with: `AgentRunWorkflowInput.prompt` is NOT a substitute (it is a
 * seed-only field the durable workflow itself ignores on resume — see its own
 * doc comment), and `OPERATIVE_RESOLVE_RUN_OPTIONS` must be re-invoked with the
 * real input to rebuild `RunOptions` fresh each boot, the same way
 * `buildRunDepsFromSession` rebuilds session-owned deps from config rather
 * than a stored blob.
 */
export interface CatalogRunRecoveryRecord {
  readonly schemaVersion: 1;
  readonly agentName: string;
  readonly definitionRevision: number;
  readonly input: AgentInput;
  /**
   * AB-241 review finding: the attributing principal `bureau.run(name, input,
   * { principal })` recorded in the live, pre-crash `runAttribution` map —
   * persisted here too so a durable catalog run that crosses a process
   * restart keeps its attribution. Without this, a resumed run's rebuilt
   * `AgentRunContext` carried no `principal` at all, so `eventHistory`'s
   * principal gate would fail closed for a run recovery re-resolves.
   * Absent when the original dispatch supplied no principal.
   */
  readonly principal?: string;
}

// Exported for tests only — lets `runtime-composition.test.ts` construct the
// exact storage key to exercise `loadCatalogRunRecoveryRecord`'s read-error
// branch by writing malformed raw bytes directly through the durable engine's
// own `Storage` (`runtime.durable.engine.storage`), the only way to inject a
// genuine decode failure rather than a merely-absent or malformed-but-decodable
// record.
export const CATALOG_RUN_RECOVERY_KEY_PREFIX = 'bureau-catalog-run:';

function catalogRunRecoveryKey(runId: string): string {
  return `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`;
}

function isCatalogAgentInput(value: unknown): value is AgentInput {
  if (typeof value === 'string') return true;
  return isRecord(value) && isRecord(value['conversation']);
}

function isCatalogRunRecoveryRecord(value: unknown): value is CatalogRunRecoveryRecord {
  if (!isRecord(value)) return false;
  if (value['schemaVersion'] !== 1) return false;
  const agentName = value['agentName'];
  if (typeof agentName !== 'string' || agentName.length === 0) return false;
  if (typeof value['definitionRevision'] !== 'number') return false;
  const principal = value['principal'];
  if (principal !== undefined && typeof principal !== 'string') return false;
  return isCatalogAgentInput(value['input']);
}

/**
 * The outcome of re-resolving a catalog agent's `RunOptions` during boot
 * recovery — `resolveRunServices`'s catalog branch consults
 * `catalogAgentRunOptionsResolver` (wired by `createBureau` from its own
 * agent catalog, which `createRuntimeComposition` deliberately does not know
 * about — see this file's own `RuntimeCompositionOptions` doc comment) rather
 * than reaching into the catalog directly.
 */
export type CatalogAgentRunOptionsResolution =
  | { status: 'resolved'; options: RunOptions; definitionRevision: number }
  | { status: 'missing-agent' }
  /**
   * The named agent exists in the catalog but does not (or no longer)
   * expose AB-21's `OPERATIVE_RESOLVE_RUN_OPTIONS` — distinct from
   * `'missing-agent'` (review finding: conflating the two produced the
   * misleading "is no longer in the catalog" reason for an agent that
   * genuinely IS still there, just not durable-resolution-capable). This is
   * reachable at recovery even though live dispatch only reaches the
   * durable branch for a resolver-exposing agent: the catalog can be
   * reconfigured between restarts to swap the same name to a different
   * `RunnableAgent` that lacks the capability.
   */
  | { status: 'not-durable-capable' }
  | { status: 'resolver-failed'; error: unknown };

export type CatalogAgentRunOptionsResolver = (
  agentName: string,
  input: AgentInput,
  context: AgentRunContext,
) => Promise<CatalogAgentRunOptionsResolution>;

type RecoveredScheduleMarker =
  | { status: 'found'; scheduleId: string }
  | { status: 'missing'; sessionId?: string }
  | { status: 'read-error'; error: unknown; sessionId?: string };

function recoveredMarkerSessionId(marker: RecoveredScheduleMarker | undefined): string | undefined {
  return marker?.status === 'found' ? undefined : marker?.sessionId;
}

function lastScheduledFirePromptIndex(history: ConversationHistory, runId: string): number {
  for (let index = history.ids.length - 1; index >= 0; index -= 1) {
    const message = history.messages[history.ids[index]!];
    if (message?.role === 'user' && message.metadata['scheduledFireRunId'] === runId) {
      return index;
    }
  }
  return -1;
}

function removeConversationIndexRange(
  history: ConversationHistory,
  startIndex: number,
  endIndex: number,
): ConversationHistory {
  const ids = history.ids.filter((_, index) => index < startIndex || index > endIndex);
  const messages: Record<string, ConversationHistory['messages'][string]> = {};
  for (const [position, id] of ids.entries()) {
    const message = history.messages[id];
    if (message) messages[id] = { ...message, position };
  }
  return { ...history, ids, messages };
}

export function removeLastScheduledFireTranscript(
  history: ConversationHistory,
  runId: string,
): ConversationHistory {
  const promptIndex = lastScheduledFirePromptIndex(history, runId);
  if (promptIndex === -1) return history;
  const nextUserIndex = history.ids.findIndex((id, index) => {
    if (index <= promptIndex) return false;
    return history.messages[id]?.role === 'user';
  });
  const endIndex = nextUserIndex === -1 ? history.ids.length - 1 : nextUserIndex - 1;
  return removeConversationIndexRange(history, promptIndex, endIndex);
}

function redactProvider(provider: ProviderConfiguration): RedactedProviderConfiguration {
  const { apiKey: _apiKey, ...safeProvider } = provider;
  return safeProvider;
}

/**
 * Inject recalled memories as a system message on step 0. Replay classification
 * (seam #11): `safe` — it only reads (`memory.recall`) and mutates the step's
 * transient `Conversation` (the durable workflow rehydrates a fresh
 * `Conversation.from(snapshot)` per step, so a recovery re-fire just re-injects
 * into that step's conversation; no external side effect, no idempotency needed).
 */
export function createMemoryRecallHook(memory: Memory, sessionId: string): PrepareStepHook {
  return async (context) => {
    if (context.step !== 0) {
      return;
    }

    const messages = context.conversation.getMessages();
    const latestUserMessage = messages
      .toReversed()
      .find((message) => message.role === 'user' && typeof message.content === 'string');

    if (!latestUserMessage || typeof latestUserMessage.content !== 'string') {
      return;
    }

    const recalls = await memory.recall(latestUserMessage.content, {
      limit: 5,
      namespace: sessionId,
    });

    if (recalls.length === 0) {
      return;
    }

    const content = recalls.map((entry, index) => `${index + 1}. ${entry.content}`).join('\n');
    context.conversation.appendSystemMessage(`Relevant memory:\n${content}`, {
      _memoryInjected: true,
      _memorySessionId: sessionId,
    });
  };
}

/**
 * Persist the final assistant content of a step as an experiential memory.
 *
 * EFFECTFUL hook (seam #11): on a durable recovery the crashed in-flight step
 * re-runs from its boundary, so this hook can fire AGAIN for the same step. The
 * mitigation is IDEMPOTENCY, not suppression-on-replay — suppressing the hook
 * would drop the write for a step whose work (generate + tools) did re-execute,
 * leaving memory out of sync with a step that ran.
 *
 * Idempotency is enforced by a DETERMINISTIC operation key, not by content: a
 * replayed step may produce non-byte-identical content (its `generate` re-runs),
 * so relying on the memory store's cosine-similarity dedup is not sufficient.
 * Instead the write uses a stable `dedupeKey` of `${runId}:${step}` (the durable
 * operation's identity — same run, same step index across a replay) with
 * `memory.rememberOnce()`, so a re-fire is an atomic no-op regardless of content
 * drift.
 *
 * When no `runId` is available (a non-durable run, where there is no replay and
 * therefore no re-fire hazard), the dedup guard is skipped and the write proceeds
 * — the at-least-once concern only exists on the durable recovery path.
 *
 * `replay: 'effectful'` ({@link HookReplayPolicy}) is recorded on the write for
 * diagnostics; it documents the contract and never gates execution.
 */
export function createMemoryPersistHook(
  memory: Memory,
  sessionId: string,
  runId?: string,
): OnStepHook {
  return async (context) => {
    if (!context.final || !context.content.trim()) {
      return;
    }

    // Deterministic identity of THIS durable operation: same run + same step
    // index on a replay. Content-independent, so a divergent regenerate cannot
    // produce a second record.
    const dedupeKey = runId === undefined ? undefined : `${runId}:${context.step}`;

    const metadata = {
      namespace: sessionId,
      source: 'experiential',
      step: context.step,
      ...(dedupeKey !== undefined ? { dedupeKey } : {}),
      // Replay classification (seam #11): an external write → `effectful`, kept
      // safe across a recovery re-fire by the atomic dedupeKey write. Metadata
      // only; never gates execution.
      replay: 'effectful' satisfies HookReplayPolicy,
    } as const;

    if (dedupeKey === undefined) {
      await memory.remember(context.content, metadata);
      return;
    }

    await memory.rememberOnce(context.content, { ...metadata, dedupeKey });
  };
}

export function resolveProviderGenerate(
  provider: ProviderConfiguration,
  streamEventTarget: TypedEventTarget<StreamEventMap> | undefined,
  streamingConfiguration: BureauOptions['streaming'],
): GenerateFunction {
  if (streamEventTarget) {
    switch (provider.provider) {
      case 'anthropic':
        return withEnhancedStreaming(createAnthropicProviderStream(provider), {
          eventTarget: streamEventTarget,
          onTextDelta: streamingConfiguration?.onTextDelta,
        });
      case 'openai':
        return withEnhancedStreaming(createOpenAIProviderStream(provider), {
          eventTarget: streamEventTarget,
          onTextDelta: streamingConfiguration?.onTextDelta,
        });
      case 'gemini':
        return withEnhancedStreaming(createGeminiProviderStream(provider), {
          eventTarget: streamEventTarget,
          onTextDelta: streamingConfiguration?.onTextDelta,
        });
      default:
        break;
    }
  }

  switch (provider.provider) {
    case 'anthropic':
      return createAnthropicProvider(provider);
    case 'openai':
      return createOpenAIProvider(provider);
    case 'gemini':
      return createGeminiProvider(provider);
    default:
      throw new Error(`Unknown provider: ${String(provider.provider)}`);
  }
}

type RoutingResult =
  | { kind: 'direct'; strategy: ReturnType<typeof createStepBasedStrategy> }
  | {
      kind: 'cost-aware';
      strategy: ReturnType<typeof createCostAwareStrategy>;
      onUsage: (usage: { total: number } | undefined) => void;
    };

function createCostAwareRoutingStrategy(
  configuration: Extract<RoutingConfiguration, { type: 'cost-aware' }>,
): RoutingResult {
  let spent = 0;
  return {
    kind: 'cost-aware',
    strategy: createCostAwareStrategy({
      cheap: configuration.cheap,
      expensive: configuration.expensive,
      thresholdRatio: configuration.thresholdRatio ?? 0.8,
      getBudgetState: () => ({ spent, budget: configuration.budget }),
    }),
    onUsage(usage: { total: number } | undefined) {
      spent += usage?.total ?? 0;
    },
  };
}

export function createRoutingStrategy(configuration: RoutingConfiguration): RoutingResult {
  switch (configuration.type) {
    case 'step-based':
      return {
        kind: 'direct',
        strategy: createStepBasedStrategy({
          first: configuration.first,
          middle: configuration.middle,
          last: configuration.last,
          middleAfterStep: configuration.middleAfterStep,
        }),
      };
    case 'complexity':
      return {
        kind: 'direct',
        strategy: createComplexityStrategy({
          simple: configuration.simple,
          complex: configuration.complex,
          frontier: configuration.frontier,
          scorer(signals) {
            const useSimple =
              signals.toolCount <= (configuration.simpleMaxTools ?? 2) &&
              signals.lastMessageLength <= (configuration.simpleMaxLength ?? 500);
            if (useSimple) return 'simple';

            const useFrontier =
              configuration.frontier !== undefined && signals.conversationDepth > 20;
            return useFrontier ? 'frontier' : 'complex';
          },
        }),
      };
    case 'cost-aware':
      return createCostAwareRoutingStrategy(configuration);
  }
}

function withUsageTracking(
  generate: GenerateFunction,
  onUsage: (usage: { total: number } | undefined) => void,
): GenerateFunction {
  return async (context) => {
    const response = await generate(context);
    onUsage(response.usage);
    return response;
  };
}

export function applyCache(
  generate: GenerateFunction,
  configuration: CacheConfiguration | undefined,
  store: TextValueStore | undefined,
): GenerateFunction {
  if (!configuration) {
    return generate;
  }

  const cacheStore = configuration.store ?? store;
  if (configuration.enabled === false || !cacheStore) {
    return generate;
  }

  return withCache(generate, {
    ...configuration,
    store: cacheStore,
  });
}

export type RuntimeCompositionDependencies = {
  resolveProviderGenerate: typeof resolveProviderGenerate;
  /**
   * Builds the session store this composition uses over its resolved KV
   * view. Defaults to operative's own `createSessionStore` — the real
   * production wiring. A caller (test or platform package) that supplies a
   * different `SessionStore` implementation here does so through the SAME
   * non-test-gated dependency-injection parameter `resolveProviderGenerate`
   * already establishes, not a retired test-only seam: this package's own
   * test suite uses it to exercise `resolveRunServices`' failure-handling
   * branches (a store whose `load`/`updateMetadata` fails) without a
   * private mutation backdoor.
   */
  createSessionStore?: typeof createSessionStore;
};

const defaultRuntimeCompositionDependencies: RuntimeCompositionDependencies = {
  resolveProviderGenerate,
  createSessionStore,
};

/**
 * AB-260 — the `resolveRunServices` composition-readiness guard, extracted
 * as a pure function so it is directly unit-testable without the retired
 * `RuntimeCompositionTestingSeams.setCompositionReady` mutation backdoor:
 * `resolveRunServices` itself always calls this with `compositionReady`
 * already `true` (nothing outside this module can observe the transient
 * `false` window during construction — see `createRuntimeComposition`'s own
 * comment on the gate), so the branch this guards is proven correct here,
 * directly, rather than by reproducing the real-but-effectively-untriggerable
 * race a private setter used to force.
 */
export function compositionReadyGuardResult(
  ready: boolean,
  workflowId: string,
): { status: 'unavailable'; reason: string } | undefined {
  return ready
    ? undefined
    : { status: 'unavailable', reason: `run ${workflowId}: composition not ready` };
}

function messagesAreEqual(
  left: ConversationHistory['messages'][string],
  right: ConversationHistory['messages'][string],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendConversationMessages(
  current: ConversationHistory,
  candidate: ConversationHistory,
  base: ConversationHistory,
): ConversationHistory {
  const baseIds = new Set(base.ids);
  const candidateIds = new Set(candidate.ids);
  const currentIds = new Set(current.ids);
  const currentPreservedIds = current.ids.filter((id) => candidateIds.has(id) || !baseIds.has(id));
  const candidateOnlyIds = candidate.ids.filter((id) => !currentIds.has(id));
  const ids = [...currentPreservedIds, ...candidateOnlyIds];
  const messages: Record<string, ConversationHistory['messages'][string]> = {};

  for (const id of ids) {
    const candidateMessage = candidate.messages[id];
    const baseMessage = base.messages[id];
    const message =
      candidateMessage &&
      (!baseMessage || !messagesAreEqual(candidateMessage, baseMessage) || !current.messages[id])
        ? candidateMessage
        : (current.messages[id] ?? candidateMessage);
    if (message) messages[id] = message;
  }

  for (const [position, id] of ids.entries()) {
    const message = messages[id];
    if (message) messages[id] = { ...message, position };
  }

  return {
    ...current,
    metadata: {
      ...current.metadata,
      ...candidate.metadata,
    },
    ids,
    messages,
    updatedAt: candidate.updatedAt,
  };
}

const activeSkillsStepMetadataKey = '__bureauActiveSkills';
const activeSkillsStepMetadataVersion = 2;

function activeSkillsStepMetadata(records: readonly SkillActivationRecord[]): JSONValue {
  return {
    version: activeSkillsStepMetadataVersion,
    entries: records as unknown as JSONValue,
  };
}

export function activeSkillsFromStepMetadata(
  metadata: StepRecord['metadata'],
): SkillActivationRecord[] | undefined {
  const raw = metadata?.[activeSkillsStepMetadataKey];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const snapshot = raw as Record<string, unknown>;
  if (snapshot['version'] !== activeSkillsStepMetadataVersion) return undefined;
  const entries = snapshot['entries'];
  return isSkillActivationRecordArray(entries) ? entries : undefined;
}

/**
 * Validates a value read back out of session or step metadata as activation records.
 *
 * Every digest field is required, not optional. A record missing one would recover a skill by name
 * with nothing to check the content against, which is the failure the records exist to prevent —
 * so a malformed snapshot recovers nothing rather than recovering unverifiably.
 */
export function isSkillActivationRecordArray(value: unknown): value is SkillActivationRecord[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Record<string, unknown>;
    for (const field of [
      'name',
      'sourceId',
      'sourceKind',
      'trust',
      'artifactDigest',
      'instructionsDigest',
      'activatedAt',
    ]) {
      if (typeof candidate[field] !== 'string') return false;
    }
    if (typeof candidate['catalogRevision'] !== 'number') return false;
    if (!Array.isArray(candidate['requestedTools'])) return false;
    if (candidate['requestedTools'].some((tool) => typeof tool !== 'string')) return false;
  }
  return true;
}

/**
 * The session-metadata keys a step boundary writes.
 *
 * The same keys {@link createSkillRecordSnapshotHook} writes, deliberately: one snapshot
 * mechanism, one set of keys, one thing for recovery to read. Two parallel snapshots is how a
 * recovered run ends up restoring whichever of them the reader happened to know about.
 */
function activeSkillSessionMetadataForStep(
  records: readonly SkillActivationRecord[],
  step: number,
  runId?: string,
): Record<string, JSONValue> {
  return {
    activeSkillRecords: records as unknown as JSONValue,
    ...(runId !== undefined
      ? {
          activeSkillRecordsRunId: runId,
          activeSkillRecordsStep: step,
        }
      : {}),
  };
}

export function recordedAgentStep(value: unknown): StepRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['conversationSnapshot'] !== 'object' ||
    candidate['conversationSnapshot'] === null
  ) {
    return undefined;
  }
  if (typeof candidate['nextAccumulators'] !== 'object' || candidate['nextAccumulators'] === null) {
    return undefined;
  }
  const record = candidate['record'];
  if (typeof record !== 'object' || record === null) return undefined;
  const stepRecord = record as Record<string, unknown>;
  const step = stepRecord['step'];
  if (!Number.isInteger(step) || (step as number) < 0) return undefined;
  if (typeof stepRecord['content'] !== 'string') return undefined;
  if (!Array.isArray(stepRecord['toolCalls'])) return undefined;
  if (!Array.isArray(stepRecord['results'])) return undefined;
  if (typeof stepRecord['final'] !== 'boolean') return undefined;
  if (
    stepRecord['metadata'] !== undefined &&
    (typeof stepRecord['metadata'] !== 'object' ||
      stepRecord['metadata'] === null ||
      Array.isArray(stepRecord['metadata']))
  ) {
    return undefined;
  }
  return record as StepRecord;
}

/**
 * Snapshot the active skill set to session metadata after each completed step.
 *
 * EFFECTFUL hook (seam #11): on a durable recovery the crashed in-flight step
 * re-runs from its boundary, so this hook can fire AGAIN for the same step. The
 * write is IDEMPOTENT — a re-fire for step N overwrites `activeSkillRecords` with the
 * same value (completed steps do not re-run their tool executions, so the active-skill
 * set is unchanged on replay). This is a state snapshot, NOT an append — the last
 * writer wins (matching the single-source-of-truth model for `activeSkillRecords`).
 *
 * Replay classification: `effectful` (writes to external storage) but SAFE across
 * recovery re-fires because the payload is deterministic for a given step boundary
 * (completed steps replay identically, producing the same active-skill set).
 */
/**
 * Snapshots the catalog revision and every activation record after each step.
 *
 * The provider-backed snapshot carries a name and a tool policy. That is enough to re-activate
 * something with the same name and nothing at all to prove it is the same skill — COR-752 named
 * exactly this gap ("neither carries source, trust decision, digest, or admitted instructions").
 * These records carry the source, the trust decision, the artifact digest and the instructions
 * digest, which is what lets recovery refuse a skill whose content drifted rather than silently
 * resurrecting different text under a reviewed name.
 */
function createSkillRecordSnapshotHook(
  client: { activationRecords(): readonly SkillActivationRecord[] },
  catalog: { revision: number; digest: string },
  sessionId: string,
  store: SessionStore,
  runId?: string,
): OnStepHook {
  return async (context) => {
    try {
      await store.updateMetadata(sessionId, {
        activeSkillRecords: client.activationRecords() as unknown as JSONValue,
        skillCatalogRevision: catalog.revision,
        skillCatalogDigest: catalog.digest,
        ...(runId === undefined
          ? {}
          : { activeSkillRecordsRunId: runId, activeSkillRecordsStep: context.step }),
      });
    } catch {
      // Non-fatal, same as the entry-based hook: a failed snapshot must not abort the step. The
      // cost is that recovery starts from an empty active set, which is the safe direction.
    }
  };
}

function createUnavailableToolbox(): BureauToolbox {
  const emptyToolbox = createToolbox([], { context: {} });
  const execute = ((
    toolCalls: ToolCallInput | ToolCallInput[],
    executionOptions?: Parameters<BureauToolbox['execute']>[1],
  ) => {
    const normalizedToolCalls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
    if (normalizedToolCalls.length > 0) {
      throw new Error('No toolbox configured but tool calls were received');
    }

    return emptyToolbox.execute([], executionOptions);
  }) as unknown as BureauToolbox['execute'];

  return {
    ...emptyToolbox,
    execute,
  };
}

/**
 * The durable run engine + checkpoint store, plus the optional observability
 * handle. `observability` is present only when `BureauOptions.observability` was
 * enabled; its `dispose` MUST be called before `engine[Symbol.dispose]()` so the
 * engine's terminal lifecycle events still reach the span-closing listeners.
 */
export interface DurableComposition {
  engine: RegistryAgnosticEngine;
  checkpointStore: CheckpointStore;
  observability?: RunEngineObservability | undefined;
}

/**
 * The schedule-fire events dispatched onto
 * {@link RuntimeComposition.scheduleFireEvents}: the two fire-terminal
 * outcomes (AB-223) and the two per-tick observation signals (COR-660) that
 * report an occurrence the overlap policy attempted and, when it collided,
 * dropped.
 */
export interface ScheduleFireEventMap extends EventMap {
  [ScheduleCompletedEvent.type]: ScheduleCompletedEvent;
  [ScheduleFailedEvent.type]: ScheduleFailedEvent;
  [ScheduleAttemptedEvent.type]: ScheduleAttemptedEvent;
  [ScheduleSkippedEvent.type]: ScheduleSkippedEvent;
}

export interface RuntimeComposition {
  kv: ConditionalTextValueStore | undefined;
  /**
   * The durable run engine + checkpoint store, present whenever durable
   * execution resolves on (by default: a persistent `storage` backend is
   * configured and `durableExecution` is not explicitly `false`). When present,
   * `createBureau` routes every `createRun()` through it transparently — the run
   * surface is unchanged, but the run is checkpointed and resumes after a crash.
   */
  durable: DurableComposition | undefined;
  /**
   * Dispatches `ScheduleCompletedEvent`/`ScheduleFailedEvent` (AB-223) for
   * every scheduled fire's terminal outcome, live or recovered. Populated by a
   * `durable.engine` `workflow:completed`/`workflow:failed` listener,
   * correlated against the `scheduleId` recorded in `buildScheduledRunServices`
   * when that fire's deps were built — the map entry it reads is deleted the
   * instant this fires, so exactly one event dispatches per fire regardless of
   * whether it settled as a live tick or was recovered on boot (both routes
   * settle through this same Weft engine terminal event). `createBureau`
   * forwards each event onto the bureau's own `emitter` (scheduled fires are
   * headless — there is no per-run emitter to dispatch onto instead). A run
   * with no correlated `scheduleId` (every ordinary, non-scheduled run) is
   * silently ignored.
   */
  scheduleFireEvents: TypedEventTarget<ScheduleFireEventMap>;
  /**
   * Skill lifecycle events (COR-767), dispatched by the `@lostgradient/skills`
   * tool factories each run's toolbox is built from. One bureau-level target
   * rather than one per run, matching `scheduleFireEvents`: each event carries
   * its own `runId`/`sessionId` correlation, so a shared target loses nothing
   * and `createBureau` forwards from exactly one place.
   */
  skillEvents: TypedEventTarget<SkillEventMap>;
  /**
   * Run ids the durable engine flagged, during boot recovery, as resuming
   * under a DIFFERENT workflow version than the one they were checkpointed
   * with (AB-10 — workflow versioning for in-flight durable runs). Populated
   * by the `onWorkflowVersionMismatch` callback wired into `createRunEngine`,
   * which fires once per recovered run BEFORE `engine.recoverAll()` returns —
   * so this map is fully populated by the time the bureau's recovery loop
   * calls `classifyRecoveredRun`. Never cleared: entries are read exactly once
   * per boot recovery pass and the map is rebuilt fresh on the next boot.
   *
   * Keyed by runId, valued with the stored/registered version strings (AB-12
   * run inspector — `reattachRecoveredRun` reads these to stamp a
   * `workflow.reattached` timeline marker with the mismatch detail, not just
   * the boolean `classifyRecoveredRun` needs).
   */
  workflowVersionMismatches: Map<string, { storedVersion: string; registeredVersion: string }>;
  /**
   * Disposes the raw `Storage` backend this composition resolved from
   * `options.storage`, if any. The KV/checkpoint views are created with
   * `disposeUnderlyingStorage: false` (they share one backend), and Weft's
   * `engine[Symbol.dispose]()` does NOT close the storage either — so the owner
   * (the bureau) must call this on teardown to release the SQLite/LMDB handle.
   * `undefined` when the caller supplied their own `persistence` (we did not
   * resolve a backend and do not own its lifecycle).
   */
  disposeStorage: (() => void) | undefined;
  /**
   * The resolved durable `Storage` backend itself, when one exists.
   *
   * Distinct from `kv`, which is a `ConditionalTextValueStore` *view* over
   * this same backend: a `Mailbox` needs the raw `Storage` because it
   * commits its own state transitions through `conditionalBatch`, which
   * the text-value view does not expose. Distinct from `disposeStorage`,
   * which closes the handle without lending it out.
   *
   * `undefined` when no persistent backend resolved — the caller is then
   * genuinely non-durable and must not pretend otherwise.
   *
   * Lifecycle stays with this composition: a borrower uses the handle and
   * never disposes it, because `disposeStorage` above is what owns that.
   */
  durableStorage: Storage | undefined;
  memory: Memory | undefined;
  sessionStore: SessionStore | undefined;
  scheduler: Scheduler | undefined;
  /**
   * The bureau's canonical toolbox (`options.toolbox`, or an internally
   * created one). `resolveReview` calls `resumeApproval()` on this instance to
   * resume a signed pending tool approval — `resumeApproval` re-invokes the
   * tool by name/callId, so any toolbox sharing the original `approvalSecret`
   * and tool set can resume it, not only the specific per-run `.extend()` clone
   * that produced the pending approval.
   */
  baseToolbox: BureauToolbox;
  setRequestAuthorityValidator(
    validator: ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
  ): void;
  /**
   * AB-240: wired by `createBureau` once its agent catalog exists, so boot
   * recovery can resolve a catalog-dispatched run's deps through the
   * catalog agent's OWN `OPERATIVE_RESOLVE_RUN_OPTIONS` rather than the
   * Bureau's default runtime composition.
   */
  setCatalogAgentRunOptionsResolver(resolver: CatalogAgentRunOptionsResolver | undefined): void;
  /**
   * Persist the catalog-run recovery record `resolveRunServices` consults
   * on the next boot. Called from `bureau.run()`'s durable dispatch branch
   * before the durable engine starts. A no-op when this composition has no
   * durable storage.
   */
  persistCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<void>;
  /**
   * Whether `runId` has a persisted catalog-run recovery record — used by
   * `createBureau`'s boot-recovery classification to route a catalog run to
   * a headless monitor instead of the session-ownership classification.
   */
  isCatalogRecoveredRun(runId: string): Promise<boolean>;
  /**
   * AB-241 review finding: the combined catalog-run classification AND
   * attribution read `createBureau`'s `onRecoveredWorkflow` uses, backed by
   * exactly ONE `loadCatalogRunRecoveryRecord` call — deliberately NOT two
   * separate calls (one to `isCatalogRecoveredRun`, one to a
   * would-be `getCatalogRunAttribution`), because a transient storage read
   * failure on a SECOND, independent read could then classify a workflow as
   * catalog territory (the first read succeeded) while losing its
   * attribution (the second read hit the transient failure) — silently
   * demoting an attributed run to unattributed for the rest of this
   * process's lifetime, since `eventHistory`'s principal gate fails closed
   * on an absent `runAttribution` entry. `isCatalogRun` is `true` for
   * `'read-error'` as well as `'found'` (matching `isCatalogRecoveredRun`'s
   * own read-error handling), so a corrupt (not absent) record still routes
   * to the headless catalog monitor rather than falling through to the
   * session-ownership classification; `attribution` is populated only for
   * `'found'`, since a corrupt record has nothing decoded to offer.
   */
  classifyCatalogRecoveredRun(runId: string): Promise<{
    isCatalogRun: boolean;
    attribution?: { agentName: string; principal?: string };
  }>;
  /**
   * AB-241 review finding: releases every entry `catalogRunRecoveryCache`
   * accumulated during the current boot recovery pass. `createBureau`'s
   * `recoverDurableRuns` calls this exactly once, after its post-recovery
   * loop (the last consumer of the cache) has finished — see the cache's
   * own doc comment for why entries are retained rather than evicted
   * per-read.
   */
  clearCatalogRunRecoveryCache(): void;
  ready: boolean;
  provider: RedactedProviderConfiguration | undefined;
  providers: RedactedProviderRouteConfiguration[];
  maximumSteps: number;
  systemPrompt: string | undefined;
  getToolSummaries(): ToolSummary[];
  createRunRuntime(
    request: CreateRunRequest & { sessionId: string; runId?: string },
    options?: {
      liveStreaming?: boolean;
      /**
       * The pre-crash active set, as provenance-carrying activation records.
       *
       * Recovery re-validates these against the live catalog and re-checks each digest, so a skill
       * whose source was revoked or whose content drifted while the run was away does not come
       * back under a name somebody once reviewed.
       */
      initialActiveSkillRecords?: ReadonlyArray<SkillActivationRecord> | undefined;
    },
  ): Promise<{
    generate: GenerateFunction;
    toolbox: AnyToolbox;
    /**
     * The run's hook plan (COR-567). Bureau's own hooks were seven pushes into
     * three legacy arrays until this became a registry; they are registered
     * here, under stable ids, in the order those arrays ran.
     *
     * A registry rather than arrays because `RunOptions.hooks` is the only
     * hook surface that carries registration identity, priority and plan
     * observation — and bureau composing one is what makes those real for a
     * production run instead of a capability nothing reaches.
     */
    hooks: HookRegistry<OperativeHookMap>;
    streamEventTarget: TypedEventTarget<StreamEventMap> | undefined;
    getActiveSkillRecords: () => readonly SkillActivationRecord[];
  }>;
  /**
   * AB-260 — folded onto this interface directly rather than reached through
   * the retired `RuntimeCompositionTestingSeams` WeakMap: this is Weft's
   * literal `resolveWorkflowServices` resolver, already wired into
   * `durable.engine` at construction whenever one is composed (production
   * invokes it automatically on every recovered run) — a genuine capability
   * of this returned object, not a test-only backdoor, so every caller (test
   * or production) reaches it the same way. Callable even without a durable
   * engine composed — it resolves `{ status: 'unavailable' }` for every
   * input in that case, matching what an uncomposed resolver would report.
   */
  resolveRunServices(info: WorkflowServicesResolverInfo): Promise<WorkflowServicesResolution>;
  /**
   * AB-260 — folded onto this interface directly for the same reason as
   * {@link RuntimeComposition.resolveRunServices}: the native-scheduled-fire
   * branch of that same resolver, callable standalone for a caller (test or
   * production) that already holds a `SessionStore` and wants to build a
   * scheduled fire's deps without going through the full resolver dispatch.
   */
  buildScheduledRunServices(
    info: WorkflowServicesResolverInfo,
    store: SessionStore,
    recoveredScheduleMarker?: RecoveredScheduleMarker,
  ): Promise<WorkflowServicesResolution>;
  /**
   * AB-260 — folded onto this interface directly for the same reason as
   * {@link RuntimeComposition.resolveRunServices}: reconstructs the
   * committed active-skill snapshot for a scheduled fire under recovery,
   * genuinely invoked by `buildScheduledRunServices` in production, not a
   * test-only introspection hook.
   */
  loadCommittedScheduledActiveSkills(
    session: Awaited<ReturnType<SessionStore['load']>> | undefined,
    runId: string,
    recovering: boolean,
  ): Promise<SkillActivationRecord[] | undefined>;
  /**
   * COR-1265 criterion 3b — a fresh registry holding only the Bureau invariants
   * that close over nothing run-specific, for a dispatch path that resolves its
   * run options through a catalog agent rather than through
   * {@link RuntimeComposition.createRunRuntime}. Merged as the first tier so
   * Bureau's policy still applies to those runs.
   */
  createBureauInvariantHooks(): HookRegistry<OperativeHookMap>;
}

/**
 * `createRuntimeComposition` builds bureau-level generate/toolbox/
 * persistence/durability composition — entirely orthogonal to the typed
 * `agents` catalog (AB-22), which `createBureau` wires separately. Omitting
 * `agents` here means every existing caller (including the 100+ direct
 * `createRuntimeComposition({...})` calls in this package's own test suite)
 * keeps working unchanged; it is not part of this function's contract.
 */
/**
 * Priority pinning a Bureau registration behind every other tier's entries on
 * the same hook point (COR-1265, criteria 9 and 10).
 *
 * Two dispatch shapes let a later handler decide the outcome: `runLast`
 * returns the last defined result, and the waterfall feeds each handler the
 * previous one's return value. On both, "runs last" means "wins", so a Bureau
 * registration that narrows — today `bureau:guardrails-validate-response` — has
 * to sort behind whatever an agent or a direct caller registered. The trailing
 * `onStep` hooks take the same value for the ordering reason rather than the
 * authority one: they persist the session once the step's mutations settle, and
 * an agent-tier `onStep` handler is one of those mutations.
 *
 * The tier band works against Bureau here. `mergeHookRegistries` offsets each
 * participant by `(participants - 1 - index) * 1000` and Bureau is always the
 * first participant, so it receives the LARGEST offset — `+2000` with the three
 * tiers a composition can reach. The constant sits that far above
 * `Number.MIN_SAFE_INTEGER` so adding the offset back cannot leave the
 * safe-integer range, and so a merged Bureau entry still lands below anything
 * registered at a priority a caller would plausibly write.
 *
 * The residual, stated rather than implied: a lower tier that deliberately
 * registers at or below `Number.MIN_SAFE_INTEGER + 2000` sorts after this
 * anyway. No finite constant closes that, because a priority is a plain number
 * with no floor, and `-Infinity` closes it only until a second entry carries it
 * — the registry's `b.priority - a.priority` comparator would then return
 * `NaN`. A tier deliberately reaching for the bottom of the number line is not
 * the threat this is defending against; an ordinary registration that happens
 * to outrank Bureau is.
 */
const BUREAU_PINNED_LAST_PRIORITY = Number.MIN_SAFE_INTEGER + 2000;

/**
 * The ownership tier every registration Bureau makes belongs to (COR-1265) —
 * set once on a registry, stamped by `on()` onto each entry so it survives
 * `mergeHookRegistries`.
 */
export const BUREAU_HOOK_TIER = 'bureau';

/**
 * Registers the identity invariant. Shared by the per-run composition and by
 * {@link RuntimeComposition.createBureauInvariantHooks}, which is the whole
 * reason it is a function: the two register at different points in their own
 * registries and must not drift into two different registrations.
 */
function registerIdentityInvariant(
  registry: HookRegistry<OperativeHookMap>,
  identity: NonNullable<RuntimeCompositionOptions['identity']>,
): void {
  registry.on('prepareStep', createIdentityHook(identity), {
    id: 'bureau:identity',
    // Appends a system message to the step's conversation and touches nothing
    // outside it; a replayed step rebuilds that conversation from persisted
    // history, so re-running this reproduces state rather than repeating an
    // external effect.
    replay: 'safe',
  });
}

/**
 * Registers both guardrail invariants, in the order the legacy arrays ran them.
 *
 * The caller decides WHEN — the per-run composition registers `prepareStep`
 * last of all its `prepareStep` hooks on purpose, so the input guardrail scans a
 * step context every earlier hook has already contributed to.
 */
function registerGuardrailInvariants(
  registry: HookRegistry<OperativeHookMap>,
  guardrails: GuardrailHooks,
): void {
  registry.on('prepareStep', guardrails.prepareStep, {
    id: 'bureau:guardrails-prepare-step',
    // Scans and may taint in-process session state; no external write.
    replay: 'safe',
  });
  registry.on('validateResponse', guardrails.validateResponse, {
    id: 'bureau:guardrails-validate-response',
    // COR-1265 criterion 10. `validateResponse` is dispatched as a waterfall,
    // so the LAST handler to answer hands its response to the run — an agent-
    // or direct-tier handler running after this one would decide what the
    // guardrail's narrowing was worth. Pinned last so it does not.
    priority: BUREAU_PINNED_LAST_PRIORITY,
    replay: 'safe',
  });
}

/**
 * Priority placing a hook after every hook bureau's own composition registered.
 *
 * The same value as {@link BUREAU_PINNED_LAST_PRIORITY}, and deliberately not a
 * separate band: COR-1265's criterion 9 makes the two trailing hooks outrank
 * every tier's `onStep` handlers, not merely Bureau's own, and a value chosen
 * relative to Bureau's default `0` could not do that once a second tier exists.
 */
const TRAILING_HOOK_PRIORITY = BUREAU_PINNED_LAST_PRIORITY;

/**
 * Registers a per-call `onStep` hook that must run AFTER the run runtime's own
 * — the session write-back on a scheduled fire, the pending-approval persist on
 * an interactive run. Both were array spreads (`[...runRuntime.onStep, extra]`)
 * whose ordering came from their position in the literal; the priority states
 * it instead, so it survives the hook moving.
 *
 * This mutates the run's registry and returns it, rather than merging into a
 * fresh one, because the registry is created per run inside `createRunRuntime`
 * and the caller here owns that run outright.
 *
 * COR-1265: every caller now merges the result before handing it to a run, so
 * the completed Bureau tier is what becomes `mergeHookRegistries`' first
 * argument. That ordering is the point — registering here AFTER the merge would
 * put the trailing hook in the merged registry at its raw priority while every
 * other Bureau entry had already been offset, which is precisely the renumbering
 * this function used to avoid by refusing to merge at all.
 */
export function registerTrailingOnStep(
  hooks: HookRegistry<OperativeHookMap>,
  id: string,
  handler: OnStepHook,
): HookRegistry<OperativeHookMap> {
  hooks.on('onStep', handler, {
    id,
    priority: TRAILING_HOOK_PRIORITY,
    // Writes a session record.
    replay: 'effectful',
  });
  return hooks;
}

export type RuntimeCompositionOptions = Omit<BureauOptions, 'agents'>;

export async function createRuntimeComposition(
  options: RuntimeCompositionOptions,
  dependencies: RuntimeCompositionDependencies = defaultRuntimeCompositionDependencies,
): Promise<RuntimeComposition> {
  const maximumSteps = options.maximumSteps ?? DEFAULT_MAXIMUM_STEPS;
  const systemPrompt = options.systemPrompt;
  const diagnose = resolveDiagnosticSink(options.onDiagnostic);
  // AB-260: `createBureau` resolves and forwards its own single
  // `RuntimeServices` instance through `options.runtime` before calling this
  // function, so this resolution just picks that SAME instance back up. A
  // direct caller of this exported function (bypassing `createBureau`
  // entirely — this package's own extensive test suite does exactly that)
  // gets the real-globals default, identical to this composition's behavior
  // before `RuntimeServices` existed.
  const runtimeServices: RuntimeServices = options.runtime ?? createDefaultRuntimeServices();

  // Gate the resolver until the whole composition is assembled. In automatic
  // mode `createRunEngine` starts its scheduler before later consts (`sessionStore`,
  // the `createRunRuntime` closure deps) are initialized, so a persisted schedule
  // could fire `resolveRunServices` mid-build and hit a not-yet-initialized binding.
  // This flag lets the resolver bail out cleanly until composition is ready. Manual
  // mode has no background poller, but shares the same gate for consistency.
  let compositionReady = false;
  let requestAuthorityValidator = options.requestAuthorityValidator;
  // AB-240: wired by `createBureau` once its agent catalog exists (this
  // function's own contract deliberately excludes `agents` — see
  // `RuntimeCompositionOptions`'s doc comment) — `undefined` until then, and
  // for any direct `createRuntimeComposition` caller that never wires one.
  let catalogAgentRunOptionsResolver: CatalogAgentRunOptionsResolver | undefined;

  // AB-10: run ids the durable engine flags as version-mismatched during boot
  // recovery — see RuntimeComposition.workflowVersionMismatches.
  const workflowVersionMismatches = new Map<
    string,
    { storedVersion: string; registeredVersion: string }
  >();

  // AB-223: runId → scheduleId for a scheduled fire whose deps this composition
  // has built (live tick or recovered), so the `workflow:completed`/
  // `workflow:failed` engine listener wired below `createRunEngine` can
  // correlate a terminal event back to its owning schedule. Populated in
  // `buildScheduledRunServices`; each entry is deleted the instant its
  // terminal event dispatches, so it never grows past the count of in-flight
  // scheduled fires.
  const scheduledFireScheduleIds = new Map<string, string>();

  // AB-241 review finding: runId → the decoded `CatalogRunRecoveryRecord`
  // `resolveRunServices`'s catalog branch already successfully read during
  // boot recovery, cached here so BOTH `classifyCatalogRecoveredRun` (called
  // from the awaited `onRecoveredWorkflow` hook, during `recoverAll()`) and
  // `isCatalogRecoveredRun` (called again, LATER, from
  // `recoverDurableRuns`'s own post-recovery loop over `recoverAll()`'s
  // returned handles) can reuse that SAME decode instead of each issuing
  // its own independent storage read — a transient failure on either read
  // could disagree with the first, either losing an already-attributed
  // run's attribution or, worse, misclassifying an already-resolved
  // catalog run as an orphan and cancelling it. Entries are intentionally
  // NOT evicted per-read (a second fresh review finding after an earlier,
  // wrong per-entry-eviction attempt starved the later of these two
  // consumers) — the whole cache is cleared in one call, once, at the end
  // of the boot recovery pass (`clearCatalogRunRecoveryCache`, called from
  // `recoverDurableRuns` in create-bureau.ts), so it never persists past
  // that one pass — unlike `runAttribution`, this is not live-dispatch
  // state.
  const catalogRunRecoveryCache = new Map<string, CatalogRunRecoveryRecord>();
  const scheduleFireEvents = new TypedEventTarget<ScheduleFireEventMap>();
  const skillEvents = new TypedEventTarget<SkillEventMap>();

  // Resolve the `persistence` option into its components. The three forms are:
  // - PersistenceOptions { store, history?, observability?, onLog? }
  // - Bare StorageConfiguration (shorthand for { store: config })
  // - ConditionalTextValueStore (KV-only, no durable engine)
  // The legacy `storage` field is still accepted alongside the new forms.
  const {
    storageConfig: persistenceStorageConfig,
    kvStore: persistenceKvStore,
    persistenceHistory,
    persistenceObservability,
    persistenceOnLog,
  } = resolvePersistenceOptions(options);

  // Prefer the `persistence` form over the top-level storage field. A caller may
  // inject a raw adapter (notably Cloudflare Durable Object SQLite) because it
  // cannot be represented by Weft's built-in StorageConfiguration union.
  const effectiveStorage = persistenceStorageConfig ?? options.storage;

  let kv: ConditionalTextValueStore | undefined = persistenceKvStore;
  // Keep the raw Storage so the durable engine can share the exact backend with
  // the text-value KV view (Weft requires one engine per durable store).
  let durableStorage: Storage | undefined;
  let ownsDurableStorage = false;
  if (!kv && effectiveStorage) {
    if (isStorageConfiguration(effectiveStorage)) {
      durableStorage = await resolveStorage(effectiveStorage);
      ownsDurableStorage = true;
    } else {
      durableStorage = effectiveStorage;
    }
    kv = textValueStore(durableStorage, { disposeUnderlyingStorage: false });
  }

  // Merge operational knobs from the PersistenceOptions form with the legacy
  // top-level fields. PersistenceOptions takes precedence when both are set.
  const effectiveObservability = persistenceObservability ?? options.observability;
  const effectiveOnLog = persistenceOnLog ?? options.onLog;

  // Durable execution is ON BY DEFAULT whenever a PERSISTENT storage backend is
  // configured AND no custom KV-only `persistence` (ConditionalTextValueStore) shadows it.
  // The default follows persistence because that is the only place resume is real:
  // `memory` storage loses its checkpoints with the process, so default-on there
  // would be pure overhead with zero recovery. The explicit `durableExecution`
  // flag overrides the default either way.
  const hasKvOnlyPersistence = persistenceKvStore !== undefined;
  let effectiveStorageIsPersistent = false;
  if (effectiveStorage) {
    if (isStorageConfiguration(effectiveStorage)) {
      effectiveStorageIsPersistent = effectiveStorage.type !== 'memory';
    } else {
      const persistence = effectiveStorage.capabilities().persistence;
      effectiveStorageIsPersistent = persistence === 'local' || persistence === 'remote';
    }
  }
  const wantsDurable =
    options.durableExecution ?? (effectiveStorageIsPersistent && !hasKvOnlyPersistence);

  // A KV-only `persistence` (ConditionalTextValueStore) value means no raw `Storage` was
  // resolved and a durable engine cannot be built. Fail loud if `durableExecution:
  // true` is requested — honor it silently and we ship an engine that looks
  // durable but can't recover. (Flag UNSET + ConditionalTextValueStore is the documented
  // KV-only path — sessions only, no durability.)
  if (options.durableExecution === true && hasKvOnlyPersistence) {
    throw new Error(
      'durableExecution: true is incompatible with a ConditionalTextValueStore `persistence` value. ' +
        'A durable engine must share its backend with the session store, but ' +
        'a ConditionalTextValueStore cannot back a Weft engine. Provide `persistence` as a ' +
        'StorageConfiguration or PersistenceOptions to get durable execution, ' +
        'or drop `durableExecution: true` to use the KV-only persistence layer ' +
        'with the in-memory run loop.',
    );
  }

  let durable: DurableComposition | undefined;
  if (wantsDurable && durableStorage) {
    // Build the checkpoint store over the SAME backend the engine persists to.
    const checkpointStore = createCheckpointStore(
      textValueStore(durableStorage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow = createRunWorkflow(checkpointStore, { version: options.workflowVersion });
    // recover: false is REQUIRED. Weft's `Engine.create` default is recover:true,
    // which runs recoverAll() *during construction* — but the bureau needs the
    // recovered handles itself (to attach the `settleRecoveredRun` monitors that
    // persist each resumed run's terminal session status), and a handle started
    // inside Engine.create is not surfaced to the caller. So the bureau owns
    // recovery: it calls engine.recoverAll() at boot and keeps the handles. The
    // per-run deps a recovered run needs are re-provided lazily by
    // `resolveRunServices` (passed as resolveWorkflowServices), which Weft fires
    // per recovered run before its generator advances — no pre-injection, no
    // module-global registry.
    //
    // In the default automatic profile, `startScheduler: true` is REQUIRED too:
    // recover:false decouples *who drives recovery* from *whether timers fire*,
    // and the poller otherwise follows recover. In manual mode the serverless
    // host drives timers through `Bureau.runDurableMaintenance()`, so Weft
    // requires the in-process scheduler to remain stopped.
    durable = await createRunEngine({
      storage: durableStorage,
      runWorkflow,
      checkpointStore,
      recover: false,
      backgroundTasks: options.durableBackgroundTasks ?? 'automatic',
      startScheduler: options.durableBackgroundTasks !== 'manual',
      resolveWorkflowServices: resolveRunServices,
      ...(effectiveObservability !== undefined ? { observability: effectiveObservability } : {}),
      ...(effectiveOnLog ? { onLog: effectiveOnLog } : {}),
      // durableGuardrails is a Pick of these exact CreateRunEngineOptions fields, so
      // it spreads straight through; createRunEngine guards each one internally, so
      // passing `undefined` members is harmless.
      ...options.durableGuardrails,
      // durableOwnership (AB-178) is the same Pick pattern — createRunEngine
      // defaults `ownership` to 'none' when this is omitted entirely.
      ...options.durableOwnership,
      // history from PersistenceOptions takes precedence over durableGuardrails.history
      ...(persistenceHistory !== undefined ? { history: persistenceHistory } : {}),
      runWorkflowVersion: options.workflowVersion,
      // AB-10: record the mismatch so the boot recovery loop below can pass it
      // to `classifyRecoveredRun` (distinct 'reattach-version-mismatch' verdict)
      // before it inspects `workflowVersionMismatches`.
      onWorkflowVersionMismatch: (event: WorkflowVersionMismatchEvent) => {
        workflowVersionMismatches.set(event.runId, {
          storedVersion: event.storedVersion,
          registeredVersion: event.registeredVersion,
        });
        diagnose({
          level: 'warn',
          scope: 'recovery',
          message:
            `[bureau] Recovered run "${event.runId}" was checkpointed under workflow version ` +
            `"${event.storedVersion}" but is resuming under "${event.registeredVersion}". ` +
            `Recovery proceeds against the currently-deployed code (pin-and-warn) — see ` +
            `documentation/workflow-versioning.md.`,
        });
      },
    });

    // AB-223: schedule-fire terminal events. `workflow:completed`/
    // `workflow:failed` fire on the engine for EVERY workflow (scheduled or
    // not) — a live tick and a recovered fire both settle through this same
    // pair, so listening here (rather than duplicating from
    // `monitorRecoveredScheduledFire`'s recovery-only await) gives exactly one
    // dispatch per fire regardless of how it settled. A run with no entry in
    // `scheduledFireScheduleIds` (every ordinary, non-scheduled run) is
    // silently ignored — `return` before either handler does anything else.
    durable.engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      const result = event.result;
      const finishReason =
        typeof result === 'object' && result !== null && 'finishReason' in result
          ? result.finishReason
          : undefined;
      // Two branches, each dispatching its own concrete event type, rather
      // than one `dispatch(cond ? new A() : new B())` call: TypedEventTarget's
      // `dispatch<K>` infers `K` from its argument's `type` literal, and a
      // ternary's union argument defeats that inference (the argument's
      // static `type` widens to `string`) — using the typed `dispatch` wrapper
      // (not the untyped inherited `dispatchEvent`) needs single-type call
      // sites.
      if (isRunFailureFinishReason(finishReason)) {
        scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
      } else {
        scheduleFireEvents.dispatch(new ScheduleCompletedEvent(scheduleId, event.workflowId));
      }
    });
    durable.engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
    });
    // Not a fire-terminal dispatch (cancellation is out of this issue's scope),
    // but the correlation entry must still be dropped on a cancelled fire, or
    // it leaks for the lifetime of the engine.
    durable.engine.addEventListener(WorkflowCancelledEvent.type, (event) => {
      scheduledFireScheduleIds.delete(event.workflowId);
    });

    // COR-660: the tick observation point Weft's COR-105 exposes. Unlike the
    // terminal pair above, these arrive already keyed by scheduleId, so there
    // is no `scheduledFireScheduleIds` correlation to do and nothing to
    // filter: every schedule on this engine is one the bureau created
    // (`createSchedule`, `createAgentScheduler`, or a durable heartbeat), the
    // engine being bureau-owned. A tick that collides emits `attempted` then
    // `skipped`; a tick that launches emits `attempted` and later one of the
    // terminal pair.
    durable.engine.addEventListener('schedule:attempted', (event) => {
      scheduleFireEvents.dispatch(new ScheduleAttemptedEvent(event.scheduleId, event.occurrence));
    });
    durable.engine.addEventListener('schedule:skipped', (event) => {
      scheduleFireEvents.dispatch(
        new ScheduleSkippedEvent(
          event.scheduleId,
          event.policy,
          event.occurrence,
          // A scheduled fire's Weft workflow id IS its AgentRun id — the same
          // identity `ScheduleFailedEvent`/`ScheduleCompletedEvent` carry as
          // `runId` from `event.workflowId`.
          event.blockingWorkflowId,
        ),
      );
    });
  }

  let memory: Memory | undefined;
  if (options.memory) {
    memory = isMemoryInstance(options.memory) ? options.memory : createMemory(options.memory);
    await memory.init();
  }

  // A run's skills come from a catalog revision, and only from one. COR-892 removed Bureau's
  // second path — a provider it read skills out of directly — because a skill admitted that way
  // had no trust decision, no artifact digest and no compatibility verdict, so a run holding one
  // could not say where it came from.
  //
  // A caller that has already discovered a revision hands it in, which is the host's job under
  // COR-752's Decision 1: discovery reads approved filesystem roots and remote URLs, and deciding
  // which of those to trust is not Bureau's call to make. A caller that has only configured
  // persistence gets the skills its own store holds, discovered here through the `storage` source.
  // That is the one source Bureau can compose without deciding anything on the host's behalf: the
  // store is already the bureau's, and what is in it is what this runtime itself put there.
  const skillCatalog: SkillCatalogRevision | undefined =
    options.skills === undefined
      ? undefined
      : (options.skills.catalog ??
        (kv === undefined
          ? undefined
          : await discoverSkills({
              sources: [
                {
                  id: 'storage',
                  kind: 'storage',
                  // Not a filesystem path and deliberately not credential-bearing: a catalog entry
                  // exposes this verbatim.
                  location: 'kv://skills',
                  precedence: DEFAULT_SOURCE_PRECEDENCE.storage,
                },
              ],
              storage: kv,
            })));

  // AB-384 (Codex P2 review finding, PR #592, "Mint incarnations from the
  // Bureau's injected runtime"): `runtimeServices` (resolved above from
  // `options.runtime`, defaulting to the real globals) must be threaded
  // through here — omitting it would let `createSessionStore` silently
  // construct its OWN second default `RuntimeServices`, so every
  // `AgentSession.incarnation` it mints would come from real
  // `crypto.randomUUID()`/wall-clock time instead of the same injected
  // runtime every other subsystem this composition builds already uses,
  // breaking determinism for manual-runtime tests and fault-replay runs.
  const sessionStore = kv
    ? (dependencies.createSessionStore ?? createSessionStore)(kv, { runtime: runtimeServices })
    : undefined;
  const baseToolbox: BureauToolbox = options.toolbox ?? createToolbox([], { context: {} });
  const hasSkillTools = options.skills !== undefined && options.skills.includeTools !== false;
  const fallbackToolbox: BureauToolbox =
    options.toolbox !== undefined || hasSkillTools ? baseToolbox : createUnavailableToolbox();

  const baseProviders =
    options.providers ??
    (options.provider
      ? [
          {
            name: 'default',
            provider: options.provider,
          },
        ]
      : []);
  const routingStrategy =
    options.routing && baseProviders.length > 1
      ? createRoutingStrategy(options.routing)
      : undefined;

  const skillToolSummaries: ToolSummary[] =
    options.skills?.includeTools === false
      ? []
      : options.skills
        ? [
            {
              name: 'activate_skill',
              description:
                'Activate a skill by name. Returns the skill instructions and available resources.',
            },
            {
              name: 'load_skill_resource',
              description: 'Load a resource file from an active skill.',
            },
            {
              name: 'deactivate_skill',
              description: 'Deactivate a skill and remove it from the active set.',
            },
            {
              name: 'list_skills',
              description: 'List available skills and whether they are active.',
            },
          ]
        : [];

  function getToolSummaries(): ToolSummary[] {
    const toolInspections = baseToolbox.inspect('summary').tools;
    return [
      ...toolInspections.map((toolInspection) => ({
        name: toolInspection.name,
        description: toolInspection.description,
      })),
      ...skillToolSummaries,
    ];
  }

  function composeConfiguredGenerate(
    streamEventTarget: TypedEventTarget<StreamEventMap> | undefined,
  ): GenerateFunction | undefined {
    let generate: GenerateFunction | undefined = options.generate;

    if (!generate) {
      if (baseProviders.length === 0) {
        return undefined;
      }

      if (routingStrategy && baseProviders.length > 1) {
        const routes = baseProviders.map((route) => ({
          name: route.name,
          generate: dependencies.resolveProviderGenerate(
            route.provider,
            streamEventTarget,
            options.streaming,
          ),
        }));

        const routingGenerate = createRoutingGenerate({
          routes,
          fallback: routes[0]!.name,
          strategy: routingStrategy.strategy,
        });

        generate =
          routingStrategy.kind === 'cost-aware'
            ? withUsageTracking(routingGenerate, routingStrategy.onUsage)
            : routingGenerate;
      } else if (baseProviders.length > 1) {
        generate = createFalloverGenerate({
          providers: baseProviders.map((route) => ({
            name: route.name,
            generate: dependencies.resolveProviderGenerate(
              route.provider,
              streamEventTarget,
              options.streaming,
            ),
          })),
        });
      } else {
        generate = dependencies.resolveProviderGenerate(
          baseProviders[0]!.provider,
          streamEventTarget,
          options.streaming,
        );
      }
    }

    return applyCache(generate, options.cache, kv);
  }

  const nonStreamingGenerate = composeConfiguredGenerate(undefined);
  const schedulerGenerate = nonStreamingGenerate;

  const scheduler =
    schedulerGenerate && options.scheduler?.enabled === true
      ? createScheduler({
          generate: schedulerGenerate,
          toolbox: fallbackToolbox,
          idleDelay: options.scheduler?.idleDelay ?? 1000,
          // When a durable engine is composed, preemptable scheduler tasks run as
          // durable workflows and a preemption SUSPENDS the run (preserving its
          // checkpoint) rather than aborting it — a requeue resumes from the last
          // completed step. Without an engine the scheduler stays in-memory.
          ...(durable
            ? { durable: { engine: durable.engine, checkpointStore: durable.checkpointStore } }
            : {}),
        })
      : undefined;

  if (scheduler) {
    scheduler.start();
  }

  /**
   * The guardrail configuration in force for this composition, with `false`
   * narrowed away so a caller sees a real configuration or nothing.
   *
   * AB-40 — `undefined` (not configured) wires the enabled-by-default preset;
   * `false` opts out entirely; anything else replaces the preset. A pure
   * function of `options`, hoisted to composition scope because
   * {@link createBureauInvariantHooks} needs the same answer for a run that
   * never goes through `createRunRuntime` at all.
   */
  function resolveGuardrailsConfiguration(): GuardrailsOptions | undefined {
    const resolved =
      options.guardrails === undefined ? defaultGuardrailsPreset() : options.guardrails;
    return resolved === false ? undefined : resolved;
  }

  /**
   * The Bureau invariants that do not close over a run (COR-1265 criterion 3b,
   * owner ruling 2026-09-20).
   *
   * A catalog-dispatched run resolves its provider, toolbox, memory and skills
   * through the catalog agent's OWN `OPERATIVE_RESOLVE_RUN_OPTIONS`, never
   * through `createRunRuntime` — that separation is AB-240's point and its
   * rollback trigger. Bureau's hooks were absent from those runs entirely, which
   * was survivable only while no tier reached them at all; once the agent tier
   * became real, a catalog run would carry its agent's hooks and none of
   * Bureau's policy, which contradicts COR-567's non-bypassable invariants.
   *
   * The whole Bureau tier cannot travel there. `bureau:memory-recall`,
   * `bureau:memory-persist`, the skill hooks and `bureau:skill-record-snapshot`
   * close over this run's session, memory and skill session, and a catalog run
   * has none of them. The three that close over composition-level configuration
   * only — the identity prompt and both guardrails — do, and they are exactly
   * the registrations COR-567's "non-bypassable Bureau invariant hooks" section
   * names.
   *
   * A fresh registry, and a fresh `createGuardrails`, per call: the guardrail
   * carries per-run taint state, so sharing one across catalog runs would leak
   * one run's detections into another.
   *
   * This does not reach every catalog path. A non-durable dispatch of a catalog
   * agent that exposes no `OPERATIVE_RESOLVE_RUN_OPTIONS` goes straight to
   * `agent.run()` with no `RunOptions` for anyone to augment; there is no seam
   * short of a caller-facing hook field, which COR-567 Decision 4 declines. See
   * `documentation/hierarchical-hook-composition.md`.
   */
  function createBureauInvariantHooks(): HookRegistry<OperativeHookMap> {
    const invariants = new HookRegistry<OperativeHookMap>({ source: BUREAU_HOOK_TIER });
    if (options.identity) {
      registerIdentityInvariant(invariants, options.identity);
    }
    const guardrailsConfig = resolveGuardrailsConfiguration();
    if (guardrailsConfig) {
      registerGuardrailInvariants(invariants, createGuardrails(guardrailsConfig));
    }
    return invariants;
  }

  function createRunRuntime(
    request: CreateRunRequest & { sessionId: string; runId?: string },
    runtimeOptions?: {
      liveStreaming?: boolean;
      /**
       * Active-skill entries to seed the run's {@link SkillSession} with on
       * construction. Used by the durable recovery path: when
       * `buildRunDepsFromSession` rebuilds deps for a recovered run, it reads the
       * `activeSkillRecords` snapshot from session metadata and passes it here so the
       * recovered toolbox is aware of skills activated in completed pre-crash steps
       * (those steps are memoized and do not re-run their `activate_skill` calls).
       */

      /**
       * Provenance-carrying records for the catalog-backed path.
       *
       * Recovery
       * re-validates these against the live catalog and re-checks each digest, so a skill whose
       * source was revoked or whose content drifted does not come back.
       */
      initialActiveSkillRecords?: ReadonlyArray<SkillActivationRecord> | undefined;
    },
  ) {
    const liveStreaming = runtimeOptions?.liveStreaming ?? true;
    const requestContext = request.requestContext;
    // AB-40 — the auto-wired default guardrail preset (`options.guardrails ===
    // undefined`) runs its output PII validator in `mode: 'tripwire'` against
    // the FULL response content in `validateResponse`, which only runs after
    // `runStep`'s generate call returns. `withEnhancedStreaming` forwards
    // `stream:text-delta` events (and finalizes the streaming message) as the
    // provider streams, which happens entirely INSIDE that generate call —
    // before `validateResponse` ever sees the content. A streamed response
    // would therefore leak PII to clients before the default tripwire could
    // fire, defeating the preset's purpose. Force buffered (non-streaming)
    // generation whenever the default preset is in effect so the output
    // guardrail actually gates what reaches the client. A caller who
    // explicitly supplies `guardrails` (including re-supplying this same
    // preset) has opted into managing that tradeoff themselves and keeps
    // streaming.
    const usingDefaultGuardrailsPreset = options.guardrails === undefined;
    const streamEventTarget =
      !liveStreaming ||
      options.generate !== undefined ||
      options.streaming?.enabled === false ||
      usingDefaultGuardrailsPreset
        ? undefined
        : new TypedEventTarget<StreamEventMap>();
    const generate =
      streamEventTarget === undefined
        ? nonStreamingGenerate
        : composeConfiguredGenerate(streamEventTarget);

    if (!generate) {
      throw new Error('No generate function configured');
    }

    // Clone the toolbox for this run so concurrent runs do not share a single
    // CompletableEventTarget emitter. A shared emitter would route every tool.*
    // event (execute-start, settled, …) to ALL runs that have subscribed, causing
    // cross-run event pollution and shared budget/loop-detector state.
    // `extend()` (no args) creates a fresh toolbox with a new emitter while
    // preserving all tool configurations, context, and policy from the original.
    // The unavailable-toolbox sentinel (no user toolbox, no skill tools) is
    // structurally distinct (custom throwing execute) and must be freshly
    // instantiated per-call via createUnavailableToolbox() instead.
    //
    // The skills path below calls combineToolboxes(toolbox, skillToolbox) which
    // always creates a fresh toolbox — so cloning here also means the combined
    // result is based on a per-run clone, which is correct.
    //
    let toolbox: AnyToolbox =
      options.toolbox !== undefined
        ? baseToolbox.extend()
        : hasSkillTools
          ? fallbackToolbox.extend()
          : createUnavailableToolbox();
    // COR-567 — one registry per run. Per-run rather than per-composition
    // because these hooks close over this run's session, memory and skill
    // session; a registry shared across runs would leak one run's state into
    // another exactly the way the per-run toolbox clone above exists to
    // prevent.
    //
    // Registration order is the order the legacy arrays ran in, and every id
    // below is explicit: a generated `<hookName>#<n>` would renumber whenever
    // an earlier conditional block stops registering, so an observer
    // correlating across runs would see the same hook under different names
    // depending on whether memory or skills happened to be configured.
    // COR-1265 — `source` names the owning tier once, and `on()` stamps it onto
    // every entry. On the entry rather than only here because a merged plan has
    // one registry and many tiers: afterwards this object can no longer say
    // where an entry came from, but the entry still can.
    const hooks = new HookRegistry<OperativeHookMap>({ source: BUREAU_HOOK_TIER });
    let getActiveSkillRecords = (): readonly SkillActivationRecord[] => [];
    let getActiveSkillToolPolicy: (() => ToolPolicy | undefined) | undefined;

    if (options.identity) {
      registerIdentityInvariant(hooks, options.identity);
    }

    if (memory) {
      hooks.on('prepareStep', createMemoryRecallHook(memory, request.sessionId), {
        id: 'bureau:memory-recall',
        // Reads memory and injects the result; no external write.
        replay: 'safe',
      });
      hooks.on('onStep', createMemoryPersistHook(memory, request.sessionId, request.runId), {
        id: 'bureau:memory-persist',
        // Writes to the memory store, so a replayed step writes again. The
        // classification records that at-least-once contract; it does not
        // suppress the second write, which would drop the persistence for a
        // step whose generation genuinely re-ran.
        replay: 'effectful',
      });
    }

    // COR-1226 — resolved here rather than at the hook-registration site below,
    // because the skill toolbox needs the same detectors and the same session
    // taint tracker, and it is constructed before that point. `createGuardrails`
    // is a pure function of its options, so calling it earlier changes nothing
    // about what it returns.
    const guardrailsConfig = resolveGuardrailsConfiguration();
    const guardrails = guardrailsConfig ? createGuardrails(guardrailsConfig) : undefined;

    // COR-1226 — skill bodies and skill resources are untrusted instruction
    // input and must pass the same detector pipeline as anything else entering
    // context. `GuardrailHooks.taint`'s own doc comment names skill resources
    // as one of the retrieval surfaces that cannot reach the model through
    // `prepareStep`/`validateResponse` and so must scan directly and fold its
    // detections back into the session-wide taint state. The taint wiring below
    // mirrors `create-guardrails.ts`'s own input-guardrail wiring, including its
    // confidence threshold check.
    const skillGuardrail: SkillGuardrailOptions | undefined =
      guardrails && guardrailsConfig?.input
        ? {
            detectors: guardrailsConfig.input.detectors,
            ...(guardrailsConfig.input.action !== undefined
              ? { action: guardrailsConfig.input.action === 'warn' ? 'warn' : 'block' }
              : {}),
            getSessionTainted: () => guardrails.taint.isTainted(),
            onTriggered: (event) => {
              if (event.confidence >= (guardrailsConfig.taint?.taintThreshold ?? 0.8)) {
                guardrails.taint.taint({
                  reason: event.detail ?? `Detection by ${event.detector}`,
                  detector: event.detector,
                  confidence: event.confidence,
                  step: 0,
                  provenance: event.provenance,
                });
              }
              guardrailsConfig.input?.onTriggered?.(event);
            },
          }
        : undefined;

    let skillRecovery: Promise<unknown> | undefined;
    if (options.skills && skillCatalog !== undefined) {
      // COR-892 — the catalog-backed path. Bureau composes policy and durability *around*
      // Agent-owned behaviour rather than reimplementing it: discovery, trust admission,
      // digest-verified activation and the active set all live in `@lostgradient/skills`, and what
      // Bureau adds here is the run and session correlation the client cannot see, plus durable
      // persistence of what the client decided.
      const skillClient = createSkillClient({
        catalog: skillCatalog,
        // Routed by source kind rather than fixed to the filesystem: a catalog can mix a host's
        // filesystem roots with the bureau's own store, and a `storage` record's `sourceLocation`
        // is a store namespace that no filesystem read can follow.
        loadArtifact: createSkillArtifactLoader(kv === undefined ? {} : { storage: kv }),
        // COR-1226's scan, carried onto the client path. Migrating without it would have created
        // the guardrail bypass COR-892 names: skill bodies are untrusted instruction input and
        // pass the same detector pipeline as anything else entering context.
        ...(skillGuardrail === undefined ? {} : { guardrail: skillGuardrail }),
        ...(skillEvents === undefined ? {} : { events: skillEvents }),
        correlation: {
          ...(request.runId === undefined ? {} : { runId: request.runId }),
          sessionId: request.sessionId,
          ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
        },
      });

      // Recovery before anything else reads the active set: a resumed run must re-validate every
      // stored record against the live catalog and re-check its digest, so a skill whose source
      // was revoked or whose content drifted while the run was away does not come back.
      const recoverable = runtimeOptions?.initialActiveSkillRecords;
      if (recoverable !== undefined && recoverable.length > 0) {
        // Detached deliberately: composition is synchronous, and recovery re-reads bundles. The
        // first step's `prepareStep` awaits the same promise below, so nothing reads a half-filled
        // active set.
        skillRecovery = skillClient.recover(recoverable);
      }

      // The records verbatim, not a name-and-policy projection of them. The projection was what
      // the provider-backed snapshot could carry; narrowing to it here would throw away the
      // provenance every reader of this snapshot now depends on.
      getActiveSkillRecords = () => skillClient.activationRecords();
      getActiveSkillToolPolicy = () => {
        const narrowed = skillClient.narrowedTools();
        return narrowed === undefined ? undefined : { allowList: [...narrowed] };
      };

      if (options.skills.includeTools !== false) {
        const skillToolset = createSkillClientToolbox(
          skillClient,
          skillGuardrail === undefined ? undefined : { guardrail: skillGuardrail },
        );
        // `undefined` when the admitted catalog is empty, so no skill tool is exposed at all —
        // a model handed `activate_skill` against an empty catalog invents a name to pass it.
        if (skillToolset !== undefined) {
          hooks.on(
            'prepareStep',
            (context) => {
              if (context.step !== 0) return Promise.resolve();
              const rendered = renderClientCatalog(skillClient);
              if (rendered !== undefined) {
                context.conversation.appendSystemMessage(rendered, {
                  _skillCatalogInjected: true,
                });
              }
              return Promise.resolve();
            },
            {
              id: 'bureau:skill-client-catalog',
              // Reads the client's frozen catalog revision and appends to the
              // step's conversation; nothing outside it is touched.
              replay: 'safe',
            },
          );

          toolbox = combineToolboxes(
            toolbox,
            createToolbox([
              skillToolset.activateSkill,
              skillToolset.loadSkillResource,
              skillToolset.deactivateSkill,
            ]) as AnyToolbox,
          );
        }
      }

      // Active instructions are re-rendered every step rather than left in the transcript, which
      // is what makes them survive a compaction strategy that rewrote the whole history.
      hooks.on(
        'prepareStep',
        async (context) => {
          // Recovery settles before the first step reads the active set, so nothing renders a
          // half-filled one.
          if (skillRecovery !== undefined) await skillRecovery;
          const instructions = renderActiveSkillInstructions(skillClient.active());
          if (instructions !== undefined) {
            context.conversation.appendSystemMessage(instructions, { _skillContentInjected: true });
          }
        },
        {
          id: 'bureau:skill-client-instructions',
          // Renders the active set into the step's conversation. Re-rendering on
          // a replayed step is the point — see the comment above — and reaches
          // nothing outside that conversation.
          replay: 'safe',
        },
      );

      if (sessionStore) {
        hooks.on(
          'onStep',
          createSkillRecordSnapshotHook(
            skillClient,
            skillCatalog,
            request.sessionId,
            sessionStore,
            request.runId,
          ),
          {
            id: 'bureau:skill-record-snapshot',
            // Writes the activation records to the session store.
            replay: 'effectful',
          },
        );
      }
    }

    // AB-40 — `undefined` (not configured) wires the enabled-by-default
    // preset; `false` opts out entirely; anything else replaces the preset.
    if (guardrails) {
      // Registered last on `prepareStep`, as the array push order had it, so
      // the input guardrail scans a step context every earlier hook has
      // already contributed to rather than one they then append to.
      registerGuardrailInvariants(hooks, guardrails);
    }

    const runToolbox = withDefaultToolboxRequestContext(
      // COR-1228 — narrow by active-skill policy first, then apply the request
      // context. Order matters only for readability here: both are proxies and
      // neither observes the other, but filtering nearest the toolbox keeps the
      // request-context wrapper the outermost thing a caller sees.
      getActiveSkillToolPolicy
        ? withActiveSkillToolPolicy(toolbox, getActiveSkillToolPolicy)
        : toolbox,
      requestContext,
      () => requestAuthorityValidator,
      runtimeServices,
    );
    return Promise.resolve({
      generate,
      toolbox: runToolbox,
      hooks,
      streamEventTarget,
      getActiveSkillRecords,
    });
  }

  /**
   * Rebuild a recovered run's non-serializable {@link DurableRunDeps} from durable
   * config: reconstruct the run runtime from the owning session's persisted
   * request — the same `createRunRuntime` a fresh run uses. Its one caller
   * (`resolveRunServices`, below) already narrows `session` non-null before
   * calling this, so the parameter is typed non-optional rather than
   * defending an absent-session case nothing reaches — AB-260 removed the
   * `null`-returning branch this used to have, which was covered only
   * through the retired `setBuildRunDepsFromSession` override seam.
   *
   * The reconstructed `conversation` is a placeholder: a resumed run reads its
   * transcript from the checkpoint, not from `options.conversation`. Weft's
   * awaited recovery hook attaches the live emitter after these services are
   * rebuilt and before resumed user code advances.
   */
  async function buildRunDepsFromSession(
    session: AgentSession,
    runId?: string,
    agentName?: string,
  ): Promise<DurableRunDeps> {
    const message = session.metadata['lastUserMessage'];
    // Recover the per-request token cap persisted by create-bureau's saveSession
    // call. Without this, recovered generate calls receive maximumTokens:undefined
    // and may produce more output than the original client cap allowed, changing
    // cost and output length after a process crash (PRRT_kwDORvupsc6MZEri).
    const maximumTokensRaw = session.metadata['lastMaximumTokens'];
    const maximumTokens = typeof maximumTokensRaw === 'number' ? maximumTokensRaw : undefined;
    // Restore the per-request step cap from session metadata so a recovered run
    // honours the caller's original maximumSteps rather than the bureau default
    // (PRRT_kwDORvupsc6MZfl5). Falls back to the default `maximumSteps` closure
    // value when the run was created without an explicit cap.
    const maximumStepsRaw = session.metadata['lastMaximumSteps'];
    const recoveredMaximumSteps =
      typeof maximumStepsRaw === 'number' ? maximumStepsRaw : maximumSteps;
    // Rehydrate the active skill set from the last-written snapshot so the
    // recovered toolbox is aware of skills activated in completed pre-crash steps.
    // Completed steps are memoized by Weft and do not re-run their tool executions,
    // so a fresh SkillSession would be unaware of any `activate_skill` calls made
    // before the crash. `activeSkillRecords` is written by createSkillRecordSnapshotHook after
    // each step boundary and is validated here before use (PRRT_kwDORvupsc6MZ1Md).
    const activeSkillRecordsRaw = session.metadata['activeSkillRecords'];
    const initialActiveSkillRecords = isSkillActivationRecordArray(activeSkillRecordsRaw)
      ? activeSkillRecordsRaw
      : undefined;
    const requestContext = recoveredRequestContext(
      session.metadata,
      runId,
      session.id,
      agentName,
      runtimeServices.clock.now,
    );
    const runRuntime = await createRunRuntime(
      {
        message: typeof message === 'string' ? message : '',
        sessionId: session.id,
        // Thread the recovered run's id so the memory-persist hook's idempotency
        // key (`${runId}:${step}`) matches the pre-crash execution — the durable
        // recovery path is exactly where the at-least-once re-fire happens.
        ...(runId !== undefined ? { runId } : {}),
        ...(agentName !== undefined ? { agentName } : {}),
        ...(requestContext ? { requestContext } : {}),
      },
      { liveStreaming: false, initialActiveSkillRecords },
    );

    // AB-336: wire `requestHumanInput`/`scheduleWakeup` in on the RECOVERY
    // path too — see `wireDurableOptInTools`'s own doc comment for the root
    // cause this closes. `servicesRef.current` is assigned to `services`
    // itself, synchronously, below (no `onServices` hook needed here: unlike
    // `createRunFromRequest`'s fresh dispatch, this function already holds
    // the exact object Weft will hand back as `ctx.services` — it's what
    // this function returns).
    let runToolbox: BureauToolbox = runRuntime.toolbox;
    const servicesRef: { current?: DurableRunDeps } = {};
    const wantsHumanInput = options.humanInput === true && runId !== undefined;
    const wantsWakeup = options.wakeup === true && runId !== undefined;
    if (wantsHumanInput || wantsWakeup) {
      runToolbox = wireDurableOptInTools(runRuntime.toolbox, servicesRef, {
        humanInput: wantsHumanInput,
        wakeup: wantsWakeup,
        // `runId` is non-undefined here (both `wantsHumanInput`/`wantsWakeup`
        // require it); `?? ''` only satisfies the type checker.
        runId: runId ?? '',
        ...(wantsHumanInput
          ? {
              // `DurableRunDeps.emitter` isn't assigned until AFTER this
              // function returns — `createRecoveredRunEventSurface` sets it
              // on the SAME `services` object this closure is about to
              // construct and hand back (see `onRecoveredWorkflow` in
              // `create-bureau.ts`). This forwarder reads it lazily, at
              // actual tool-call time, by which point it has settled;
              // `hasDispatchEvent` narrows without a cast, since
              // `DurableRunDeps.emitter`'s own `EventDispatcher` type
              // declares only `dispatch`, not the DOM-style `dispatchEvent`
              // every real emitter (a `CompletableEventTarget`) also has.
              humanInputEmitter: {
                dispatchEvent: (event: Event) => {
                  const target = servicesRef.current?.emitter;
                  return hasDispatchEvent(target) ? target.dispatchEvent(event) : false;
                },
              },
            }
          : {}),
      });
    }

    const services: DurableRunDeps = {
      toolbox: runToolbox,
      getStepMetadata: () => ({
        [activeSkillsStepMetadataKey]: activeSkillsStepMetadata(runRuntime.getActiveSkillRecords()),
      }),
      options: {
        generate: runRuntime.generate,
        toolbox: runToolbox,
        conversation: new Conversation(session.conversationHistory),
        maximumSteps: recoveredMaximumSteps,
        stopWhen: options.stopWhen,
        // COR-1269 — stamped onto this run's hook-plan observations.
        sessionId: session.id,
        // COR-1265 — the completed Bureau tier, snapshotted. A single-tier
        // merge still copies every entry into a fresh registry, so a
        // registration added to `runRuntime.hooks` after this point cannot
        // reach the run that already holds the copy.
        hooks: mergeHookRegistries(runRuntime.hooks),
        // AB-260: the bureau's single composed RuntimeServices instance,
        // snapshotted into every run it starts — including a recovered run
        // rebuilt here from a persisted session.
        runtime: runtimeServices,
        ...(requestContext ? { executeOptions: { requestContext } } : {}),
        // Thread agentName and runId so curated tool.* bubble events stamped by
        // the resumed run carry the same {agentName, runId, step} metadata as the
        // pre-crash run (C3 parity). Without them, recovered runs emit blank ids.
        ...(agentName !== undefined ? { agentName } : {}),
        ...(runId !== undefined ? { runId } : {}),
        // Restore the per-request token cap so recovered steps honour the same
        // maximumTokens constraint as the original run (PRRT_kwDORvupsc6MZEri).
        ...(maximumTokens !== undefined ? { maximumTokens } : {}),
      },
    };
    if (wantsHumanInput || wantsWakeup) {
      servicesRef.current = services;
    }
    return services;
  }

  /**
   * Persist a scheduled run's conversation back to its session after EVERY
   * completed step (last-write-wins, idempotent). This is what makes the
   * recurring-conversation pattern work: fire N+1 loads the session this hook
   * last wrote, so the agent accumulates context across fires. For a
   * fresh-per-fire (stateless cron) session it records the fire's transcript so
   * the run is observable via `getSession`.
   *
   * Persisting on every step (not only `context.final`) is deliberate: a fire that
   * ends on `maximum-steps` — or any other non-`final` terminal outcome — still did
   * real work, but its last `StepResult.final` is `false`, so a final-only hook
   * would silently drop the whole fire from a recurring digest (review: codex
   * Mn69a). A step that throws before completing never reaches this hook, so a
   * step-0 failure (no assistant turn produced) is correctly NOT persisted — we
   * never seed a bare, reply-less user turn that the next fire would build on.
   *
   * Deliberately writes ONLY the conversation (no `lastRunStatus: 'running'`
   * lifecycle metadata): scheduled fires recover through Weft's handle monitor
   * rather than the bureau's interactive session ownership path, so a `running`
   * marker would only race any interactive run sharing the session.
   */
  function createScheduledSessionPersistHook(
    store: SessionStore,
    sessionId: string,
    agentName: string,
    baseConversationHistory: ConversationHistory,
    runId: string,
    replaceCurrentFireTranscript: boolean,
    getActiveSkillRecords: () => readonly SkillActivationRecord[],
  ): OnStepHook {
    return async (context) => {
      await store.update(sessionId, (existing: AgentSession | undefined) => {
        const activeSkillRecords = getActiveSkillRecords();
        const sessionOwnedByAnotherRunningRun =
          existing?.metadata['lastRunStatus'] === 'running' &&
          typeof existing.metadata['lastRunId'] === 'string' &&
          existing.metadata['lastRunId'] !== runId;
        const next =
          existing ??
          createAgentSession({
            id: sessionId,
            agentName,
            conversationHistory: context.conversation.current,
          });
        const existingConversationHistory =
          replaceCurrentFireTranscript && existing
            ? removeLastScheduledFireTranscript(existing.conversationHistory, runId)
            : existing?.conversationHistory;
        return {
          ...next,
          metadata: {
            ...next.metadata,
            lastScheduledFireRunId: runId,
            ...(sessionOwnedByAnotherRunningRun
              ? {}
              : activeSkillSessionMetadataForStep(activeSkillRecords, context.step, runId)),
          },
          conversationHistory: existingConversationHistory
            ? appendConversationMessages(
                existingConversationHistory,
                context.conversation.current,
                baseConversationHistory,
              )
            : context.conversation.current,
        };
      });
    };
  }

  /**
   * AB-240: persist the catalog-run recovery record. Called from
   * `create-bureau.ts`'s `runAgent` durable branch BEFORE `createActiveRun`
   * starts the durable engine, so a crash immediately after start still has,
   * on the next boot, enough to reattach against the catalog agent's own
   * run options — see `resolveRunServices`'s catalog branch below. A no-op
   * when this composition has no durable storage (nothing to reattach
   * across a restart without one, matching the schedule-marker precedent
   * above); the caller only reaches this inside an `if (runtime.durable)`
   * guard, so `durableStorage` is defined whenever it actually matters.
   */
  async function persistCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<void> {
    if (!durableStorage) return;
    const fullRecord: CatalogRunRecoveryRecord = { schemaVersion: 1, ...record };
    await durableStorage.put(catalogRunRecoveryKey(runId), encode(fullRecord));
  }

  type CatalogRunRecoveryLoad =
    | { status: 'found'; record: CatalogRunRecoveryRecord }
    | { status: 'missing' }
    | { status: 'read-error'; error: unknown };

  async function loadCatalogRunRecoveryRecord(runId: string): Promise<CatalogRunRecoveryLoad> {
    if (!durableStorage) return { status: 'missing' };
    try {
      const value = await durableStorage.get(catalogRunRecoveryKey(runId));
      if (!value) return { status: 'missing' };
      const decoded = decode(value);
      return isCatalogRunRecoveryRecord(decoded)
        ? { status: 'found', record: decoded }
        : { status: 'missing' };
    } catch (error) {
      return { status: 'read-error', error };
    }
  }

  /**
   * AB-240: whether `runId` has a persisted catalog-run recovery record —
   * `create-bureau.ts`'s boot-recovery classification uses this to route a
   * catalog-dispatched run to a headless monitor (mirroring a native
   * scheduled fire) instead of the session-ownership classification, which
   * would otherwise treat it as an orphaned run and cancel it (a catalog run
   * deliberately owns no bureau session).
   *
   * True for `'read-error'` as well as `'found'` (review finding): a corrupt
   * record still marks this workflow id as catalog territory. `'missing'`
   * is the only status that means "genuinely not a catalog run" — treating
   * `'read-error'` as `false` would let a merely-corrupt (not absent) record
   * fall through to the session-ownership classification below, which would
   * then cancel the run as an unowned orphan instead of leaving it to the
   * `{ status: 'unavailable', reason: '... unreadable' }` outcome
   * `resolveRunServices`'s catalog branch already produced for it.
   */
  async function isCatalogRecoveredRun(runId: string): Promise<boolean> {
    // AB-241 review finding: consult the cache `resolveRunServices` already
    // populated FIRST — `recoverDurableRuns`'s post-recovery loop calls this
    // for every handle `onRecoveredWorkflow` didn't already register, so a
    // catalog run's classification here must stay consistent with the
    // resolver's own earlier, successful read rather than risk a fresh,
    // independent one transiently disagreeing with it (a `false` from a
    // flaky second read would fall through to session-ownership
    // classification and cancel an already-resolved-and-monitored catalog
    // run as an orphan). See `catalogRunRecoveryCache`'s own doc comment for
    // why entries are NOT evicted here — only `classifyCatalogRecoveredRun`
    // (a second, later consumer of the same cache — see its own doc
    // comment for why entries are retained for the whole recovery pass,
    // never evicted per-read).
    if (catalogRunRecoveryCache.has(runId)) return true;
    const load = await loadCatalogRunRecoveryRecord(runId);
    return load.status !== 'missing';
  }

  /**
   * AB-241 review finding: `create-bureau.ts`'s `onRecoveredWorkflow` calls
   * this ONCE to both classify a recovered workflow as catalog territory
   * and reseed `runAttribution` — see this function's own doc comment on
   * the `RuntimeComposition` interface for why a single combined read
   * replaces what would otherwise be two independent ones.
   *
   * Fresh review finding: `resolveRunServices`'s catalog branch ALREADY
   * reads and decodes this exact record, earlier, for the same workflow
   * (Weft always resolves a recovered workflow's services before invoking
   * the awaited `onRecoveredWorkflow` hook this function is called from).
   * Rather than issue a THIRD independent storage read here, this consumes
   * `catalogRunRecoveryCache`'s entry from that earlier, already-successful
   * read — a transient failure on a fresh read can no longer diverge from
   * the classification `resolveRunServices` already committed to. Falls
   * back to a fresh read only when the cache holds nothing for `runId`
   * (e.g. a direct caller of this function outside the normal recovery
   * hook ordering, or a test exercising it in isolation).
   *
   * Second fresh review finding: does NOT evict the cache entry after
   * reading it. `recoverDurableRuns`'s own post-recovery loop calls
   * `isCatalogRecoveredRun` for the SAME workflow id, AFTER this function
   * already ran for it (via the awaited `onRecoveredWorkflow` hook, which
   * happens during `recoverAll()`, strictly before the post-recovery loop
   * that iterates its returned handles) — evicting here would have starved
   * that second, later consumer of the exact same already-successful read
   * this function exists to reuse, sending it back to an independent
   * storage read whose transient failure could misclassify an
   * already-resolved-and-monitored catalog run as an orphan. The whole
   * cache is cleared in one call at the end of the boot recovery pass
   * instead — see `clearCatalogRunRecoveryCache`.
   */
  async function classifyCatalogRecoveredRun(runId: string): Promise<{
    isCatalogRun: boolean;
    attribution?: { agentName: string; principal?: string };
  }> {
    const cached = catalogRunRecoveryCache.get(runId);
    if (cached) {
      return {
        isCatalogRun: true,
        attribution: {
          agentName: cached.agentName,
          ...(cached.principal !== undefined ? { principal: cached.principal } : {}),
        },
      };
    }
    const load = await loadCatalogRunRecoveryRecord(runId);
    if (load.status === 'missing') return { isCatalogRun: false };
    if (load.status === 'read-error') return { isCatalogRun: true };
    return {
      isCatalogRun: true,
      attribution: {
        agentName: load.record.agentName,
        ...(load.record.principal !== undefined ? { principal: load.record.principal } : {}),
      },
    };
  }

  /**
   * AB-241 review finding: see `catalogRunRecoveryCache`'s own doc comment.
   */
  function clearCatalogRunRecoveryCache(): void {
    catalogRunRecoveryCache.clear();
  }

  /**
   * AB-240: `resolveRunServices`'s catalog branch — resolves a recovered
   * catalog-dispatched run's deps through the CATALOG AGENT's own
   * `OPERATIVE_RESOLVE_RUN_OPTIONS` (via `catalogAgentRunOptionsResolver`,
   * wired by `createBureau`), never through `buildRunDepsFromSession` /
   * the Bureau's own runtime composition — reattaching a catalog run
   * against the Bureau's default provider/tools instead of the agent's own
   * is this feature's rollback trigger.
   */
  async function resolveCatalogAgentRunServices(
    runId: string,
    record: CatalogRunRecoveryRecord,
  ): Promise<WorkflowServicesResolution> {
    if (!catalogAgentRunOptionsResolver) {
      return {
        status: 'unavailable',
        reason: `run ${runId}: no catalog agent recovery resolver is configured`,
      };
    }
    const resolution = await catalogAgentRunOptionsResolver(record.agentName, record.input, {
      agentName: record.agentName,
      // AB-241 review finding: without this, a recovered catalog agent's
      // re-invoked `OPERATIVE_RESOLVE_RUN_OPTIONS` rebuilt `RunOptions` with
      // no `principal` at all, so a resumed run silently lost attribution
      // across a restart.
      ...(record.principal !== undefined ? { principal: record.principal } : {}),
    });
    if (resolution.status === 'missing-agent') {
      return {
        status: 'unavailable',
        reason: `run ${runId}: catalog agent "${record.agentName}" is no longer in the catalog`,
      };
    }
    if (resolution.status === 'not-durable-capable') {
      return {
        status: 'unavailable',
        reason:
          `run ${runId}: catalog agent "${record.agentName}" no longer supports durable ` +
          `definition resolution (OPERATIVE_RESOLVE_RUN_OPTIONS)`,
      };
    }
    if (resolution.status === 'resolver-failed') {
      return {
        status: 'unavailable',
        reason:
          `run ${runId}: catalog agent "${record.agentName}" could not resolve run options ` +
          `during recovery: ${serializeUnknownError(resolution.error)}`,
      };
    }
    if (resolution.definitionRevision !== record.definitionRevision) {
      // Pin-and-warn, mirroring AB-10's workflow-version-mismatch precedent
      // (`workflowVersionMismatches` / 'reattach-version-mismatch'): reattach
      // with the catalog's CURRENT definition (the closest available match)
      // rather than fail, but surface the drift for operators.
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Catalog agent "${record.agentName}" definition revision changed since ` +
          `run ${runId} was checkpointed (was ${record.definitionRevision}, now ` +
          `${resolution.definitionRevision}); reattaching with the current definition.`,
      });
    }
    // COR-1265 criterion 3b. AB-240's separation is about the PROVIDER and the
    // TOOLBOX — a recovered catalog run must reattach against the agent's own,
    // not the Bureau's, and that is unchanged here. Only the hook tier is added,
    // and only the invariants that close over nothing run-specific, so Bureau's
    // identity and guardrail policy hold on this path as they do on every other.
    // The agent's own tier arrives inside `resolution.options.hooks`, from its
    // own `buildRunOptions`; Bureau goes first so it wins `runFirst` and, being
    // pinned last, still wins the waterfall.
    const invariants = createBureauInvariantHooks();
    return {
      status: 'available',
      services: {
        options: {
          ...resolution.options,
          hooks: mergeHookRegistries(invariants, resolution.options.hooks),
        },
        toolbox: resolution.options.toolbox,
      },
    };
  }

  async function loadScheduleIdForRecoveredRun(
    workflowId: string,
  ): Promise<RecoveredScheduleMarker> {
    if (!durableStorage) return { status: 'missing' };
    try {
      const value = await durableStorage.get(KEYS.scheduleRun(workflowId));
      if (!value) return { status: 'missing' };
      const scheduleId = decodeScheduleRunMarker(decode(value));
      return scheduleId !== undefined ? { status: 'found', scheduleId } : { status: 'missing' };
    } catch (error) {
      return { status: 'read-error', error };
    }
  }

  async function loadExistingStatelessScheduledSessionId(
    store: SessionStore,
    runId: string,
  ): Promise<string | undefined> {
    const sessions = await store.list();
    return sessions.find(
      (session: SessionSummary) =>
        session.id.startsWith('sched-') &&
        session.id.endsWith(`-${runId}`) &&
        session.metadata['lastScheduledFireRunId'] === runId,
    )?.id;
  }

  async function loadExistingScheduledSessionId(
    store: SessionStore,
    input: ScheduledAgentRunInput,
    runId: string,
  ): Promise<string | undefined> {
    if (input.sessionId !== undefined) {
      const session = await store.load(input.sessionId);
      return session?.metadata['lastScheduledFireRunId'] === runId ? input.sessionId : undefined;
    }
    return loadExistingStatelessScheduledSessionId(store, runId);
  }

  async function loadCommittedScheduledActiveSkills(
    session: Awaited<ReturnType<SessionStore['load']>> | undefined,
    runId: string,
    recovering: boolean,
  ): Promise<SkillActivationRecord[] | undefined> {
    if (!recovering || !session) return undefined;

    const metadata = session.metadata;
    const activeSkillRecordsRaw = metadata['activeSkillRecords'];
    const activeSkillRecordsStep = metadata['activeSkillRecordsStep'];
    if (
      metadata['lastScheduledFireRunId'] !== runId ||
      metadata['activeSkillRecordsRunId'] !== runId ||
      typeof activeSkillRecordsStep !== 'number' ||
      !Number.isInteger(activeSkillRecordsStep) ||
      activeSkillRecordsStep < 0
    ) {
      return undefined;
    }

    try {
      const checkpoint = await durable?.checkpointStore.loadCheckpoint(runId);
      const committedStepRecords = [...(checkpoint?.steps ?? [])];

      const checkpointBytes = await durable?.engine.storage.get(KEYS.checkpoint(runId));
      if (checkpointBytes) {
        const weftCheckpoint = deserializeCheckpoint(checkpointBytes);
        for (const [, value] of weftCheckpoint.accumulatedResults) {
          const record = recordedAgentStep(value);
          if (record) committedStepRecords.push(record);
        }
      }

      const latestCommittedStep = committedStepRecords
        .filter((step) => step.step <= activeSkillRecordsStep)
        .toSorted((a, b) => b.step - a.step)
        .find((step) => activeSkillsFromStepMetadata(step.metadata) !== undefined);

      if (latestCommittedStep !== undefined) {
        return activeSkillsFromStepMetadata(latestCommittedStep.metadata);
      }

      if (
        committedStepRecords.some((step) => step.step === activeSkillRecordsStep) &&
        isSkillActivationRecordArray(activeSkillRecordsRaw)
      ) {
        return activeSkillRecordsRaw;
      }

      return undefined;
    } catch (error) {
      options.onLog?.({
        workflowId: runId,
        workflowType: 'agentRun',
        timestamp: runtimeServices.clock.now(),
        level: 'warn',
        message: `Unable to verify scheduled fire skill snapshot checkpoint for run "${runId}": ${serializeUnknownError(error)}`,
      });
      return undefined;
    }
  }

  /**
   * Build fresh {@link DurableRunDeps} for a NATIVE WEFT SCHEDULE FIRE (#109).
   *
   * Reached whenever `resolveRunServices` classifies this run as scheduled — a
   * live timer tick (`info.schedule` set), a recovered fire whose
   * `resolveWorkflowServices` info now also carries `info.schedule` (Weft 0.10+
   * derives it from durable schedule metadata on recovery, same as a live
   * tick), or an older-store recovered fire identified only by the persisted
   * `ScheduledAgentRunInput` / `KEYS.scheduleRun(...)` marker. `info.schedule`
   * being set is therefore NOT a reliable live-vs-recovered signal — both cases
   * populate it. Whether this is a *replay* of a fire that already persisted a
   * partial session before crashing is instead read directly off the session:
   * see `isRecoveredFireReplay` below. It builds deps exactly as a fresh
   * `createRun` would, seeding the conversation with the scheduled prompt and
   * using `info.workflowId` (the per-fire id Weft minted) as the runId. The
   * workflow body reads that same id back as `ctx.workflowId`.
   *
   * Session semantics (D6): `sessionId` present → continue that session's
   * conversation (recurring); absent → a fresh per-fire session (stateless cron).
   */
  async function buildScheduledRunServices(
    info: WorkflowServicesResolverInfo,
    store: SessionStore,
    recoveredScheduleMarker?: RecoveredScheduleMarker,
  ): Promise<WorkflowServicesResolution> {
    if (info.workflowType !== 'agentRun' || !isScheduledAgentRunInput(info.input)) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} has an unrecognized workflow type or input`,
      };
    }

    const scheduledInput: ScheduledAgentRunInput = info.input;
    if (
      info.schedule === undefined &&
      !hasPersistedScheduleMarker(scheduledInput) &&
      recoveredScheduleMarker?.status !== 'found' &&
      recoveredMarkerSessionId(recoveredScheduleMarker) === undefined
    ) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} is missing a persisted schedule marker`,
      };
    }

    const runId = info.workflowId;
    const agentName = scheduledInput.agentName;

    // sessionId present → recurring conversation; absent → fresh per-fire session.
    // The fresh id is derived from the schedule id + per-fire runId so each fire
    // is observable as its own session and two fires never collide.
    const recurring = scheduledInput.sessionId !== undefined;
    const recoveredScheduleId =
      persistedScheduleMarker(scheduledInput) ??
      info.schedule?.id ??
      (recoveredScheduleMarker?.status === 'found'
        ? recoveredScheduleMarker.scheduleId
        : undefined);
    // AB-223: record the correlation the engine-level terminal listener needs
    // to turn this fire's `workflow:completed`/`workflow:failed` into
    // `schedule.completed`/`schedule.failed`. Every reachable branch above
    // that resolves `{ status: 'available' }` has already confirmed a
    // schedule marker exists (the `hasPersistedScheduleMarker`/`info.schedule`/
    // `recoveredScheduleMarker` guard earlier in this function), so
    // `recoveredScheduleId` is defined here in practice; the `undefined` guard
    // is defensive, not a real branch this function's own preconditions
    // permit — dropping the entry rather than recording a bogus correlation.
    if (recoveredScheduleId !== undefined) {
      scheduledFireScheduleIds.set(runId, recoveredScheduleId);
    }
    const existingStatelessSessionId =
      !recurring && recoveredScheduleId === undefined
        ? recoveredMarkerSessionId(recoveredScheduleMarker)
        : undefined;
    const sessionId =
      scheduledInput.sessionId ??
      existingStatelessSessionId ??
      `sched-${recoveredScheduleId ?? 'unknown'}-${runId}`;

    // Always check for an existing session at this id. A recurring fire
    // continues its stored session; a fresh-per-fire (stateless) session's id
    // embeds this exact runId, so a live (never-before-run) fire finds nothing
    // here and this load is a harmless no-op. It only finds something for a
    // recurring schedule's later fires, or a REPLAY of a fire that already
    // persisted (partially or fully) before this resume — which is exactly the
    // case `isRecoveredFireReplay` below needs to detect.
    const existing = await store.load(sessionId);
    // The session's own metadata — not `info.schedule` — is the source of
    // truth for "have we already run this exact fire": `info.schedule` is
    // populated on BOTH a live tick and a recovered one, so it cannot
    // distinguish a fresh fire from a replay of one that crashed mid-flight.
    // A match here means this runId already wrote to this session, so its
    // transcript (and any committed active-skills snapshot) belongs to a
    // stale, partial attempt that must be cleaned before replay re-appends.
    const isRecoveredFireReplay = existing?.metadata['lastScheduledFireRunId'] === runId;
    let conversation: Conversation;
    if (existing) {
      conversation = new Conversation(
        isRecoveredFireReplay
          ? removeLastScheduledFireTranscript(existing.conversationHistory, runId)
          : existing.conversationHistory,
      );
    } else {
      conversation = new Conversation(createConversationHistory({ id: sessionId }));
      if (systemPrompt) {
        conversation.appendSystemMessage(systemPrompt);
      }
    }
    const baseConversationHistory = conversation.current;
    conversation.appendUserMessage(scheduledInput.input, { scheduledFireRunId: runId });

    // Same runtime a normal run builds (generate/toolbox/memory/skills/guardrails),
    // wired to this fire's session + per-fire runId, with live streaming off (no
    // ActiveRun surface for a scheduled fire).
    const initialActiveSkillRecords = await loadCommittedScheduledActiveSkills(
      existing,
      runId,
      isRecoveredFireReplay,
    );
    const requestContext = createSchedulerServiceRequestContext(runId, agentName, sessionId);

    const runRuntime = await createRunRuntime(
      { message: scheduledInput.input, sessionId, runId, agentName, requestContext },
      { liveStreaming: false, initialActiveSkillRecords },
    );

    const services: DurableRunDeps = {
      toolbox: runRuntime.toolbox,
      getStepMetadata: () => ({
        [activeSkillsStepMetadataKey]: activeSkillsStepMetadata(runRuntime.getActiveSkillRecords()),
      }),
      options: {
        generate: runRuntime.generate,
        toolbox: runRuntime.toolbox,
        conversation,
        maximumSteps,
        stopWhen: options.stopWhen,
        // AB-260: the bureau's single composed RuntimeServices instance,
        // snapshotted into every run it starts — including a scheduled fire.
        runtime: runtimeServices,
        // The session write-back runs AFTER the runtime's own onStep hooks so
        // recurring fires accumulate and a stateless fire is observable.
        // COR-1269 — stamped onto this run's hook-plan observations.
        sessionId,
        // COR-1265 criterion 8 — merged AFTER the trailing registration, so the
        // Bureau tier is complete before it becomes the merge's first argument
        // and the trailing hook is offset with every other Bureau entry rather
        // than beside them at a raw priority.
        hooks: mergeHookRegistries(
          registerTrailingOnStep(
            runRuntime.hooks,
            'bureau:scheduled-session-write-back',
            createScheduledSessionPersistHook(
              store,
              sessionId,
              agentName,
              baseConversationHistory,
              runId,
              isRecoveredFireReplay,
              runRuntime.getActiveSkillRecords,
            ),
          ),
        ),
        executeOptions: { requestContext },
        agentName,
        runId,
      },
    };

    // Scheduled fires have no interactive ActiveRun surface. The recovery hook
    // monitors them without attaching live event forwarding.
    return { status: 'available', services };
  }

  /**
   * Weft's `resolveWorkflowServices` resolver: re-provide a recovered run's deps
   * on a fresh-process resume. Weft fires it (per recovered inline run that was
   * launched with `services`) BEFORE the generator advances, passing the run's
   * `workflowId` — which equals our `runId`, since `engine.start` pins
   * `{ id: runId }`. Finds the owning `running` session, rebuilds its deps, and
   * returns `{ status: 'available', services }`; a run with no reconstructable
   * session returns `{ status: 'unavailable' }`, which fails just that one run
   * (terminal `failed`) without aborting recovery or the engine.
   *
   * When the owning session exists and is `running` but its deps cannot be rebuilt
   * here (`buildRunDepsFromSession` throws — e.g. no `generate` configured on this
   * process), it best-effort reconciles that session to `error` before returning
   * unavailable, so the session metadata is not left stuck `running` for a run the
   * engine is about to fail. This is the resolver's one write; it is keyed on the
   * session it just loaded (no race) and swallowed on failure.
   *
   * Idempotent: once a session is reconciled to `error`, the `=== 'running'`
   * predicate above no longer matches it on a later boot, so it falls through to
   * the no-running-session return and is never re-failed or re-written.
   */
  async function resolveRunServices(
    info: WorkflowServicesResolverInfo,
  ): Promise<WorkflowServicesResolution> {
    // The scheduler poller is armed at engine construction, before this closure's
    // later dependencies (sessionStore, createRunRuntime deps) are initialized. If
    // a persisted schedule fires a tick mid-construction, bail out cleanly — the
    // fire fails terminally and the next tick (once ready) succeeds. (Accessing a
    // not-yet-initialized `const` below would otherwise throw a TDZ error.)
    const notReady = compositionReadyGuardResult(compositionReady, info.workflowId);
    if (notReady) return notReady;
    if (!sessionStore) {
      return { status: 'unavailable', reason: 'no session store configured' };
    }
    // AB-240: `bureau.run()`'s durable catalog dispatch persists its OWN
    // recovery record (agent name + a stable definition revision + the
    // original input), keyed by workflowId, entirely independent of
    // `sessionStore`'s lastRunId/lastRunStatus correlation — a catalog run
    // deliberately never owns a bureau session. Check for it FIRST: when
    // present it is authoritative and bypasses every guard below (scheduler
    // origin, session ownership), none of which apply to a catalog run.
    const catalogRecovery = await loadCatalogRunRecoveryRecord(info.workflowId);
    if (catalogRecovery.status === 'read-error') {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId}: catalog recovery record unreadable`,
      };
    }
    if (catalogRecovery.status === 'found') {
      // AB-241 review finding: cache the successfully decoded record so
      // `classifyCatalogRecoveredRun` (called from `onRecoveredWorkflow`,
      // always AFTER this resolver for the same workflow) reuses this exact
      // read instead of issuing its own independent one.
      catalogRunRecoveryCache.set(info.workflowId, catalogRecovery.record);
      return resolveCatalogAgentRunServices(info.workflowId, catalogRecovery.record);
    }
    // NATIVE SCHEDULED FIRE (#109/#126): Weft sets `info.schedule` for a live
    // schedule tick, and (Weft 0.10+) also derives it from durable schedule
    // metadata when re-providing services on recovery — so `info.schedule` alone
    // does not distinguish live from recovered. Some recovered fires (older
    // stores, or a schedule whose metadata could not be resolved) may only carry
    // the persisted ScheduledAgentRunInput, so recovery must also check the
    // persisted schedule marker written by createAgentSchedule(); the broad
    // `{ agentName, input }` shape alone is not enough to bypass the interactive
    // session-ownership guards below.
    let recoveredScheduleMarker =
      info.schedule === undefined &&
      isScheduledAgentRunInput(info.input) &&
      !hasPersistedScheduleMarker(info.input)
        ? await loadScheduleIdForRecoveredRun(info.workflowId)
        : undefined;
    if (
      recoveredScheduleMarker !== undefined &&
      recoveredScheduleMarker.status !== 'found' &&
      isScheduledAgentRunInput(info.input)
    ) {
      try {
        const sessionId = await loadExistingScheduledSessionId(
          sessionStore,
          info.input,
          info.workflowId,
        );
        if (sessionId !== undefined)
          recoveredScheduleMarker = { ...recoveredScheduleMarker, sessionId };
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Could not inspect scheduled session proof for recovered run "${info.workflowId}"; continuing without scheduled-fire classification: ${serializeUnknownError(error)}`,
        });
      }
    }
    if (
      info.schedule !== undefined ||
      (isScheduledAgentRunInput(info.input) &&
        (hasPersistedScheduleMarker(info.input) ||
          recoveredScheduleMarker?.status === 'found' ||
          recoveredMarkerSessionId(recoveredScheduleMarker) !== undefined))
    ) {
      return buildScheduledRunServices(info, sessionStore, recoveredScheduleMarker);
    }
    // The owning session id rides in the run's durable input (Weft passes the
    // persisted `input` to the resolver on recovery — see #2), so load the
    // session DIRECTLY by id, with no `sessionStore.list()` scan or
    // lastRunId/lastRunStatus correlation. A run whose input predates the
    // sessionId field (or is not an agentRun) fails the guard and is treated as
    // not-reconstructable — no compatibility fallback for cross-upgrade runs.
    if (!isAgentRunWorkflowInput(info.input)) {
      return { status: 'unavailable', reason: `run ${info.workflowId} has no recoverable session` };
    }
    // SCHEDULER-ORIGIN GUARD (#25, #44): Weft 0.7 includes launch metadata in
    // WorkflowServicesResolverInfo, so new scheduler-origin runs discriminate by
    // their explicit launch tag instead of the old synthetic-input shape. Keep
    // the prefix check only as legacy cleanup for persisted scheduler runs
    // created before resolver launch context was available.
    const schedulerOriginByLaunchTag =
      info.launchOptions?.tags?.includes(SCHEDULER_ORIGIN_TAG) ?? false;
    const legacySchedulerOriginBySyntheticInput =
      info.input.sessionId === info.input.runId &&
      info.input.runId.startsWith(SCHEDULER_RUN_ID_PREFIX);
    if (schedulerOriginByLaunchTag || legacySchedulerOriginBySyntheticInput) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} is scheduler-origin (no session to recover)`,
      };
    }
    // CORRELATION GUARD (committee MF-5): the workflow id IS the run id (pinned at
    // engine.start), so the input's own runId must match. A mismatch means a
    // corrupt or crafted durable input is trying to correlate this run to a
    // foreign session — fail closed (no session load, no reconcile write) rather
    // than rebuild deps for / write to a session the input doesn't legitimately own.
    if (info.input.runId !== info.workflowId) {
      return { status: 'unavailable', reason: `run ${info.workflowId} input runId mismatch` };
    }
    const sessionId = info.input.sessionId;
    const session = await sessionStore.load(sessionId);

    // The session must still OWN this run AND be IN-FLIGHT (its `lastRunId`
    // matches the workflow id AND `lastRunStatus` is `running`) before we rebuild
    // its deps (committee/Bugbot review: recovery skips session-run ownership).
    // The status check is load-bearing, not just symmetric with the post-recover
    // gate in create-bureau: the resolver fires DURING `recoverAll()` and resuming
    // a run whose session already says `completed`/`error` would let it advance
    // (model/tool SIDE EFFECTS) before the post-recover gate could cancel it —
    // too late. A durable input pointing at a session owning a DIFFERENT run, or
    // at an already-terminal session, fails closed with NO session write.
    if (
      !session ||
      session.metadata['lastRunId'] !== info.workflowId ||
      session.metadata['lastRunStatus'] !== 'running'
    ) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} not owned by a running session`,
      };
    }

    const recoveredAuthority = recoveredRequestContext(
      session.metadata,
      info.workflowId,
      sessionId,
      info.input.agentName,
      runtimeServices.clock.now,
    );
    if (!recoveredAuthority) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} request authority is unavailable during recovery`,
      };
    }
    const recoveredAuthorizationRevision = recoveredAuthority.authority.authorizationRevision;
    const requiresTransportValidation =
      recoveredAuthorizationRevision !== 'bureau:1' &&
      recoveredAuthorizationRevision !== 'bureau:scheduler:1';
    if (requestAuthorityValidator === undefined && requiresTransportValidation) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} authority cannot be revalidated during recovery`,
      };
    }
    if (
      requiresTransportValidation &&
      requestAuthorityValidator &&
      !(await requestAuthorityValidator(recoveredAuthority))
    ) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} authority is no longer current`,
      };
    }

    let services: DurableRunDeps;
    try {
      // info.workflowId === the run id (pinned at engine.start) — thread it so the
      // recovered run's memory-persist idempotency key matches its pre-crash key.
      // info.input.agentName is guaranteed non-empty here: isAgentRunWorkflowInput
      // requires a non-empty string (the guard returned earlier if it's missing).
      services = await buildRunDepsFromSession(session, info.workflowId, info.input.agentName);
    } catch (error) {
      // The session exists, but its deps cannot be rebuilt on this process (e.g.
      // no `generate`/provider configured here, so `createRunRuntime` throws).
      // Weft will fail this run terminally pre-replay; the reattached handle then
      // rejects and its adapter stays write-free — so without this reconcile the
      // session would be left stuck `running`. We have the sessionId in hand, so
      // reconcile it to `error` synchronously on the boot path (not a racy
      // detached write).
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await sessionStore.updateMetadata(sessionId, {
          lastRunStatus: 'error',
          lastFinishReason: 'error',
          lastError: `Recovered run could not be reconstructed: ${reason}`,
        });
      } catch (writeError) {
        // Reconciliation is best-effort — a failed write must not abort the rest
        // of recovery — but it is NOT silent: a session left stale `running`
        // cannot be repaired by a later boot (the run is already terminal
        // `failed` and is skipped), so surface it for operators.
        diagnose({
          level: 'error',
          scope: 'session-persistence',
          message:
            `[bureau] Failed to reconcile unrecoverable run "${info.workflowId}" ` +
            `(session ${sessionId}) to error: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        });
      }
      return { status: 'unavailable', reason: `run ${info.workflowId} not reconstructable` };
    }
    // `services` is never null here: the owning-session check above already
    // guarantees a non-null `session`, and `buildRunDepsFromSession` only
    // returns null for a null session — so its return type's `| null` is a
    // defensive contract for OTHER callers (this file's own
    // `resolveCatalogAgentRunServices` and `buildScheduledRunServices` never
    // call it; a future caller might), not a branch reachable from here. A
    // dead `if (services === null)` fail-closed used to guard this anyway,
    // covered only by forcing it through a private mutation seam (AB-260
    // retired both).
    return { status: 'available', services };
  }

  // Every closure dependency the resolver reads is now initialized; open the gate
  // so scheduler-poller ticks (and the bureau's subsequent `recoverAll()`) resolve.
  compositionReady = true;

  const composition: RuntimeComposition = {
    kv,
    durable,
    workflowVersionMismatches,
    scheduleFireEvents,
    skillEvents,
    disposeStorage:
      durableStorage && ownsDurableStorage ? () => durableStorage[Symbol.dispose]() : undefined,
    durableStorage,
    memory,
    sessionStore,
    scheduler,
    // Exposed so the review queue (`resolveReview`) can call `resumeApproval()`
    // on the SAME toolbox instance (or any `.extend()` clone of it, which
    // preserves `approvalSecret` — see armorer's `extend()`) that executed the
    // original tool call. `resumeApproval` re-invokes the tool by name/callId,
    // so any toolbox sharing this instance's `approvalSecret` and tool set can
    // resume a signed pending approval, not only the specific per-run clone.
    baseToolbox,
    setRequestAuthorityValidator(validator) {
      requestAuthorityValidator = validator;
    },
    setCatalogAgentRunOptionsResolver(resolver) {
      catalogAgentRunOptionsResolver = resolver;
    },
    persistCatalogRunRecoveryRecord,
    isCatalogRecoveredRun,
    classifyCatalogRecoveredRun,
    clearCatalogRunRecoveryCache,
    ready:
      options.generate !== undefined ||
      options.provider !== undefined ||
      (options.providers?.length ?? 0) > 0,
    provider: options.provider ? redactProvider(options.provider) : undefined,
    providers: baseProviders.map((provider) => ({
      ...provider,
      provider: redactProvider(provider.provider),
    })),
    maximumSteps,
    systemPrompt,
    getToolSummaries,
    createRunRuntime,
    // AB-260: folded onto the returned object directly — see the interface's
    // own doc comments for why these are genuine capabilities of this
    // composition rather than test-only introspection.
    resolveRunServices,
    buildScheduledRunServices,
    loadCommittedScheduledActiveSkills,
    createBureauInvariantHooks,
  };

  return composition;
}
