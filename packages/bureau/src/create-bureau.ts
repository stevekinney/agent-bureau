import {
  type ActiveRun,
  AgentContractError,
  type AgentInput,
  type AgentRun,
  type AgentRunContext,
  type AgentSession,
  type CombinedOperativeEventMap,
  createActiveRun,
  createAgentRun,
  createAgentSession,
  createDeferredAgentRun,
  createFlowController,
  createRequestHumanInputTool,
  createRunFinishedFrame,
  createRunStartedFrame,
  type DefinitionResolvingAgent,
  type FlowController,
  HumanWaitParkedEvent,
  type JSONValue,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type RequestHumanInputContext,
  type RunnableAgent,
  type RunOptions,
  type RunReport,
  SchedulerTaskCompletedEvent,
  SchedulerTaskFailedEvent,
  type SessionListOptions,
  type SessionStore,
  type SessionSummary,
  type StreamEventMap,
  TaskCancelledEvent,
  TaskDispatchedEvent,
  TaskPreemptedEvent,
} from '@lostgradient/operative';
import {
  createAgentScheduler,
  createRecoveredRunEventSurface,
  type DurableRunDeps,
  InvalidScheduleError,
  isAgentRunWorkflowInput,
  isScheduledAgentRunInput,
  reattachDurableActiveRun,
  type RecoveredRunHandle,
  type ScheduledAgentRunInput,
  SCHEDULER_RUN_ID_PREFIX,
  type SessionInputAdmissionOutcome,
  type SessionInputAdmissionRequest,
} from '@lostgradient/operative/durable';
import { createModelCatalog } from '@lostgradient/operative/providers';
import {
  createStore,
  RunRegisteredEvent as StoreRunRegisteredEvent,
  RunRemovedEvent as StoreRunRemovedEvent,
  type Store,
  StoreActionEvent,
} from '@lostgradient/operative/store';
import {
  decode,
  type ListFilter,
  type ListOptions,
  type RecoveredWorkflowInfo,
  type ScheduleSpec,
} from '@lostgradient/weft';
import { KEYS } from '@lostgradient/weft/storage';
import {
  combineToolboxes,
  createTool,
  createToolbox,
  type SignedPendingToolApproval,
  type ToolRequestContext,
} from 'armorer';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
  isConversationHistory,
} from 'conversationalist';
import { CompletableEventTarget, type TypedEventTarget } from 'lifecycle';

import { type AgentDefinitions, createAgentCatalog } from './agent-catalog';
import { type AuditTrail, createAuditTrail } from './audit-trail';
import {
  ActionEvent,
  BureauDisposedEvent,
  type BureauEventMap,
  RunRegisteredEvent,
  RunRemovedEvent,
} from './events';
import { createModelCatalogService } from './model-catalog-refresh';
import { createOnlineEvalSampler, type OnlineEvalSampler } from './online-evals';
import {
  buildPartialRunReport,
  buildTerminalReportFromAbortedEvent,
  buildTerminalReportFromCompletedEvent,
  createRunFrameForwarder,
} from './run-envelope';
import type { BureauToolbox } from './runtime-composition';
import {
  createRuntimeComposition,
  createSchedulerServiceRequestContext,
  decodeScheduleRunMarker,
} from './runtime-composition';
import {
  findRunAgentName,
  resolveDiagnosticSink,
  type RunAttribution,
  serializeActionDetail,
  serializeRunDetail,
  serializeRunState,
  serializeUnknownError,
} from './serialization';
import type {
  Bureau,
  BureauOptions,
  BureauRunOptions,
  ConfigurationResponse,
  CreateRunRequest,
  DiagnosticSink,
  DurableScheduleDefinition,
  PendingReview,
  ResolveReviewInput,
  ResolveReviewResult,
  RunSummary,
  ServerFrame,
  SubmitSchedulerTaskRequest,
  SubmitSchedulerTaskResponse,
  ToolSummary,
} from './types';
import { createWebhookNotifier, type WebhookNotifier } from './webhook-notifier';
import { streamEventToFrame } from './websocket-frames';

const BUREAU_AGENT_NAME = 'bureau';
const SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS = 3;
const SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS = 10;
const SCHEDULER_PRIORITIES = ['immediate', 'scheduled', 'background', 'ambient'] as const;

function normalizeRunRequestContext(
  requestContext: ToolRequestContext | undefined,
  runId: string,
  agentName: string,
  principal: string | undefined,
): ToolRequestContext {
  const context = requestContext ?? {
    authority: {
      principalId: principal ?? `run:${runId}`,
      tenantId: 'bureau',
      ownerId: agentName,
      capabilities: ['tools:execute'],
      authorizationRevision: 'bureau:1',
    },
  };
  const authority = Object.freeze({
    ...context.authority,
    capabilities: Object.freeze([...context.authority.capabilities]),
  });
  return Object.freeze({
    ...context,
    authority,
    audience: context.audience ?? 'operator',
    agentId: agentName,
    runId,
  });
}

export function recoveredRequestContextFromMetadata(
  metadata: Record<string, JSONValue>,
  runId: string,
  agentName: string,
): ToolRequestContext | undefined {
  const authorities = metadata['lastRequestAuthorities'];
  const candidate =
    authorities && typeof authorities === 'object' && !Array.isArray(authorities)
      ? (authorities as Record<string, JSONValue>)[runId]
      : metadata['lastRequestAuthority'];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const value = candidate as Record<string, JSONValue>;
  const capabilities = value['capabilities'];
  if (
    typeof value['principalId'] !== 'string' ||
    typeof value['tenantId'] !== 'string' ||
    typeof value['ownerId'] !== 'string' ||
    typeof value['authorizationRevision'] !== 'string' ||
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === 'string')
  ) {
    return undefined;
  }
  const deadline = value['deadline'];
  const persistedAgentId = value['agentId'];
  if (persistedAgentId !== undefined && typeof persistedAgentId !== 'string') return undefined;
  if (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline))) {
    return undefined;
  }
  if (typeof deadline === 'number' && deadline <= Date.now()) return undefined;
  return normalizeRunRequestContext(
    {
      authority: {
        principalId: value['principalId'],
        tenantId: value['tenantId'],
        ownerId: value['ownerId'],
        capabilities: capabilities,
        authorizationRevision: value['authorizationRevision'],
      },
      ...(value['audience'] !== undefined
        ? { audience: value['audience'] as ToolRequestContext['audience'] }
        : {}),
      ...(typeof deadline === 'number' ? { deadline } : {}),
    },
    runId,
    persistedAgentId ?? agentName,
    undefined,
  );
}

/**
 * Returns whether a persisted session can still resume under transport-issued
 * authority. Terminal sessions retain their authority for auditability, but
 * must not defer boot recovery because no user code can resume from them.
 */
export function hasRecoverableTransportAuthority(metadata: Record<string, JSONValue>): boolean {
  if (metadata['lastRunStatus'] !== 'running') return false;
  const requiresTransportValidator = (revision: unknown): boolean =>
    typeof revision === 'string' && revision !== 'bureau:1' && revision !== 'bureau:scheduler:1';
  const lastRunId = metadata['lastRunId'];
  if (typeof lastRunId !== 'string' || !lastRunId) return false;
  const authorities = metadata['lastRequestAuthorities'];
  if (authorities && typeof authorities === 'object' && !Array.isArray(authorities)) {
    const activeAuthority = (authorities as Record<string, JSONValue>)[lastRunId];
    if (!activeAuthority || typeof activeAuthority !== 'object' || Array.isArray(activeAuthority)) {
      return false;
    }
    return requiresTransportValidator(
      (activeAuthority as Record<string, JSONValue>)['authorizationRevision'],
    );
  }
  const legacyAuthority = metadata['lastRequestAuthority'];
  if (!legacyAuthority || typeof legacyAuthority !== 'object' || Array.isArray(legacyAuthority)) {
    return false;
  }
  return requiresTransportValidator(
    (legacyAuthority as Record<string, JSONValue>)['authorizationRevision'],
  );
}

/**
 * Resolves what a session's metadata records about its most recent run's
 * authority, per AB-42's coordinator ruling (2026-09-02): reads
 * `metadata['lastRequestAuthorities'][lastRunId]?.principalId`, falling back
 * to the legacy `metadata['lastRequestAuthority'].principalId` exactly as
 * {@link recoveredRequestContextFromMetadata} already does.
 *
 * `{ recorded: false }` means the session has recorded no authority at
 * all — an "open" session, per the ruling. `{ recorded: true, principalId }`
 * means an authority WAS recorded; `principalId` is `undefined` only when
 * that recorded authority is itself malformed (missing or non-string
 * `principalId`), which must fail closed (deny every principal), never be
 * read as "open" — a corrupted or partially-written persistence record must
 * not silently grant access. This is why a per-run entry present-but-malformed
 * does NOT fall back to the legacy field the way a genuinely absent per-run
 * entry does: once a per-run entry exists, it is authoritative for that run,
 * so silently falling through past a corrupted record would suppress exactly
 * the failure this distinction exists to catch — conflating "absent" with
 * "malformed" is the class of bug this whole function guards against.
 *
 * The same reasoning extends to a non-empty-but-uncorrelated
 * `lastRequestAuthorities` map (see below): it is checked BEFORE the legacy
 * fallback, not after, because that exact shape is what two concurrent runs
 * on one session produce, and the legacy field may belong to the OTHER,
 * unrelated run — see the concurrent-run correlation note below.
 *
 * A completed/aborted/errored run's `lastRequestAuthorities[lastRunId]` entry
 * is pruned on terminal transition (see the cleanup near `remainingAuthorities`
 * below), while the legacy singular `lastRequestAuthority` is retained — so a
 * per-run lookup that is GENUINELY ABSENT (no map, no `lastRunId`, or the key
 * missing from the map) falls back to the legacy field.
 */
function isPlainAuthorityRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lookupSessionAuthority(
  metadata: Record<string, JSONValue>,
):
  | { readonly recorded: false }
  | { readonly recorded: true; readonly principalId: string | undefined } {
  const lastRunId = metadata['lastRunId'];
  const authorities = metadata['lastRequestAuthorities'];
  // A PRESENT-but-malformed `lastRequestAuthorities` value (not absent — a
  // string or array where a map belongs) is itself evidence something was
  // recorded and corrupted. It must fail closed regardless of `lastRunId` or
  // a legacy fallback, never be read as "nothing recorded" (open) — the same
  // fail-closed principle as a malformed per-run/legacy entry below.
  if (authorities !== undefined && !isPlainAuthorityRecord(authorities)) {
    return { recorded: true, principalId: undefined };
  }
  const perRunEntry =
    typeof lastRunId === 'string' && lastRunId && authorities !== undefined
      ? authorities[lastRunId]
      : undefined;
  const legacy = metadata['lastRequestAuthority'];
  let candidate: JSONValue | undefined;
  if (perRunEntry !== undefined) {
    candidate = perRunEntry;
  } else if (authorities !== undefined && Object.keys(authorities).length > 0) {
    // A valid, non-empty `lastRequestAuthorities` map exists but doesn't
    // correlate to this run (`lastRunId` missing/corrupt, or the map's
    // entries are keyed to other runs). Checked BEFORE the legacy fallback,
    // not after: this exact shape is what two concurrent runs on one session
    // produce — run B's dispatch overwrites the singular legacy field with
    // B's authority while A is still running, so trusting legacy here would
    // authorize B's principal against A's (still-uncorrelated) run. A
    // non-empty-but-uncorrelated map is recorded-but-uncorrelated evidence,
    // not "nothing recorded" — fail closed rather than consult a legacy
    // field that may belong to an unrelated concurrent run.
    return { recorded: true, principalId: undefined };
  } else if (legacy !== undefined) {
    candidate = legacy;
  } else {
    return { recorded: false };
  }
  if (!isPlainAuthorityRecord(candidate)) {
    return { recorded: true, principalId: undefined };
  }
  const principalId = candidate['principalId'];
  return { recorded: true, principalId: typeof principalId === 'string' ? principalId : undefined };
}

/**
 * The `principalId` recorded for a session's most recent run, per
 * {@link lookupSessionAuthority}'s rule. Returns `undefined` both when the
 * session has recorded no authority at all AND when a recorded authority is
 * malformed — this function alone cannot distinguish the two, so it is
 * informational only. {@link isSessionAuthorityAuthorized} is the
 * security-relevant surface: it fails closed (denies) for malformed
 * authority, never treating it as open the way "genuinely no authority
 * recorded" is treated.
 *
 * Shared by every new Bureau session verb that needs to read a session's
 * recorded authority (AB-194's `submitSessionInput`, AB-199's
 * `submitSteeringCommand`) — neither issue owns or invents this mechanism,
 * both simply read the pre-existing metadata keys `create-bureau.ts` already
 * writes on every run dispatch.
 */
export function recordedSessionAuthorityPrincipalId(
  metadata: Record<string, JSONValue>,
): string | undefined {
  const lookup = lookupSessionAuthority(metadata);
  return lookup.recorded ? lookup.principalId : undefined;
}

/**
 * Whether `principal` is authorized to act on a session recording the given
 * metadata, per {@link lookupSessionAuthority}'s rule. A session with no
 * recorded authority at all is treated as open — every principal is
 * authorized — matching what every existing session verb enforces today
 * (nothing stronger), per AB-42's coordinator ruling (2026-09-02). A session
 * with a RECORDED-BUT-MALFORMED authority fails closed: no principal is
 * authorized, since a corrupted record cannot be verified to match anyone.
 */
export function isSessionAuthorityAuthorized(
  metadata: Record<string, JSONValue>,
  principal: string,
): boolean {
  const lookup = lookupSessionAuthority(metadata);
  if (!lookup.recorded) return true;
  return lookup.principalId === principal;
}

/**
 * Whether a session's most recent run is in a terminal (non-`'running'`)
 * state, reading the same `metadata['lastRunStatus']` field
 * {@link requireSessionRunId} and {@link hasRecoverableTransportAuthority}
 * already read. Shared by every new Bureau session verb that needs a
 * terminal-session check (AB-194's `submitSessionInput`, AB-199's
 * `submitSteeringCommand`).
 */
export function isSessionRunTerminal(metadata: Record<string, JSONValue>): boolean {
  return metadata['lastRunStatus'] !== 'running';
}

export function isTerminalApprovalBindingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as Record<string, unknown>)['code'];
  return (
    code === 'expired' ||
    code === 'revoked' ||
    code === 'already-consumed' ||
    code === 'not-found' ||
    code === 'invalid-binding'
  );
}

export function emptyRecoveredStepMetadata(): Record<string, never> {
  return {};
}

export function omitKeysWithPrefix(
  record: Record<string, JSONValue>,
  prefix: string,
): Record<string, JSONValue> {
  const remaining: Record<string, JSONValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith(prefix)) remaining[key] = value;
  }
  return remaining;
}

function stringValues(values: readonly JSONValue[]): string[] {
  const strings: string[] = [];
  for (const value of values) {
    if (typeof value === 'string') strings.push(value);
  }
  return strings;
}

function omitStringValue(values: readonly JSONValue[], omittedValue: string): JSONValue[] {
  const remaining: JSONValue[] = [];
  for (const value of values) {
    if (value !== omittedValue) remaining.push(value);
  }
  return remaining;
}

function omitStringsWithPrefix(values: readonly JSONValue[], prefix: string): JSONValue[] {
  const remaining: JSONValue[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.startsWith(prefix)) remaining.push(value);
  }
  return remaining;
}

export function defaultSessionPersistenceSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ignoreBestEffortPromiseRejection(): void {}

export function detachBestEffortPromise(promise: Promise<unknown>): void {
  void promise.catch(ignoreBestEffortPromiseRejection);
}

type FlowControlScheduler = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

type FlowControlSchedulerEvent =
  | SchedulerTaskCompletedEvent
  | SchedulerTaskFailedEvent
  | TaskCancelledEvent
  | TaskPreemptedEvent
  | TaskDispatchedEvent;

export function wireFlowControlSchedulerEvents(
  scheduler: FlowControlScheduler,
  flowController: Pick<FlowController, 'settle' | 'markParked' | 'markResumed'>,
): Array<() => void> {
  function settleScheduledTask(
    event: SchedulerTaskCompletedEvent | SchedulerTaskFailedEvent | TaskCancelledEvent,
  ) {
    flowController.settle(event.taskId);
  }

  function handlePreemptedTask(event: TaskPreemptedEvent) {
    if (event.requeued) {
      flowController.markParked(event.taskId);
      return;
    }

    flowController.settle(event.taskId);
  }

  function handleDispatchedTask(event: TaskDispatchedEvent) {
    flowController.markResumed(event.taskId);
  }

  const listeners: ReadonlyArray<readonly [FlowControlSchedulerEvent['type'], EventListener]> = [
    [SchedulerTaskCompletedEvent.type, settleScheduledTask as EventListener],
    [SchedulerTaskFailedEvent.type, settleScheduledTask as EventListener],
    [TaskCancelledEvent.type, settleScheduledTask as EventListener],
    [TaskPreemptedEvent.type, handlePreemptedTask as EventListener],
    [TaskDispatchedEvent.type, handleDispatchedTask as EventListener],
  ];

  return listeners.map(([eventType, listener]) => {
    scheduler.addEventListener(eventType, listener);
    return () => scheduler.removeEventListener(eventType, listener);
  });
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

/**
 * Discriminates *why* a `BureauError` with code `NOT_CONFIGURED` was thrown.
 * `NOT_CONFIGURED` alone is not enough for a consumer to decide an HTTP status:
 * some subjects mean "this deployment does not compose that capability at all"
 * (`durable`, `scheduler` — a 501 case), others mean "the capability exists but
 * is unconfigured, and the operator can fix it" (`generate`, `persistence`,
 * `approval` — a 503 case). Only set on `NOT_CONFIGURED` errors.
 */
export type BureauErrorNotConfiguredSubject =
  'generate' | 'scheduler' | 'durable' | 'persistence' | 'approval';

class BureauError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'NOT_CONFIGURED'
    | 'BAD_REQUEST'
    | 'RATE_LIMITED'
    | 'UNSUPPORTED_CAPABILITY';
  readonly subject?: BureauErrorNotConfiguredSubject;

  // `subject` is required for NOT_CONFIGURED and disallowed for every other
  // code — a compile-time guarantee that a future NOT_CONFIGURED throw site
  // cannot skip disambiguation and reintroduce the ambiguity #264 fixed.
  constructor(message: string, code: Exclude<BureauError['code'], 'NOT_CONFIGURED'>);
  constructor(message: string, code: 'NOT_CONFIGURED', subject: BureauErrorNotConfiguredSubject);
  constructor(
    message: string,
    code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'NOT_CONFIGURED'
      | 'BAD_REQUEST'
      | 'RATE_LIMITED'
      | 'UNSUPPORTED_CAPABILITY',
    subject?: BureauErrorNotConfiguredSubject,
  ) {
    super(message);
    this.name = 'BureauError';
    this.code = code;
    this.subject = subject;
  }
}

export { BureauError };

function toBadRequest(message: string): never {
  throw new BureauError(message, 'BAD_REQUEST');
}

/**
 * The exact duration grammar weft's `parseDuration` accepts: a number (optionally
 * fractional, optionally space-separated from the unit) followed by a unit, where
 * the unit is `ms`/`s`/`m`/`h`/`d` or its full word (`seconds`, `minutes`, …).
 * Kept in lockstep with weft so we never route a string weft would accept as an
 * interval into the cron branch (and vice-versa). Note: weft does NOT support
 * weeks or ISO-8601 (`PT6H`) durations.
 */
const WEFT_DURATION =
  /^\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i;

/**
 * Normalize a {@link DurableScheduleDefinition.spec} string into a weft
 * {@link ScheduleSpec}. Weft parses a BARE string as a cron expression
 * (`normalizeCronSpec`), so a duration like `'6h'` must be wrapped as `{ every }`
 * or it would be misparsed as cron. A string matching weft's duration grammar →
 * interval; everything else (cron expression, `@macro`) → cron.
 */
function toScheduleSpec(spec: string): ScheduleSpec {
  const trimmed = spec.trim();
  if (WEFT_DURATION.test(trimmed)) {
    return { every: trimmed };
  }
  return { cron: trimmed };
}

function validateMessageRequest(request: {
  message: unknown;
  maximumSteps?: unknown;
  maximumTokens?: unknown;
  systemPrompt?: unknown;
}): void {
  if (!request.message || typeof request.message !== 'string') {
    toBadRequest('Request must include a "message" string');
  }

  if (request.systemPrompt !== undefined && typeof request.systemPrompt !== 'string') {
    toBadRequest('"systemPrompt" must be a string');
  }

  if (request.maximumSteps !== undefined) {
    if (
      typeof request.maximumSteps !== 'number' ||
      !Number.isInteger(request.maximumSteps) ||
      request.maximumSteps <= 0
    ) {
      toBadRequest('"maximumSteps" must be a positive integer');
    }
  }

  if (request.maximumTokens !== undefined) {
    if (
      typeof request.maximumTokens !== 'number' ||
      !Number.isInteger(request.maximumTokens) ||
      request.maximumTokens <= 0
    ) {
      toBadRequest('"maximumTokens" must be a positive integer');
    }
  }
}

function validateCreateRunRequest(request: CreateRunRequest): void {
  validateMessageRequest(request);

  if (request.sessionId !== undefined) {
    if (typeof request.sessionId !== 'string') {
      toBadRequest('"sessionId" must be a string');
    }

    if (request.sessionId.trim().length === 0) {
      toBadRequest('"sessionId" must be a non-empty string');
    }
  }

  if (request.agentName !== undefined) {
    if (typeof request.agentName !== 'string') {
      toBadRequest('"agentName" must be a string');
    }

    if (request.agentName.trim().length === 0) {
      toBadRequest('"agentName" must be a non-empty string');
    }
  }
}

/**
 * AB-15/AB-22: `bureau.run`'s synchronous-throw surface — unknown agent name,
 * malformed `input`, or malformed `options` — validated BEFORE any async
 * work (durable-engine dispatch, definition resolution) begins. Everything
 * else (session, provider, tool, policy, abort) settles through the
 * returned `AgentRun` handle instead of throwing here.
 */
function validateAgentRunInput(input: unknown): asserts input is AgentInput {
  if (typeof input === 'string') return;
  if (
    input !== null &&
    typeof input === 'object' &&
    'conversation' in input &&
    isConversationHistory(input.conversation)
  ) {
    return;
  }
  toBadRequest(
    '"input" must be a string or an object with a valid "conversation" ConversationHistory',
  );
}

function validateBureauRunOptions(
  options: BureauRunOptions | undefined,
): asserts options is BureauRunOptions | undefined {
  if (options === undefined) return;
  // `typeof [] === 'object'` — without excluding arrays explicitly, a
  // JavaScript caller passing `[]` (or any array) as `options` passed this
  // guard as an empty options bag instead of the synchronous rejection the
  // contract advertises for malformed options (review round 2, Codex).
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    toBadRequest('"options" must be an object');
  }
  if (options.sessionId !== undefined && typeof options.sessionId !== 'string') {
    toBadRequest('"options.sessionId" must be a string');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    toBadRequest('"options.signal" must be an AbortSignal');
  }
  if (options.withTraceContext !== undefined && typeof options.withTraceContext !== 'function') {
    toBadRequest('"options.withTraceContext" must be a function');
  }
  if (options.principal !== undefined) {
    // `AgentRunContext` (AB-15) carries no `principal` field — a bare
    // `RunnableAgent.run()` has no attribution/session system to record it
    // against (that is `createRun`'s job, not `bureau.run`'s). Silently
    // discarding a caller-supplied `principal` would look like an accepted
    // no-op; reject it synchronously instead so the gap is discoverable at
    // the call site rather than as a missing attribution nobody notices.
    toBadRequest(
      '"options.principal" is not supported by bureau.run() — RunnableAgent.run() has no attribution surface to record it against. Use Bureau.createRun() for principal-attributed runs.',
    );
  }
}

function validateSubmitSchedulerTaskRequest(request: SubmitSchedulerTaskRequest): void {
  validateMessageRequest(request);

  if (request.metadata !== undefined) {
    if (
      typeof request.metadata !== 'object' ||
      request.metadata === null ||
      Array.isArray(request.metadata)
    ) {
      toBadRequest('"metadata" must be an object');
    }
  }

  if (request.priority !== undefined && !SCHEDULER_PRIORITIES.includes(request.priority)) {
    toBadRequest('"priority" must be one of: immediate, scheduled, background, ambient');
  }

  if (request.requeue !== undefined && typeof request.requeue !== 'boolean') {
    toBadRequest('"requeue" must be a boolean');
  }
}

/**
 * The session metadata boot recovery needs to decide a recovered run's fate,
 * loaded by id from the owning session. `null` ⇒ the session does not exist.
 */
export type RecoveredRunSessionMetadata = { lastRunId?: unknown; lastRunStatus?: unknown } | null;

/**
 * The outcome of loading a recovered run's owning session: a successful load
 * (the metadata, possibly `null` for "absent") or a transient read FAILURE that
 * leaves ownership UNKNOWN.
 */
export type SessionLoadOutcome = { ok: true; session: RecoveredRunSessionMetadata } | { ok: false };

/**
 * Decide what boot recovery does with one handle from `engine.recoverAll()`:
 *
 * - `reattach` — bureau-owned, in-flight, session-confirmed: wrap it in a live
 *   ActiveRun and register it.
 * - `monitor` — native scheduled fire: leave the recovered Weft workflow running
 *   and attach a detached result monitor, but do not register an ActiveRun because
 *   scheduled fires intentionally have no interactive session ownership.
 * - `cancel` — POSITIVELY not a reattachable bureau-owned in-flight run (bad/
 *   missing launch metadata, foreign run id, or a session that is absent / owns a
 *   different run / is already terminal). `engine.cancel` terminalizes it so it
 *   does not run unowned with no monitor.
 * - `skip` — ownership could NOT be confirmed (a transient session-load failure,
 *   or no session store): do NOTHING. `engine.cancel` is terminal, so we never
 *   cancel a run that may be legitimately recovering — the worst case is it
 *   resumes without live `getRun` visibility (the pre-#3 behaviour).
 *
 * Pure (no I/O) so every branch is unit-testable. `recoverAll()` fires the
 * services resolver synchronously per run before returning, and the resolver
 * reconciles a deps-unrebuildable run's session to `lastRunStatus: 'error'` — so
 * by the time this classifies, a session still `'running'` is one the resolver
 * kept. The gate is on SESSION status, NOT engine run-status: a run that
 * resolved-and-finished fast during `recoverAll` is terminal in the engine but its
 * session is still `'running'` (its monitor has not written yet), and it must
 * still be reattached so its completion is persisted.
 */
export function classifyRecoveredRun(args: {
  handleId: string;
  /** Whether the launch metadata identifies a native scheduled fire. */
  scheduledFire: boolean;
  /** The narrowed agentRun input when the launch metadata is bureau-owned, else `undefined`. */
  ownedSessionId: string | undefined;
  /** Whether reading the handle's launch metadata threw. */
  metadataReadFailed: boolean;
  /** A session store is configured (recovery cannot reattach without one). */
  hasSessionStore: boolean;
  /** The session-load outcome; only meaningful when `ownedSessionId` is set + `hasSessionStore`. */
  sessionLoad: SessionLoadOutcome;
  /**
   * AB-10 — true when the durable engine flagged this run's checkpointed
   * `workflowVersion` as differing from the currently-registered one (see
   * `RuntimeComposition.workflowVersionMismatches`). Only changes the verdict
   * for what would otherwise be `'reattach'` — the run still reattaches
   * (pin-and-warn), it is just flagged distinctly so callers can log/alert on
   * the drift.
   */
  versionMismatch?: boolean;
}): 'reattach' | 'reattach-version-mismatch' | 'monitor' | 'cancel' | 'skip' {
  // A failed metadata read means we cannot even identify the run — but it WAS
  // resumed by recoverAll, so cancel it rather than leave it unowned.
  if (args.metadataReadFailed) return 'cancel';
  if (args.ownedSessionId === undefined) {
    // A scheduled fire has no interactive session ownership to confirm. Weft has
    // already resumed it via the scheduled-fire resolver branch, so monitor its
    // result without registering it as an ActiveRun or cancelling it as foreign.
    if (args.scheduledFire) return 'monitor';
    // Not a bureau-owned agentRun (foreign run id / non-agentRun input) — cancel.
    return 'cancel';
  }
  // Owned input but no session store to confirm against / reattach into — skip.
  if (!args.hasSessionStore) return 'skip';
  // Transient session-load failure — ownership UNKNOWN, never cancel; skip.
  if (!args.sessionLoad.ok) return 'skip';
  const session = args.sessionLoad.session;
  // Session absent / owns a different run / not in-flight — positively unowned.
  if (!session || session.lastRunId !== args.handleId || session.lastRunStatus !== 'running') {
    return 'cancel';
  }
  return args.versionMismatch ? 'reattach-version-mismatch' : 'reattach';
}

export function isRecoverableScheduledFireInput(input: unknown): input is ScheduledAgentRunInput {
  return (
    isScheduledAgentRunInput(input) &&
    typeof input.scheduleId === 'string' &&
    input.scheduleId.trim().length > 0
  );
}

async function loadScheduleIdForRecoveredRun(
  engine: { storage: { get(key: string): Promise<Uint8Array | null> } },
  workflowId: string,
): Promise<
  | { status: 'found'; scheduleId: string }
  | { status: 'missing' }
  | { status: 'read-error'; error: unknown }
> {
  try {
    const value = await engine.storage.get(KEYS.scheduleRun(workflowId));
    if (!value) return { status: 'missing' };
    const scheduleId = decodeScheduleRunMarker(decode(value));
    return scheduleId !== undefined ? { status: 'found', scheduleId } : { status: 'missing' };
  } catch (error) {
    return { status: 'read-error', error };
  }
}

export async function loadExistingScheduledSessionId(
  store: SessionStore,
  input: ScheduledAgentRunInput,
  runId: string,
): Promise<string | undefined> {
  if (input.sessionId !== undefined) {
    const session = await store.load(input.sessionId);
    return session?.metadata['lastScheduledFireRunId'] === runId ? input.sessionId : undefined;
  }
  const sessions = await store.list();
  return sessions.find(
    (session: SessionSummary) =>
      session.id.startsWith('sched-') &&
      session.id.endsWith(`-${runId}`) &&
      session.metadata['lastScheduledFireRunId'] === runId,
  )?.id;
}

export function wireStreamEventTargetFrames(
  streamEventTarget: TypedEventTarget<StreamEventMap>,
  runId: string,
  emitLiveFrame: (frame: ServerFrame) => void,
  nextRunSeq: (runId: string) => number,
): () => void {
  const streamEventTypes = [
    'stream:text-delta',
    'stream:tool-call-start',
    'stream:tool-call-delta',
    'stream:tool-call-complete',
    'stream:complete',
    'stream:error',
  ] as const;
  const disposers: Array<() => void> = [];

  for (const eventType of streamEventTypes) {
    const listener = (event: Event) => {
      const detail = (event as Event & { detail: Parameters<typeof streamEventToFrame>[1] }).detail;
      const frame = streamEventToFrame(runId, detail);
      if (frame) {
        emitLiveFrame({ ...frame, runSeq: nextRunSeq(runId) });
      }
    };

    streamEventTarget.addEventListener(eventType, listener);
    disposers.push(() => streamEventTarget.removeEventListener(eventType, listener));
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
  };
}

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

function isRunFailureFinishReason(finishReason: unknown): boolean {
  return (
    finishReason === 'error' ||
    finishReason === 'tripwire' ||
    finishReason === 'maximum-steps' ||
    finishReason === 'elicitation-denied' ||
    finishReason === 'budget-exceeded'
  );
}

export async function monitorRecoveredScheduledFire(
  handle: RecoveredRunHandle,
  diagnose: DiagnosticSink = resolveDiagnosticSink(undefined),
): Promise<void> {
  try {
    const result = await handle.result();
    if (
      typeof result === 'object' &&
      result !== null &&
      'finishReason' in result &&
      isRunFailureFinishReason(result.finishReason)
    ) {
      const errorMessage =
        'errorMessage' in result && typeof result.errorMessage === 'string'
          ? `: ${result.errorMessage}`
          : '';
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Recovered scheduled fire "${handle.id}" finished with ${String(result.finishReason)}${errorMessage}`,
      });
    }
  } catch (error) {
    diagnose({
      level: 'error',
      scope: 'recovery',
      message: `[bureau] Recovered scheduled fire "${handle.id}" failed: ${serializeUnknownError(error)}`,
    });
  }
}

/**
 * AB-194 — `BureauOptions.sessionInput`'s `sessionBacklogLimit`/
 * `principalBacklogLimit` must each be a positive integer when supplied.
 * Throws `BureauError('...', 'BAD_REQUEST')` for 0, a negative number, or a
 * non-integer; a `undefined` value (option omitted) passes through untouched.
 */
function validateSessionInputBacklogLimit(value: number | undefined, optionName: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    toBadRequest(`"options.sessionInput.${optionName}" must be a positive integer`);
  }
}

export async function createBureau<const D extends AgentDefinitions = AgentDefinitions>(
  options: BureauOptions<D>,
): Promise<Bureau<D>> {
  // AB-194: validated here (BAD_REQUEST at construction time) though not yet
  // enforced — every reachable `submitSessionInput` outcome today is a
  // pre-admission rejection, before any backlog could exist to check
  // against. Enforcement lands with the mailbox-backed `ab-42-bureau-b` slice
  // once WFT-84 ships, using these same validated values (defaulting to
  // `DEFAULT_SESSION_INPUT_BACKLOG_LIMIT`/`DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT`).
  validateSessionInputBacklogLimit(
    options.sessionInput?.sessionBacklogLimit,
    'sessionBacklogLimit',
  );
  validateSessionInputBacklogLimit(
    options.sessionInput?.principalBacklogLimit,
    'principalBacklogLimit',
  );
  const diagnose = resolveDiagnosticSink(options.onDiagnostic);
  const ownsStore = !options.store;
  const store: Store = options.store ?? createStore();
  const emitter = new CompletableEventTarget<BureauEventMap>();
  // Snapshot `agents` synchronously, before the first `await` below — the
  // "fixed at createBureau() call time" catalog contract otherwise has a
  // real mutation window: a caller that mutates the SAME `agents` object it
  // passed in (adds/removes/reassigns a key) between calling createBureau()
  // and it resolving would leak that change into `bureau.agents`, since
  // `createRuntimeComposition(options)` is awaited before the catalog used
  // to be built from `options.agents` (review round 2, Codex). A shallow
  // copy preserves key insertion order (the definition-order guarantee)
  // while defeating exactly that window; it does not deep-freeze individual
  // agent values, which is unchanged/out of scope.
  const agentsSnapshot: D = { ...options.agents };
  const runtime = await createRuntimeComposition(options);
  // AB-15/AB-22: the typed agent catalog — a plain literal map, fixed for
  // the bureau's lifetime, dispatched by name through `bureau.run`.
  // Independent of `runtime` (bureau-level generate/toolbox/provider
  // composition, still used by `createRun`).
  // `selectorAvailable: false` — no selector is wired yet (AB-66); mod-03c
  // flips this to `true` when `planSelection` lands, so the transition has
  // one named mechanism in one named file (AB-247/mod-02e).
  const agentCatalog = createAgentCatalog(agentsSnapshot, { selectorAvailable: false });
  // AB-246 — the model-catalog refresh service. Independent of `runtime`.
  // When the caller doesn't supply one, the default `descriptorSource`
  // re-derives `@lostgradient/operative/providers`'s static seed — this is
  // the seam a future live provider probe attaches to (out of scope here).
  const modelCatalog =
    options.modelCatalog ??
    createModelCatalogService({
      seed: createModelCatalog(),
      descriptorSource: () => Promise.resolve(createModelCatalog().descriptors),
      now: () => new Date().toISOString(),
      newRefreshId: () => `catalog-refresh-${crypto.randomUUID()}`,
    });
  // AB-13 — declarative flow control (concurrency/rate-limit/singleton). One
  // controller instance shared across BOTH `createRun` (API-triggered) and
  // `submitSchedulerTask` (scheduler-originated), so a per-agent concurrency
  // cap counts runs from either surface against the same limit.
  const flowController: FlowController | undefined = options.flowControl
    ? createFlowController(options.flowControl)
    : undefined;
  const runSessionIdentifiers = new WeakMap<ActiveRun, string>();
  const activeRuns = new Set<ActiveRun>();
  // AB-22: runs dispatched through `bureau.run(...)`, tracked separately from
  // `activeRuns` above (which holds only bureau-owned `ActiveRun` internals,
  // not the arbitrary `AgentRun` a catalog `RunnableAgent` may return on the
  // direct/non-durable dispatch path). `dispose()` aborts every entry here
  // the same way it aborts `activeRuns`, so a catalog run in flight cannot
  // outlive the bureau that started it.
  const catalogRuns = new Set<AgentRun<unknown, boolean>>();
  const runToolboxes = new Set<BureauToolbox>();
  const runToolboxesByRunId = new Map<string, BureauToolbox>();
  let disposePromise: Promise<void> | undefined;
  // Ids of PendingReview items already resolved via resolveReview() (AB-20).
  // Neither resolution path (resumeApproval, signalSession) mutates the live
  // store in a way listPendingReviews() can detect on its own — resumeApproval
  // re-invokes the tool directly (no run/step event), and a signalled human-wait
  // run may take a moment to produce its next action. This set is the
  // authoritative "already handled" marker so a resolved review disappears
  // from the queue immediately, and is never accidentally resolved twice.
  const resolvedReviewIds = new Set<string>();
  const resolvingReviewIds = new Set<string>();
  const reviewResolutionCleanupPending = new Map<
    string,
    {
      sessionId: string;
      runId: string;
      kind: PendingReview['kind'];
      decision: 'approve' | 'deny';
      review: PendingReview;
      principal: string;
      reason?: string;
    }
  >();
  const pendingApprovalOverrides = new Map<
    string,
    Extract<PendingReview, { kind: 'tool-approval' }>['approval']
  >();
  const terminalReviewSessions = new Map<
    string,
    { sessionId: string; agentName: string; requestedAt: number }
  >();
  // A persisted approval can be stale by the time a process restarts. Keep
  // that failure scoped to its review rather than preventing the bureau from
  // recovering unrelated runs.
  const invalidApprovalReviewIds = new Set<string>();
  // AB-54 usage analytics: agentName/principal resolved deterministically at
  // `createRun` time, keyed by runId. Layer A only (in-memory, like the rest
  // of RunSummary) — a durably recovered run (process restart) has no entry
  // here and `serializeRunState` falls back to the `findRunAgentName`
  // heuristic for `agentName`; `principal` has no such fallback since it is
  // never persisted durably. Entries are removed on `deleteRun` so this map
  // does not outlive the run it describes.
  const runAttribution = new Map<string, RunAttribution>();
  // Keep the exact host-supplied (or bureau-derived) context for approval
  // resumption. Approval bindings identify the original caller, but are not a
  // substitute for the complete request context and must not mint authority.
  const runRequestContexts = new Map<string, ToolRequestContext>();
  const recoveredRunIds = new Set<string>();
  let requestAuthorityValidator:
    ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined =
    options.requestAuthorityValidator;
  const isTransportIssuedAuthority = (context: ToolRequestContext): boolean =>
    context.authority.authorizationRevision !== 'bureau:1' &&
    context.authority.authorizationRevision !== 'bureau:scheduler:1';
  let durableRecoveryDeferred = false;
  let durableRecoveryStarted = false;
  let durableRecoveryBarrier: Promise<void> = Promise.resolve();
  let resolveDurableRecoveryBarrier: (() => void) | undefined;
  const liveFrameListeners = new Set<(frame: ServerFrame) => void>();
  // AB-96 — terminal RunReports, cached at the moment each run's lifecycle
  // event fires so `getRunReport` never needs to re-derive them.
  const runReports = new Map<string, RunReport>();
  // AB-15: per-run monotonic sequence counter for run-scoped live frames
  // (`event` and `stream:*`). Stamped once here — the single point where
  // frames reach `emitLiveFrame` — so `streamEventToFrame` and the store
  // action listener never have to coordinate on sequencing themselves.
  // Cleared on `run.removed` (see the store subscription below) so the map
  // does not grow unbounded across a long-lived bureau.
  const runSequenceCounters = new Map<string, number>();

  function nextRunSeq(runId: string): number {
    const next = (runSequenceCounters.get(runId) ?? 0) + 1;
    runSequenceCounters.set(runId, next);
    return next;
  }

  /**
   * AB-15: seeds `runSequenceCounters` for a run reattached by
   * `engine.recoverAll()` so a pre-restart client cursor cannot suppress
   * post-restart frames. `runSequenceCounters` is in-memory only and this
   * bureau instance's store is rebuilt fresh on every boot (`store.register`
   * in {@link reattachRecoveredRun} attaches to a brand-new `RunState`), so
   * without seeding, `nextRunSeq` would restart a recovered run's sequence
   * at 1 — and a browser reconnecting with a pre-restart cursor like
   * `since: 25` would have every post-restart frame (runSeq 1, 2, 3, ...)
   * filtered out by `getFramesSince`/`LiveFrameBroker`, silently losing
   * them instead of replaying them.
   *
   * Seeding from the current wall-clock time (rather than 0) guarantees the
   * new generation's sequence numbers are far larger than anything handed
   * out in a previous process's lifetime, so old cursors always compare as
   * "already behind" and every post-restart frame is delivered — at worst a
   * client sees a handful of frames it already had (harmless; frame
   * application in the UI stores is idempotent per-field, not a strict
   * just-once contract), never a silent gap.
   */
  function seedRunSeqGeneration(runId: string): void {
    runSequenceCounters.set(runId, Date.now());
  }
  const sessionPersistenceRetryDelayMilliseconds =
    options.sessionPersistenceRetryDelayMilliseconds ??
    SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS;
  const sessionPersistenceSleep = options.sessionPersistenceSleep ?? defaultSessionPersistenceSleep;

  function getRunSessionIdentifier(runState: { activeRun: ActiveRun }): string {
    return runSessionIdentifiers.get(runState.activeRun) ?? '';
  }

  function emitLiveFrame(frame: ServerFrame): void {
    // AB-96 codex review — a throwing `subscribeLiveFrames` listener must not
    // abort the caller. `emitLiveFrame` is invoked synchronously from run-setup
    // call sites (e.g. the `run-started` frame fires BEFORE `store.register` and
    // the terminal listeners are installed), so an unguarded throw here would
    // propagate out of `createRun`/`reattachRecoveredRun` and leave the run
    // launched-but-untracked: the session already persisted as `running`, the
    // `ActiveRun` already started, but never registered — stuck forever. Catch
    // and log per-listener instead, matching the isolation every other fan-out
    // in this file already gives its listeners (see `disposeRegisteredStreamListeners`
    // callers, `emitter.dispatch`).
    for (const listener of liveFrameListeners) {
      try {
        listener(frame);
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'live-frames',
          message: `[bureau] subscribeLiveFrames listener threw on a "${frame.type}" frame:`,
          cause: error,
        });
      }
    }
  }

  const storeSubscription = store.toObservable().subscribe((event) => {
    switch (event.type) {
      case 'action': {
        const storeActionEvent = event as StoreActionEvent;
        emitter.dispatch(new ActionEvent(storeActionEvent.action));
        emitLiveFrame({
          type: 'event',
          runId: storeActionEvent.action.runId,
          event: storeActionEvent.action.type,
          detail: serializeActionDetail(
            storeActionEvent.action.type,
            storeActionEvent.action.detail,
          ),
          sequence: storeActionEvent.action.sequence,
          runSeq: nextRunSeq(storeActionEvent.action.runId),
          timestamp: storeActionEvent.action.timestamp,
        });
        break;
      }
      case 'run.registered':
        emitter.dispatch(new RunRegisteredEvent((event as StoreRunRegisteredEvent).runId));
        break;
      case 'run.removed': {
        const removedRunId = (event as StoreRunRemovedEvent).runId;
        const removedRun = store.getRun(removedRunId);
        const removedSessionId = removedRun ? getRunSessionIdentifier(removedRun) : '';
        runSequenceCounters.delete(removedRunId);
        runRequestContexts.delete(removedRunId);
        recoveredRunIds.delete(removedRunId);
        runToolboxesByRunId.delete(removedRunId);
        terminalReviewSessions.delete(removedRunId);
        for (const [reviewId, cleanup] of reviewResolutionCleanupPending) {
          if (cleanup.runId === removedRunId) reviewResolutionCleanupPending.delete(reviewId);
        }
        for (const id of pendingApprovalOverrides.keys()) {
          if (id.startsWith(`approval:${removedRunId}:`)) pendingApprovalOverrides.delete(id);
        }
        for (const id of invalidApprovalReviewIds) {
          if (id.startsWith(`approval:${removedRunId}:`)) invalidApprovalReviewIds.delete(id);
        }
        if (removedSessionId) {
          detachBestEffortPromise(
            prunePersistedPendingApprovalOverrides(removedSessionId, `approval:${removedRunId}:`),
          );
          detachBestEffortPromise(
            prunePersistedResolvedReviewIds(removedSessionId, `approval:${removedRunId}:`),
          );
          detachBestEffortPromise(
            prunePersistedResolvedReviewIds(removedSessionId, `human-wait:${removedRunId}:`),
          );
        }
        emitter.dispatch(new RunRemovedEvent(removedRunId));
        // Prune this run's entries from `resolvedReviewIds` — the review ids
        // it tracks (`approval:${runId}:...`, `human-wait:${runId}:...`) can
        // never be produced by `listPendingReviews()` again once the run
        // itself is gone from the store, so keeping them around forever
        // would be an unbounded per-run leak on a long-lived gateway with
        // frequent approvals/denials.
        for (const id of resolvedReviewIds) {
          if (
            id.startsWith(`approval:${removedRunId}:`) ||
            id.startsWith(`human-wait:${removedRunId}:`)
          ) {
            resolvedReviewIds.delete(id);
          }
        }
        break;
      }
    }
  });

  const schedulerEventTypes = [
    'task.queued',
    'task.dispatched',
    'task.completed',
    'task.failed',
    'task.preempted',
    'task.cancelled',
    'scheduler.idle',
    'scheduler.started',
    'scheduler.stopped',
  ] as const;

  function emitSchedulerLiveFrame(event: Event): void {
    if (event.type === 'task.preempted') {
      const preemptedEvent = event as Event & { taskId: string; reason: string };
      emitLiveFrame({
        type: 'scheduler.task.preempted',
        taskId: preemptedEvent.taskId,
        reason: preemptedEvent.reason,
        state: runtime.scheduler!.getState(),
      });
      return;
    }

    emitLiveFrame({
      type: 'scheduler.state',
      state: runtime.scheduler!.getState(),
    });
  }

  const schedulerCleanup =
    runtime.scheduler === undefined
      ? []
      : schedulerEventTypes.map((eventType) => {
          runtime.scheduler!.addEventListener(eventType, emitSchedulerLiveFrame);
          return () => runtime.scheduler?.removeEventListener(eventType, emitSchedulerLiveFrame);
        });

  // AB-13 — enforce the flow-control lifecycle for scheduler-originated
  // tasks. Preemption (`task.preempted`, `requeued: true`) is this scheduler's
  // OWN notion of "parked" — the run is suspended and will be redispatched
  // later — so it maps directly onto `markParked`/`markResumed`, freeing the
  // concurrency slot while the task sits preempted. `markResumed` is a no-op
  // when the slot was never parked (e.g. a task's FIRST dispatch), so it is
  // safe to call on every `task.dispatched`.
  const flowControlSchedulerCleanup: Array<() => void> =
    flowController === undefined || runtime.scheduler === undefined
      ? []
      : wireFlowControlSchedulerEvents(runtime.scheduler, flowController);

  function requireSessionStore() {
    if (!runtime.sessionStore) {
      throw new BureauError(
        'No SessionStore configured (set options.persistence with a StorageConfiguration or PersistenceOptions)',
        'NOT_CONFIGURED',
        'persistence',
      );
    }

    return runtime.sessionStore;
  }

  async function loadConversation(sessionId: string) {
    const sessionStore = runtime.sessionStore;
    if (!sessionStore) {
      return {
        session: undefined,
        conversation: new Conversation(createConversationHistory({ id: sessionId })),
      };
    }

    const session = await sessionStore.load(sessionId);
    if (!session) {
      return {
        session: undefined,
        conversation: new Conversation(createConversationHistory({ id: sessionId })),
      };
    }

    return {
      session,
      conversation: new Conversation(session.conversationHistory),
    };
  }

  async function saveSession(
    sessionId: string,
    conversation: Conversation,
    metadata: Record<string, JSONValue>,
    agentName?: string,
    baseConversationHistory: ConversationHistory = conversation.current,
  ): Promise<void> {
    const sessionStore = runtime.sessionStore;
    if (!sessionStore) {
      return;
    }

    await sessionStore.update(sessionId, (existingSession: AgentSession | undefined) => {
      const nextSession =
        existingSession ??
        createAgentSession({
          id: sessionId,
          // Stamp the dispatched agent on a brand-new session (falls back to the
          // house default when no agent was named).
          agentName: agentName ?? BUREAU_AGENT_NAME,
          conversationHistory: conversation.current,
        });

      // Promote a session still on the default house agent to the named agent on
      // its first named dispatch, so session APIs/persistence reflect which agent
      // actually owns it (PRRT_kwDORvupsc6MbUsN — previously the session was always
      // stamped 'bureau' regardless of request.agentName). Don't overwrite a session
      // already owned by a specific agent.
      const resolvedAgentName =
        agentName !== undefined && nextSession.agentName === BUREAU_AGENT_NAME
          ? agentName
          : nextSession.agentName;

      const mergedMetadata: Record<string, JSONValue> = {
        ...nextSession.metadata,
        ...metadata,
        ...(metadata['lastRequestAuthorities'] !== undefined
          ? {
              lastRequestAuthorities: {
                ...(typeof nextSession.metadata['lastRequestAuthorities'] === 'object' &&
                nextSession.metadata['lastRequestAuthorities'] !== null &&
                !Array.isArray(nextSession.metadata['lastRequestAuthorities'])
                  ? nextSession.metadata['lastRequestAuthorities']
                  : {}),
                ...(metadata['lastRequestAuthorities'] as Record<string, JSONValue>),
              },
            }
          : {}),
      };
      const terminalRunId = mergedMetadata['lastRunId'];
      const terminalStatus = mergedMetadata['lastRunStatus'];
      if (
        typeof terminalRunId === 'string' &&
        (terminalStatus === 'completed' ||
          terminalStatus === 'aborted' ||
          terminalStatus === 'error')
      ) {
        // Approval reviews can outlive the run's terminal transition. Keep the
        // authority alongside the signed approval until that review resolves;
        // otherwise recovery cannot reconstruct the exact execution context.
        const terminalRun = store.getRun(terminalRunId);
        const hasPendingApproval = terminalRun?.steps.some((step) =>
          step.results.some(
            (result) =>
              result.outcome === 'action_required' && result.pendingApproval !== undefined,
          ),
        );
        const authorities = mergedMetadata['lastRequestAuthorities'];
        if (
          !hasPendingApproval &&
          typeof authorities === 'object' &&
          authorities !== null &&
          !Array.isArray(authorities)
        ) {
          const { [terminalRunId]: _removed, ...remainingAuthorities } = authorities as Record<
            string,
            JSONValue
          >;
          mergedMetadata['lastRequestAuthorities'] = remainingAuthorities;
        }
        // Completed action-required runs remain reviewable until their
        // approval is explicitly resolved. Removing the signed descriptor at
        // the terminal transition would make a restart lose the only binding
        // that can resume that review.
        if (!hasPendingApproval) {
          const approvals = mergedMetadata['pendingApprovalOverrides'];
          if (typeof approvals === 'object' && approvals !== null && !Array.isArray(approvals)) {
            const remainingApprovals = omitKeysWithPrefix(
              approvals as Record<string, JSONValue>,
              `approval:${terminalRunId}:`,
            );
            mergedMetadata['pendingApprovalOverrides'] = remainingApprovals;
          }
        }
      }

      return {
        ...nextSession,
        agentName: resolvedAgentName,
        conversationHistory: existingSession
          ? appendConversationMessages(
              existingSession.conversationHistory,
              conversation.current,
              baseConversationHistory,
            )
          : conversation.current,
        metadata: mergedMetadata,
      };
    });
  }

  async function persistPendingApprovalOverride(
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    const serializedApproval = JSON.parse(JSON.stringify(approval)) as JSONValue;
    await runtime.sessionStore.update(sessionId, (session) => ({
      ...session!,
      metadata: {
        ...session!.metadata,
        approvalResolutionStartedIds: Array.isArray(
          session!.metadata['approvalResolutionStartedIds'],
        )
          ? omitStringValue(session!.metadata['approvalResolutionStartedIds'], reviewId)
          : [],
        pendingApprovalOverrides: {
          ...(typeof session!.metadata['pendingApprovalOverrides'] === 'object' &&
          session!.metadata['pendingApprovalOverrides'] !== null &&
          !Array.isArray(session!.metadata['pendingApprovalOverrides'])
            ? session!.metadata['pendingApprovalOverrides']
            : {}),
          [reviewId]: serializedApproval,
        },
      },
    }));
  }

  async function persistApprovalResolutionStarted(
    sessionId: string,
    reviewId: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const current = session.metadata['approvalResolutionStartedIds'];
      const startedIds = Array.isArray(current) ? stringValues(current) : [];
      return {
        ...session,
        metadata: {
          ...session.metadata,
          approvalResolutionStartedIds: startedIds.includes(reviewId)
            ? startedIds
            : [...startedIds, reviewId],
        },
      };
    });
  }

  async function prunePersistedPendingApprovalOverrides(
    sessionId: string,
    reviewIdPrefix: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const current = session.metadata['pendingApprovalOverrides'];
      const remaining =
        typeof current === 'object' && current !== null && !Array.isArray(current)
          ? omitKeysWithPrefix(current as Record<string, JSONValue>, reviewIdPrefix)
          : current;
      const currentStarted = session.metadata['approvalResolutionStartedIds'];
      const remainingStarted = Array.isArray(currentStarted)
        ? omitStringsWithPrefix(currentStarted, reviewIdPrefix)
        : currentStarted;
      return {
        ...session,
        metadata: {
          ...session.metadata,
          ...(remaining === undefined ? {} : { pendingApprovalOverrides: remaining }),
          ...(remainingStarted === undefined
            ? {}
            : { approvalResolutionStartedIds: remainingStarted }),
        },
      };
    });
  }

  async function retryRunDeletionPersistenceWrite(
    operation: 'pending-approvals' | 'resolved-reviews',
    sessionId: string,
    reviewIdPrefix: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        if (operation === 'pending-approvals') {
          await prunePersistedPendingApprovalOverrides(sessionId, reviewIdPrefix);
        } else {
          await prunePersistedResolvedReviewIds(sessionId, reviewIdPrefix);
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
          await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
        }
      }
    }
    throw lastError;
  }

  async function prunePersistedInvalidApprovalReviewState(
    sessionId: string,
    runId: string,
    reviewId: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const currentPending = session.metadata['pendingApprovalOverrides'];
      let pendingApprovalOverrides = currentPending;
      if (
        typeof currentPending === 'object' &&
        currentPending !== null &&
        !Array.isArray(currentPending)
      ) {
        const { [reviewId]: _removed, ...remaining } = currentPending as Record<string, JSONValue>;
        pendingApprovalOverrides = remaining;
      }

      let hasRemainingApprovalForRun = false;
      if (
        typeof pendingApprovalOverrides === 'object' &&
        pendingApprovalOverrides !== null &&
        !Array.isArray(pendingApprovalOverrides)
      ) {
        for (const id of Object.keys(pendingApprovalOverrides)) {
          if (id.startsWith(`approval:${runId}:`)) {
            hasRemainingApprovalForRun = true;
            break;
          }
        }
      }
      let lastRequestAuthorities = session.metadata['lastRequestAuthorities'];
      if (
        !hasRemainingApprovalForRun &&
        typeof lastRequestAuthorities === 'object' &&
        lastRequestAuthorities !== null &&
        !Array.isArray(lastRequestAuthorities)
      ) {
        const { [runId]: _removed, ...remainingAuthorities } = lastRequestAuthorities as Record<
          string,
          JSONValue
        >;
        lastRequestAuthorities = remainingAuthorities;
      }

      return {
        ...session,
        metadata: {
          ...session.metadata,
          ...(pendingApprovalOverrides !== currentPending ? { pendingApprovalOverrides } : {}),
          ...(lastRequestAuthorities !== session.metadata['lastRequestAuthorities']
            ? { lastRequestAuthorities }
            : {}),
        },
      };
    });
  }

  async function prunePersistedInvalidApprovalReviewStateWithRetry(
    sessionId: string,
    runId: string,
    reviewId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await prunePersistedInvalidApprovalReviewState(sessionId, runId, reviewId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
          await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
        }
      }
    }
    throw lastError;
  }

  async function persistPendingApprovalOverrideWithRetry(
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await persistPendingApprovalOverride(sessionId, reviewId, approval);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
          await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
        }
      }
    }
    throw lastError;
  }

  async function persistApprovalResolutionStartedWithRetry(
    sessionId: string,
    reviewId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await persistApprovalResolutionStarted(sessionId, reviewId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
          await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
        }
      }
    }
    throw lastError;
  }

  async function persistReviewResolution(
    sessionId: string,
    reviewId: string,
    removePendingApproval: boolean,
    runId: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const currentResolved = session.metadata['resolvedReviewIds'];
      const resolvedReviewIds: string[] = [];
      if (Array.isArray(currentResolved)) {
        for (const id of currentResolved) {
          if (typeof id === 'string') resolvedReviewIds.push(id);
        }
      }
      const currentPending = session.metadata['pendingApprovalOverrides'];
      let pendingApprovalOverrides = currentPending;
      if (
        removePendingApproval &&
        typeof currentPending === 'object' &&
        currentPending !== null &&
        !Array.isArray(currentPending)
      ) {
        const { [reviewId]: _removed, ...remaining } = currentPending as Record<string, JSONValue>;
        pendingApprovalOverrides = remaining;
      }
      const run = store.getRun(runId);
      let hasRemainingReviews = false;
      for (const review of listPendingReviews()) {
        if (review.runId !== runId) continue;
        hasRemainingReviews = true;
        break;
      }
      let lastRequestAuthorities = session.metadata['lastRequestAuthorities'];
      if (
        run &&
        run.status !== 'running' &&
        !hasRemainingReviews &&
        typeof lastRequestAuthorities === 'object' &&
        lastRequestAuthorities !== null &&
        !Array.isArray(lastRequestAuthorities)
      ) {
        const { [runId]: _removed, ...remainingAuthorities } = lastRequestAuthorities as Record<
          string,
          JSONValue
        >;
        lastRequestAuthorities = remainingAuthorities;
      }
      return {
        ...session,
        metadata: {
          ...session.metadata,
          approvalResolutionStartedIds: Array.isArray(
            session.metadata['approvalResolutionStartedIds'],
          )
            ? omitStringValue(session.metadata['approvalResolutionStartedIds'], reviewId)
            : [],
          resolvedReviewIds: resolvedReviewIds.includes(reviewId)
            ? resolvedReviewIds
            : [...resolvedReviewIds, reviewId],
          ...(removePendingApproval ? { pendingApprovalOverrides } : {}),
          ...(lastRequestAuthorities !== session.metadata['lastRequestAuthorities']
            ? { lastRequestAuthorities }
            : {}),
        },
      };
    });
  }

  async function persistReviewResolutionWithRetry(
    sessionId: string,
    reviewId: string,
    removePendingApproval: boolean,
    runId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await persistReviewResolution(sessionId, reviewId, removePendingApproval, runId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
          await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
        }
      }
    }
    throw lastError;
  }

  async function prunePersistedResolvedReviewIds(
    sessionId: string,
    reviewIdPrefix: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const current = session.metadata['resolvedReviewIds'];
      if (!Array.isArray(current)) return session;
      const remainingReviewIds: string[] = [];
      for (const id of current) {
        if (typeof id === 'string' && !id.startsWith(reviewIdPrefix)) {
          remainingReviewIds.push(id);
        }
      }
      return {
        ...session,
        metadata: {
          ...session.metadata,
          resolvedReviewIds: remainingReviewIds,
        },
      };
    });
  }

  function restoreResolvedReviewIds(metadata: unknown, runId: string): void {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const persistedIds = metadataRecord?.['resolvedReviewIds'];
    if (!Array.isArray(persistedIds)) return;
    for (const reviewId of persistedIds) {
      if (typeof reviewId === 'string' && reviewId.startsWith(`approval:${runId}:`)) {
        resolvedReviewIds.add(reviewId);
      }
      if (typeof reviewId === 'string' && reviewId.startsWith(`human-wait:${runId}:`)) {
        resolvedReviewIds.add(reviewId);
      }
    }
  }

  function restorePendingApprovalOverrides(metadata: unknown, runId: string): void {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const overrides = metadataRecord?.['pendingApprovalOverrides'];
    const resolutionStartedIds = new Set(
      Array.isArray(metadataRecord?.['approvalResolutionStartedIds'])
        ? stringValues(metadataRecord['approvalResolutionStartedIds'])
        : [],
    );
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return;
    for (const [reviewId, approval] of Object.entries(overrides as Record<string, unknown>)) {
      if (!reviewId.startsWith(`approval:${runId}:`)) continue;
      if (resolutionStartedIds.has(reviewId)) continue;
      if (invalidApprovalReviewIds.has(reviewId)) continue;
      if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
        pendingApprovalOverrides.set(
          reviewId,
          approval as Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
        );
      }
    }
  }

  function persistedApprovalRunIds(metadata: unknown): Set<string> {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const runIds = new Set<string>();
    const lastRunId = metadataRecord?.['lastRunId'];
    if (typeof lastRunId === 'string') runIds.add(lastRunId);
    const pending = metadataRecord?.['pendingApprovalOverrides'];
    const authorities = metadataRecord?.['lastRequestAuthorities'];
    if (
      pending &&
      typeof pending === 'object' &&
      !Array.isArray(pending) &&
      authorities &&
      typeof authorities === 'object' &&
      !Array.isArray(authorities)
    ) {
      for (const authorityRunId of Object.keys(authorities)) {
        if (
          Object.keys(pending).some((reviewId) =>
            reviewId.startsWith(`approval:${authorityRunId}:`),
          )
        ) {
          runIds.add(authorityRunId);
        }
      }
    }
    return runIds;
  }

  async function restorePendingApprovalStates(
    toolbox: BureauToolbox,
    metadata: unknown,
    runId: string,
    sessionId: string,
  ): Promise<void> {
    const restoreApproval = (
      toolbox as unknown as {
        restoreApproval?: (approval: SignedPendingToolApproval) => Promise<void>;
      }
    ).restoreApproval;
    if (!restoreApproval) return;
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const overrides = metadataRecord?.['pendingApprovalOverrides'];
    const resolutionStartedIds = new Set(
      Array.isArray(metadataRecord?.['approvalResolutionStartedIds'])
        ? stringValues(metadataRecord['approvalResolutionStartedIds'])
        : [],
    );
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return;
    for (const [reviewId, approval] of Object.entries(overrides as Record<string, unknown>)) {
      if (!reviewId.startsWith(`approval:${runId}:`)) continue;
      if (resolutionStartedIds.has(reviewId)) continue;
      if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
        if (!(approval as { approvalBinding?: unknown }).approvalBinding) continue;
        try {
          await restoreApproval(approval as SignedPendingToolApproval);
        } catch (error) {
          if (!isTerminalApprovalBindingError(error)) throw error;
          invalidApprovalReviewIds.add(reviewId);
          pendingApprovalOverrides.delete(reviewId);
          await prunePersistedInvalidApprovalReviewStateWithRetry(sessionId, runId, reviewId);
          diagnose({
            level: 'warn',
            scope: 'approval-recovery',
            message:
              `[bureau] Failed to restore approval binding for "${reviewId}"; ` +
              'the affected review will remain unavailable while other runs recover.',
            cause: error,
          });
        }
      }
    }
  }

  async function restoreTerminalReviewSession(
    session: Pick<AgentSession, 'id' | 'agentName' | 'metadata' | 'updatedAt'>,
    restoredRunId?: string,
  ): Promise<void> {
    const runId = restoredRunId ?? session.metadata['lastRunId'];
    if (
      typeof runId !== 'string' ||
      (runId === session.metadata['lastRunId'] && session.metadata['lastRunStatus'] === 'running')
    )
      return;
    const hasPendingOverride = Object.keys(
      (session.metadata['pendingApprovalOverrides'] as Record<string, unknown> | undefined) ?? {},
    ).some((reviewId) => reviewId.startsWith(`approval:${runId}:`));
    if (!hasPendingOverride) return;

    const requestContext = recoveredRequestContextFromMetadata(
      session.metadata,
      runId,
      session.agentName,
    );
    if (!requestContext) {
      const overrides = session.metadata['pendingApprovalOverrides'];
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const reviewId of Object.keys(overrides)) {
          if (!reviewId.startsWith(`approval:${runId}:`)) continue;
          invalidApprovalReviewIds.add(reviewId);
          pendingApprovalOverrides.delete(reviewId);
          await prunePersistedInvalidApprovalReviewStateWithRetry(session.id, runId, reviewId);
          diagnose({
            level: 'warn',
            scope: 'approval-recovery',
            message:
              `[bureau] Failed to restore request authority for "${reviewId}"; ` +
              'the affected review will remain unavailable while other runs recover.',
          });
        }
      }
      terminalReviewSessions.delete(runId);
      return;
    }
    const recoveredAgentName = requestContext.agentId ?? session.agentName;
    const runRuntime = await runtime.createRunRuntime(
      {
        message:
          typeof session.metadata['lastUserMessage'] === 'string'
            ? session.metadata['lastUserMessage']
            : '',
        sessionId: session.id,
        runId,
        agentName: recoveredAgentName,
        requestContext,
      },
      { liveStreaming: false },
    );
    const terminalReviewSession = terminalReviewSessions.get(runId);
    if (terminalReviewSession) {
      terminalReviewSessions.set(runId, {
        ...terminalReviewSession,
        agentName: recoveredAgentName,
      });
    }
    runRequestContexts.set(runId, requestContext);
    runToolboxesByRunId.set(runId, runRuntime.toolbox);
    await restorePendingApprovalStates(runRuntime.toolbox, session.metadata, runId, session.id);
    if (
      !Array.from(pendingApprovalOverrides.keys()).some((reviewId) =>
        reviewId.startsWith(`approval:${runId}:`),
      )
    ) {
      terminalReviewSessions.delete(runId);
      runRequestContexts.delete(runId);
      runToolboxesByRunId.delete(runId);
    }
  }

  function persistSessionUpdate(
    saveSessionUpdate: () => Promise<void>,
    context: { runId: string; sessionId: string; status: 'completed' | 'error' | 'aborted' },
  ): void {
    void (async () => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
        try {
          await saveSessionUpdate();
          return;
        } catch (error) {
          lastError = error;

          if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
            try {
              await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
            } catch (sleepError) {
              lastError = sleepError;
              break;
            }
          }
        }
      }

      diagnose({
        level: 'error',
        scope: 'session-persistence',
        message: `[bureau] Failed to persist ${context.status} session state for run ${context.runId} in session ${context.sessionId}: ${serializeUnknownError(lastError)}`,
      });
    })();
  }

  function disposeRegisteredStreamListeners(listeners: Array<() => void>): void {
    while (listeners.length > 0) {
      const disposeListener = listeners.pop();
      disposeListener?.();
    }
  }

  /**
   * AB-15/AB-22: `bureau.run(name, input, options?)` — synchronous dispatch
   * to a named catalog agent. Independent of `createRunFromRequest` below:
   * this drives the catalog agent's OWN generate/tools/durability, not
   * `runtime`'s bureau-level composition.
   *
   * Synchronous throws are limited to unknown `name`, a disposed bureau, and
   * malformed `input`/`options` (validated up front, before any async work).
   * When this bureau has a durable engine composed AND the named agent
   * exposes the definition-resolution capability (AB-21's
   * `OPERATIVE_RESOLVE_RUN_OPTIONS`), the run is driven through that engine;
   * otherwise the agent's own in-memory `run()` is used directly. Either way
   * this function itself returns synchronously — the async work (resolving
   * run options, or awaiting the durable engine's setup) is deferred behind
   * `createDeferredAgentRun`.
   *
   * **Known gap, not yet closed:** the durable branch checkpoints the run
   * through the engine (it is discoverable via `bureau.listDurableRuns()`
   * mid-flight — see `bureau-run.test.ts`), but does NOT write the session
   * record `runtime-composition.ts`'s boot-recovery resolver requires
   * (`session.metadata.lastRunId`/`lastRunStatus`, keyed by
   * `runOptions?.sessionId ?? runId`). A process restart therefore does
   * NOT reattach a catalog run in flight — `recoverAll()`'s resolver finds
   * no owning session and returns `{ status: 'unavailable' }` for it, same
   * as any other run with "no recoverable session". This is a real,
   * open gap (flagged in review), not a documented design choice like the
   * durable-recovery-failure-is-diagnosed-not-rejected behavior elsewhere in
   * this file — closing it needs a session write parallel to
   * `createRunFromRequest`'s, which `bureau.run` currently has no request
   * context to draw an authority record from.
   */
  /**
   * AB-22 review fix: `catalogRuns` (declared near `activeRuns` above) needs
   * every handle `runAgent` hands back, on both the durable and direct
   * dispatch branches, so `dispose()` can abort a catalog run still in
   * flight the same way it already aborts bureau-owned `ActiveRun`s.
   * Untracked on terminal settlement so a long-lived bureau does not retain
   * one entry per historical run forever.
   */
  function trackCatalogRun(handle: AgentRun<unknown, boolean>): AgentRun<unknown, boolean> {
    catalogRuns.add(handle);
    // `detachBestEffortPromise`, not a bare `void ... .finally(...)`: AB-15's
    // contract says a well-behaved `RunnableAgent.result()` never rejects
    // (it settles through `RunResult.error` instead), but "JavaScript
    // callers" is itself one of this issue's acceptance-criteria categories
    // — a foreign, non-conforming agent's `result()` genuinely can reject,
    // and a dropped rejection under `void` would be an unhandled rejection
    // that is this bureau's fault, not the caller's.
    detachBestEffortPromise(
      handle.result().finally(() => {
        catalogRuns.delete(handle);
      }),
    );
    return handle;
  }

  function runAgent(
    name: string,
    input: AgentInput,
    runOptions?: BureauRunOptions,
  ): AgentRun<unknown, boolean> {
    if (disposePromise) {
      throw new BureauError('Cannot run an agent: bureau is disposed', 'CONFLICT');
    }
    const agent = agentCatalog.find(name);
    if (!agent) {
      throw new BureauError(`Unknown agent "${name}"`, 'NOT_FOUND');
    }
    validateAgentRunInput(input);
    validateBureauRunOptions(runOptions);

    const context: AgentRunContext = { agentName: name };
    if (runOptions?.signal) context.signal = runOptions.signal;
    if (runOptions?.traceContext !== undefined) context.traceContext = runOptions.traceContext;
    if (runOptions?.withTraceContext) context.withTraceContext = runOptions.withTraceContext;

    const definitionResolvingAgent = agent as RunnableAgent<unknown, boolean> &
      DefinitionResolvingAgent;
    const resolver = definitionResolvingAgent[OPERATIVE_RESOLVE_RUN_OPTIONS];

    if (runtime.durable && typeof resolver === 'function') {
      const durable = runtime.durable;
      const runId = `agent-run-${crypto.randomUUID()}`;
      // Captured so the wrapper below can forward an abort straight to the
      // dispatched durable `ActiveRun` even in the race `createDeferredAgentRun`
      // does not close: `resolveDurableAgent` unconditionally starts the
      // durable engine dispatch (it has no way to observe the outer handle's
      // already-terminal state — `createDeferredAgentRun` checks that only
      // AFTER awaiting this resolver, and only to decide whether to call the
      // synthetic agent's `run()`, not whether to have started it). A caller
      // that calls `.abort()` on the returned handle before this resolver's
      // `await resolver(...)` settles would otherwise leave the already-started
      // durable workflow running, unobserved, forever.
      let dispatchedActiveRun: ActiveRun | undefined;
      // Review round 2 (Codex): the previous fix only forwarded abort() to
      // `dispatchedActiveRun` when it ALREADY existed at the moment abort()
      // ran — it did nothing when abort() was called (or the handle
      // disposed) while `resolver(input, context)` was still pending, since
      // `dispatchedActiveRun` is undefined for that entire window and
      // nothing re-checks after it's finally assigned. Remember the request
      // instead, and act on it the instant the ActiveRun exists, whichever
      // order the two events happen in.
      let cancellationRequested: { reason: string | undefined; dispose: boolean } | undefined;
      // `createDeferredAgentRun` resolves a `RunnableAgent` then calls its
      // `run()` — built for `createLazyAgent`'s "resolve a module" case, but
      // agnostic to WHY resolution is async. Wrapping the durable-engine
      // handle (already fully built by the time this resolver settles) in a
      // one-shot synthetic agent reuses its buffering/abort-forwarding
      // machinery instead of reimplementing it.
      const resolveDurableAgent = async (): Promise<RunnableAgent<unknown, boolean>> => {
        let resolvedOptions: RunOptions;
        try {
          // Invoked through `definitionResolvingAgent`, not as a bare
          // extracted `resolver(...)` call — a resolver implemented as a
          // method reading instance state via `this` (a custom
          // `DefinitionResolvingAgent`, not necessarily `createAgent`'s own
          // arrow-function implementation) would otherwise lose its receiver
          // under strict-mode ESM. Matches `createLazyAgent`'s own resolver
          // forwarding for the same reason.
          resolvedOptions = await definitionResolvingAgent[OPERATIVE_RESOLVE_RUN_OPTIONS]!(
            input,
            context,
          );
        } catch (error) {
          // Review round 2 (Codex): `typeof resolver === 'function'` above
          // is true for EVERY `createLazyAgent`-wrapped agent unconditionally
          // — the wrapper always exposes this symbol as a proxy that only
          // discovers, once actually invoked, whether the module it loads
          // supports durable resolution at all. A lazy-wrapped agent whose
          // real underlying agent does NOT support it would otherwise always
          // be routed into this durable branch and fail here, even though
          // the exact same agent registered eagerly correctly falls back to
          // direct dispatch (see the "falls back to direct execution" test
          // above). `AgentContractError` is the established convention this
          // codebase already throws for "this capability is not supported"
          // (both here and inside `createLazyAgent`'s own resolver) — catch
          // exactly that class and fall back to the ORIGINAL catalog agent's
          // own `run()`, matching what direct registration would have done.
          // Anything else is a genuine resolver failure and must propagate.
          if (error instanceof AgentContractError) {
            return agent;
          }
          throw error;
        }
        const activeRun = createActiveRun(resolvedOptions, {
          engine: durable.engine,
          checkpointStore: durable.checkpointStore,
          runId,
          sessionId: runOptions?.sessionId ?? runId,
        });
        dispatchedActiveRun = activeRun;
        if (cancellationRequested) {
          if (cancellationRequested.dispose) {
            activeRun[Symbol.dispose]();
          } else {
            activeRun.abort(cancellationRequested.reason);
          }
        }
        const agentRun = createAgentRun<unknown, boolean>(activeRun, {
          hasOutput: resolvedOptions.output !== undefined,
        });
        return { name, run: () => agentRun };
      };
      const deferredRun = createDeferredAgentRun(resolveDurableAgent, input, context, name);
      const guardedRun: AgentRun<unknown, boolean> = {
        ...deferredRun,
        abort(reason?: string): void {
          deferredRun.abort(reason);
          if (dispatchedActiveRun) {
            // No-op if `activeRun.abort()` already ran via the normal
            // `underlying.abort()` forwarding path — `AbortController.abort()`
            // (what `ActiveRun.abort()` calls under the hood) is idempotent.
            dispatchedActiveRun.abort(reason);
          } else if (!cancellationRequested) {
            cancellationRequested = { reason, dispose: false };
          }
        },
        [Symbol.dispose](): void {
          deferredRun[Symbol.dispose]();
          if (dispatchedActiveRun) {
            dispatchedActiveRun[Symbol.dispose]();
          } else if (!cancellationRequested) {
            cancellationRequested = { reason: undefined, dispose: true };
          }
        },
      };
      return trackCatalogRun(guardedRun);
    }

    // Review round 2 (Codex): a hand-written catalog RunnableAgent is a
    // valid entry, and one whose run() throws synchronously during per-run
    // setup must still settle through the returned handle, not escape as a
    // synchronous throw from bureau.run() itself — AB-22's synchronous-throw
    // allowlist is unknown name / disposed / malformed input-options only.
    // `createDeferredAgentRun` already contains exactly this "resolveAgent's
    // run() throws synchronously" handling (built for createLazyAgent's own
    // resolved-module case, agnostic to why); reusing it here for an
    // already-resolved agent avoids duplicating that state machine. The one
    // externally observable cost is that `agent.run()` itself is invoked one
    // microtask later than before — compatible with the contract, which
    // promises a synchronous RETURN of the handle, not synchronous START of
    // the agent's own work.
    return trackCatalogRun(
      createDeferredAgentRun(() => Promise.resolve(agent), input, context, name),
    );
  }

  async function createRunFromRequest(request: CreateRunRequest): Promise<RunSummary> {
    validateCreateRunRequest(request);

    if (!runtime.ready) {
      throw new BureauError('No generate function configured', 'NOT_CONFIGURED', 'generate');
    }

    const sessionId = request.sessionId?.trim() ?? crypto.randomUUID();
    const runId = `run-${crypto.randomUUID()}`;
    const agentName = request.agentName ?? BUREAU_AGENT_NAME;
    const requestContext = normalizeRunRequestContext(
      request.requestContext,
      runId,
      agentName,
      request.principal,
    );
    if (isTransportIssuedAuthority(requestContext)) {
      if (!requestAuthorityValidator) {
        throw new BureauError(
          'Cannot create run: transport-issued request authority cannot be validated.',
          'CONFLICT',
        );
      }
      if (!(await requestAuthorityValidator(requestContext))) {
        throw new BureauError(
          'Cannot create run: request authority is no longer current.',
          'CONFLICT',
        );
      }
    }

    // AB-13 — admit BEFORE any session/runtime work: createRun returns
    // synchronously right after the run starts (it does not await
    // completion), so admission is a synchronous pre-gate — over-cap or
    // rate-limited or duplicate triggers are rejected outright, not queued.
    if (flowController) {
      const decision = flowController.admit({
        runId,
        agentName,
        source: 'api',
        message: request.message,
        sessionId,
        ...(request.principal !== undefined ? { principal: request.principal } : {}),
      });
      if (!decision.allowed) {
        throw new BureauError(
          `Run rejected by flow control policy (${decision.reason})`,
          'RATE_LIMITED',
        );
      }
    }

    // AB-13 — everything below stays INLINE in this same function (not a
    // separately-awaited helper): an extra `await helper(...)` layer would
    // add a microtask hop before `createRun` resolves back to the caller,
    // shifting how much of the in-memory loop's own internal scheduling has
    // run by the time a caller can first call `abortRun()` — existing
    // abort-timing tests depend on that not moving. try/catch alone adds no
    // such hop, so it is the release mechanism here.
    try {
      const { session, conversation } = await loadConversation(sessionId);
      const baseConversationHistory = conversation.current;

      if (!session) {
        const prompt = request.systemPrompt ?? runtime.systemPrompt;
        if (prompt) {
          conversation.appendSystemMessage(prompt);
        }
      }

      conversation.appendUserMessage(request.message);

      // AB-54 usage analytics: resolve agentName/principal deterministically now
      // (before `store.register`, so it's in place before any listRuns()/getRun()
      // call can observe this run) rather than relying on the tool-bubble-event
      // heuristic, which cannot see a run that never calls a tool.
      runAttribution.set(runId, {
        agentName,
        ...(request.principal !== undefined ? { principal: request.principal } : {}),
      });
      const runRuntime = await runtime.createRunRuntime({
        ...request,
        sessionId,
        runId,
        requestContext,
      });
      runRequestContexts.set(runId, requestContext);

      const disposeStreamListeners: Array<() => void> = [];
      const streamEventTarget = runRuntime.streamEventTarget;
      if (streamEventTarget) {
        disposeStreamListeners.push(
          wireStreamEventTargetFrames(streamEventTarget, runId, emitLiveFrame, nextRunSeq),
        );
      }

      await saveSession(
        sessionId,
        conversation,
        {
          lastRunId: runId,
          lastRunStatus: 'running',
          lastUserMessage: request.message,
          // Always write these keys (null when absent) so a reused session never
          // inherits a stale cap from a previous run. A conditional spread would leave
          // the old value in place when the request omits the field; null is treated as
          // "unset" by buildRunDepsFromSession (it gates on typeof === 'number'),
          // so null is a safe sentinel for "caller did not specify a cap" (PRRT_kwDORvupsc6MZ1Mb).
          lastMaximumTokens: request.maximumTokens ?? null,
          // Persist the per-request step cap too, so a recovered run honours the
          // caller's maximumSteps instead of falling back to the bureau default
          // (PRRT_kwDORvupsc6MZfl5 — mirror of the maximumTokens recovery fix).
          lastMaximumSteps: request.maximumSteps ?? null,
          // Reset the active-skill snapshot at the start of every run so a reused
          // session never seeds a fresh run with the PREVIOUS run's active skills.
          // The snapshot is otherwise written only by createSkillStateSnapshotHook
          // after the run's first onStep boundary; if the durable process crashes
          // before that first snapshot, recovery would read this session's stale
          // lastActiveSkills and pre-seed the new run's SkillSession with skills a
          // live fresh run would not have — making load_skill_resource/list_skills
          // treat stale skills as active. null clears it: buildRunDepsFromSession
          // runs lastActiveSkills through isActiveSkillEntryArray, which rejects
          // null → initialActiveSkills undefined → the recovered run starts empty,
          // exactly as a fresh run would (PRRT_kwDORvupsc6Mddv3).
          lastActiveSkills: null,
          // Durable recovery needs the authority that was safe to persist at
          // dispatch time. Credentials, tracing, and other request-local data
          // intentionally never cross the session boundary.
          lastRequestAuthority: {
            agentId: agentName,
            principalId: requestContext.authority.principalId,
            tenantId: requestContext.authority.tenantId,
            ownerId: requestContext.authority.ownerId,
            capabilities: [...requestContext.authority.capabilities],
            authorizationRevision: requestContext.authority.authorizationRevision,
            ...(requestContext.audience !== undefined ? { audience: requestContext.audience } : {}),
            ...(requestContext.deadline !== undefined ? { deadline: requestContext.deadline } : {}),
          },
          lastRequestAuthorities: {
            [runId]: {
              agentId: agentName,
              principalId: requestContext.authority.principalId,
              tenantId: requestContext.authority.tenantId,
              ownerId: requestContext.authority.ownerId,
              capabilities: [...requestContext.authority.capabilities],
              authorizationRevision: requestContext.authority.authorizationRevision,
              ...(requestContext.audience !== undefined
                ? { audience: requestContext.audience }
                : {}),
              ...(requestContext.deadline !== undefined
                ? { deadline: requestContext.deadline }
                : {}),
            },
          },
        },
        // Stamp the session with the dispatched agent (PRRT_kwDORvupsc6MbUsN) so it
        // is not always recorded as the house default 'bureau'.
        request.agentName,
        baseConversationHistory,
      );

      // F3 — opt-in `requestHumanInput` wiring for a REAL durable run
      // (`options.humanInput`). This closes the tracked wiring gap: the tool's
      // mutable `pendingHumanWait` slot must be the EXACT object Weft hands
      // back as `ctx.services` (durable's own per-run deps), and its
      // `HumanWaitParkedEvent` dispatch must land on the EXACT emitter this
      // run's `ActiveRun` exposes — neither exists until `createActiveRun`
      // constructs them below, and both are internal to the durable adapter.
      // `emitter` is threaded in directly (built here, handed to
      // `createActiveRun` to use instead of minting its own); the
      // `ctx.services` reference is captured via `onServices`, a synchronous
      // hook the durable adapter fires immediately before `engine.start` —
      // see `DurableActiveRunOptions.onServices` in operative for why this is
      // the only point such a reference can be obtained. Once captured, the
      // tool's `pendingHumanWait` setter forwards onto it, so a real
      // `requestHumanInput` call actually parks the workflow AND fires an
      // observable event — reaching the `activeRun.addEventListener(
      // HumanWaitParkedEvent.type, …)` listener below (AB-13 `markParked`)
      // and `store`'s action log (AB-20 `listPendingReviews`).
      let humanInputEmitter: CompletableEventTarget<CombinedOperativeEventMap> | undefined;
      let humanInputOnServices: ((services: DurableRunDeps) => void) | undefined;
      let runToolbox: BureauToolbox = runRuntime.toolbox;
      if (options.humanInput && runtime.durable) {
        const servicesRef: { current?: DurableRunDeps } = {};
        humanInputEmitter = new CompletableEventTarget<CombinedOperativeEventMap>();
        const humanWaitContext = createHumanWaitContext(servicesRef, runId);
        const rawHumanInputTool = createRequestHumanInputTool({
          context: humanWaitContext,
          emitter: humanInputEmitter,
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
            execute: async (input) => await Promise.resolve(rawHumanInputTool.execute(input)),
          }),
        ]);
        runToolbox = combineToolboxes(runRuntime.toolbox, humanInputToolbox);
        humanInputOnServices = (services) => {
          servicesRef.current = services;
        };
      }

      const activeRun = createActiveRun(
        {
          generate: runRuntime.generate,
          toolbox: runToolbox,
          conversation,
          maximumSteps: request.maximumSteps ?? runtime.maximumSteps,
          maximumTokens: request.maximumTokens,
          stopWhen: options.stopWhen,
          prepareStep: runRuntime.prepareStep,
          onStep: [
            ...runRuntime.onStep,
            async (stepResult) => {
              for (const stepResultItem of stepResult.results) {
                if (
                  stepResultItem.outcome !== 'action_required' ||
                  !stepResultItem.pendingApproval
                ) {
                  continue;
                }
                const reviewId = `approval:${runId}:${stepResultItem.pendingApproval.callId}`;
                pendingApprovalOverrides.set(reviewId, stepResultItem.pendingApproval);
                await persistPendingApprovalOverrideWithRetry(
                  sessionId,
                  reviewId,
                  stepResultItem.pendingApproval,
                );
              }
            },
          ],
          executeOptions: { requestContext },
          validateResponse: runRuntime.validateResponse,
          // Thread agentName and runId so curated tool.* bubble events are stamped
          // with {agentName, runId, step} metadata (C3) and durable launch input
          // carries the owning agent for audit/recovery attribution (F2). Fall back
          // to BUREAU_AGENT_NAME when the request omits it, matching the agent the
          // session is stamped with — otherwise the durable input + tool events
          // carry an empty agentName while the session says 'bureau'.
          agentName,
          runId,
        },
        // Route through the durable engine when one was composed (durableExecution
        // + storage). The conversation already carries the seeded user/system
        // messages, so no separate `prompt` is passed — the workflow snapshots it.
        // The run is then checkpointed and resumes from its last step after a crash.
        runtime.durable
          ? {
              engine: runtime.durable.engine,
              checkpointStore: runtime.durable.checkpointStore,
              runId,
              // Carry the owning session in the durable input so boot recovery can
              // correlate a recovered handle back to its session without a side
              // table (see recoverDurableRuns / resolveRunServices).
              sessionId,
              ...(humanInputEmitter ? { emitter: humanInputEmitter } : {}),
              ...(humanInputOnServices ? { onServices: humanInputOnServices } : {}),
            }
          : undefined,
      );
      activeRuns.add(activeRun);
      runToolboxes.add(runToolbox);
      runToolboxesByRunId.set(runId, runToolbox);
      // AB-96 — the versioned run-lifecycle frame stream. Registered before
      // `store.register` so `run-started` is the first frame a live subscriber
      // ever sees for this run.
      const disposeRunFrameForwarder = createRunFrameForwarder(
        runId,
        activeRun,
        (frame) => emitLiveFrame({ type: 'run-envelope', runId, frame }),
        { streamEventTarget },
      );
      disposeStreamListeners.push(disposeRunFrameForwarder);
      emitLiveFrame({
        type: 'run-envelope',
        runId,
        frame: createRunStartedFrame({
          runId,
          sessionId,
          agentName,
        }),
      });

      // AB-13 — free this run's concurrency slot while it is parked on a
      // human-wait signal; `HumanWaitParkedEvent` fires on the SAME emitter
      // `store.register` subscribes to below, so this observes both the
      // in-memory and durable paths identically.
      if (flowController) {
        activeRun.addEventListener(HumanWaitParkedEvent.type, () => {
          flowController.markParked(runId);
        });
      }

      activeRun.once('run.completed', (event) => {
        activeRuns.delete(activeRun);
        runToolboxes.delete(runToolbox);
        disposeRegisteredStreamListeners(disposeStreamListeners);
        flowController?.settle(runId);
        queueMicrotask(() => releaseTerminalRunReviewState(runId));

        const finishReason = event.finishReason;
        const lastRunStatus = isRunFailureFinishReason(finishReason) ? 'error' : 'completed';

        const report = buildTerminalReportFromCompletedEvent(runId, event);
        runReports.set(runId, report);
        emitLiveFrame({
          type: 'run-envelope',
          runId,
          frame: createRunFinishedFrame({ runId, report }),
        });

        persistSessionUpdate(
          () =>
            saveSession(
              sessionId,
              event.conversation,
              {
                lastRunId: runId,
                lastRunStatus,
                lastFinishReason: event.finishReason,
                ...(isRunFailureFinishReason(event.finishReason)
                  ? { lastError: serializeUnknownError(event.error) }
                  : {}),
              },
              request.agentName,
              baseConversationHistory,
            ),
          {
            runId,
            sessionId,
            status: lastRunStatus,
          },
        );
      });

      activeRun.once('run.aborted', (event) => {
        activeRuns.delete(activeRun);
        runToolboxes.delete(runToolbox);
        disposeRegisteredStreamListeners(disposeStreamListeners);
        flowController?.settle(runId);
        queueMicrotask(() => releaseTerminalRunReviewState(runId));

        const report = buildTerminalReportFromAbortedEvent(runId, {
          usage: event.usage,
          costEstimate: event.costEstimate,
          reason: event.reason,
          error: event.error,
          steps: store.getRun(runId)?.steps ?? [],
          conversation: event.conversation,
        });
        runReports.set(runId, report);
        emitLiveFrame({
          type: 'run-envelope',
          runId,
          frame: createRunFinishedFrame({ runId, report }),
        });

        persistSessionUpdate(
          () =>
            // Persist the conversation carried on the abort event, NOT the
            // launch-time `conversation` closure. On the durable path the workflow
            // mutates per-step checkpoint snapshots, so a run that aborts after
            // checkpointed steps (e.g. when engine.cancel() wins the abort race)
            // reconstructs its abort RunResult from the checkpoint — the event's
            // conversation reflects those steps, whereas the closure still holds
            // only the seed transcript. For the in-memory loop the event carries
            // the same mutated instance, so this is correct on both paths.
            saveSession(
              sessionId,
              event.conversation,
              {
                lastRunId: runId,
                lastRunStatus: 'aborted',
                // Write lastFinishReason too so an aborted session's metadata is
                // internally consistent (status + finishReason agree) and a prior
                // run's stale lastFinishReason on the same session can't linger. This
                // is also what boot recovery now relies on: a recovered run that
                // aborts settles through THIS listener (settleRecoveredRun is gone),
                // so the field must be written here, not only on the old recovery path.
                lastFinishReason: 'aborted',
                lastError: serializeUnknownError(event.error),
              },
              request.agentName,
              baseConversationHistory,
            ),
          {
            runId,
            sessionId,
            status: 'aborted',
          },
        );
      });

      activeRun.once('run.error', (_event) => {
        activeRuns.delete(activeRun);
        runToolboxes.delete(runToolbox);
        disposeRegisteredStreamListeners(disposeStreamListeners);
        flowController?.settle(runId);
        queueMicrotask(() => releaseTerminalRunReviewState(runId));
      });

      store.register(activeRun, runId);
      runSessionIdentifiers.set(activeRun, sessionId);

      return serializeRunState(store.getRun(runId)!, sessionId);
    } catch (error) {
      // The run never reached `store.register` (and therefore never fired a
      // terminal event to settle through) — release whatever this admission
      // claimed so it does not leak a phantom concurrency/singleton hold.
      flowController?.settle(runId);
      runRequestContexts.delete(runId);
      runAttribution.delete(runId);
      throw error;
    }
  }

  /**
   * Reattach one run RECOVERED by `engine.recoverAll()` to the live surface
   * (closes seam #5b). Builds a {@link reattachDurableActiveRun} adapter over the
   * already-running handle, wires the SAME terminal session-persistence listeners
   * the live-run path uses (so a recovered run's `getRun(...)` + session status
   * behave exactly like a never-crashed one), and `store.register`s it.
   *
   * Synchronous by construction (no `await` before `store.register`): the adapter
   * defers its `handle.result()` await onto a microtask, so registration +
   * `runSessionIdentifiers.set` complete in this turn BEFORE any terminal event
   * fires — even for a handle that already settled. So `getRun(runId)` resolves
   * the instant this returns and no subscriber misses the terminal event.
   *
   * Idempotent: skips a `runId` already live on this process (the store uses a
   * plain `Map.set`, which would silently overwrite + split-brain a double
   * register). `recoverDurableRuns` is itself boot-single-shot; this is defense.
   */
  function reattachRecoveredRun(
    runId: string,
    sessionId: string,
    handle: RecoveredRunHandle,
    eventSurface?: ReturnType<typeof createRecoveredRunEventSurface>,
    recoveredServices?: DurableRunDeps,
    sessionMetadata?: unknown,
  ): void {
    // At-most-once registration per runId (guards double-recover / a runId already
    // started live on this process — neither should reach here, but a silent
    // Map.set overwrite would be a split-brain, so cheap-guard it).
    if (store.getRun(runId)) {
      return;
    }

    const recoveredRun = reattachDurableActiveRun(
      { engine: runtime.durable!.engine, checkpointStore: runtime.durable!.checkpointStore },
      {
        runId,
        handle,
        ...(eventSurface
          ? {
              emitter: eventSurface.emitter,
              stopToolboxForward: eventSurface.stopToolboxForward,
              abort: eventSurface.abort,
            }
          : {}),
      },
    );
    if (recoveredServices) {
      const recoveredRequestContext = recoveredServices.options.executeOptions?.requestContext;
      if (recoveredRequestContext) {
        runRequestContexts.set(runId, recoveredRequestContext);
        recoveredRunIds.add(runId);
      }
      runToolboxesByRunId.set(runId, recoveredServices.toolbox);
    }
    restoreResolvedReviewIds(sessionMetadata, runId);
    restorePendingApprovalOverrides(sessionMetadata, runId);

    // AB-96 — wire the same versioned run-envelope forwarder the live-run path
    // uses. The recovered run's event surface is installed during Weft's awaited
    // recovery hook, before resumed user code advances, and `recoveredRun`'s
    // `addEventListener` is bound to that identical emitter — so subscribing
    // here surfaces every `step`/`tool-pre`/`tool-post`/notification frame a
    // resumed run produces, not just its terminal `run-finished`. No
    // `streamEventTarget` is threaded through recovery (enhanced streaming is a
    // fresh-run-only concern), so `assistant-chunk` frames are the one frame
    // type a resumed run never emits.
    const disposeRecoveredRunFrameForwarder = createRunFrameForwarder(
      runId,
      recoveredRun,
      (frame) => emitLiveFrame({ type: 'run-envelope', runId, frame }),
    );

    // Persist terminal session status from the recovered run's OWN terminal
    // events — the same fields the live-run listeners write. The conversation
    // comes from `event.conversation`, which the reattach adapter reconstructs
    // from the checkpoint (so completed steps from the resumed process are
    // included), preserving the old `settleRecoveredRun`'s checkpoint-preferred
    // conversation behavior. A run the engine failed pre-replay (services
    // unavailable) or one interrupted by teardown fires NO terminal event — the
    // adapter stays write-free for those and the resolver/teardown owns the
    // session status; so these listeners only run for a genuinely settled run.
    recoveredRun.once('run.completed', (event) => {
      activeRuns.delete(recoveredRun);
      disposeRecoveredRunFrameForwarder();
      const completedConversation = event.conversation;
      const finishReason = event.finishReason;
      const lastRunStatus = isRunFailureFinishReason(finishReason) ? 'error' : 'completed';
      const lastError = isRunFailureFinishReason(finishReason) ? event.error : undefined;

      const report = buildTerminalReportFromCompletedEvent(runId, event);
      runReports.set(runId, report);
      emitLiveFrame({
        type: 'run-envelope',
        runId,
        frame: createRunFinishedFrame({ runId, report }),
      });

      persistSessionUpdate(
        () =>
          saveSession(sessionId, completedConversation, {
            lastRunId: runId,
            lastRunStatus,
            lastFinishReason: finishReason,
            ...(isRunFailureFinishReason(finishReason)
              ? { lastError: serializeUnknownError(lastError) }
              : {}),
          }),
        { runId, sessionId, status: lastRunStatus },
      );
    });

    recoveredRun.once('run.aborted', (event) => {
      activeRuns.delete(recoveredRun);
      disposeRecoveredRunFrameForwarder();
      const abortedConversation = event.conversation;

      const report = buildTerminalReportFromAbortedEvent(runId, {
        usage: event.usage,
        costEstimate: event.costEstimate,
        reason: event.reason,
        error: event.error,
        steps: store.getRun(runId)?.steps ?? [],
        conversation: event.conversation,
      });
      runReports.set(runId, report);
      emitLiveFrame({
        type: 'run-envelope',
        runId,
        frame: createRunFinishedFrame({ runId, report }),
      });

      persistSessionUpdate(
        // The reattach adapter reconstructs the abort RunResult from the run's
        // final checkpoint and threads it into RunAbortedEvent.conversation, so
        // use that directly instead of re-fetching the checkpoint snapshot.
        () =>
          saveSession(sessionId, abortedConversation, {
            lastRunId: runId,
            lastRunStatus: 'aborted',
            lastFinishReason: 'aborted',
            lastError: serializeUnknownError(event.error),
          }),
        { runId, sessionId, status: 'aborted' },
      );
    });

    // Seed the runSeq generation before `store.register` wires the action
    // subscription that starts stamping frames — see `seedRunSeqGeneration`.
    seedRunSeqGeneration(runId);
    store.register(recoveredRun, runId);
    activeRuns.add(recoveredRun);
    runSessionIdentifiers.set(recoveredRun, sessionId);

    // AB-12 — stamp a `workflow.reattached` marker into this run's action
    // log so the run-inspector timeline shows the recovery/reattach boundary.
    // Reattachment happens BEFORE `store.register`'s observable subscription
    // exists (recovery itself never fires as a run event), so there is no
    // other way for this transition to reach the sequenced action log.
    // `recordAction` is called synchronously right after `register`, so it
    // gets the lowest sequence number of this run's post-reattach actions —
    // it always precedes whatever the resumed generator emits next.
    const versionMismatch = runtime.workflowVersionMismatches.get(runId);
    store.recordAction(runId, 'workflow.reattached', {
      sessionId,
      versionMismatch: versionMismatch !== undefined,
      ...(versionMismatch ?? {}),
    });
  }

  /**
   * Boot-time recovery for durable runs (seams #2, #3/#5b, #5). Resumes any
   * `agentRun` workflows a previous process left in flight via
   * `engine.recoverAll()`. Interactive bureau-owned runs reattach as live
   * `ActiveRun`s; native scheduled fires stay monitor-only because they have no
   * interactive session ownership or live run surface.
   *
   * #2 — no side table. Each recovered run's owning session is read from the
   * handle's own launch metadata (`handle.getLaunchMetadata().input.sessionId`,
   * which the run carried in its durable input), not from a pre-built
   * runId→sessionId scan of the session store. The deps a recovered run needs are
   * re-provided lazily by the engine's `resolveWorkflowServices` resolver
   * (`resolveRunServices`) before its generator advances — no pre-injection, no
   * module-global registry.
   *
   * #3/#5b — live visibility. Weft's awaited `onRecoveredWorkflow` hook wraps
   * each owned handle in a {@link reattachRecoveredRun} adapter and registers it
   * before resumed user code advances, so per-step events, live subscribers, and
   * terminal session persistence all share the same recovered event surface.
   *
   * Boot returns once `recoverAll()` has STARTED the handles and they are
   * registered, not when they complete: a recovered run that resumes into a long
   * model call must not hold the bureau hostage. Each adapter awaits its result
   * detached.
   *
   * Fail-safe: a run whose deps the resolver cannot rebuild is failed terminally
   * by the engine BEFORE replay (the resolver reconciles its session to `error`
   * synchronously, with the sessionId in hand); its reattached handle then rejects
   * and the adapter stays write-free, so the resolver's status is authoritative.
   * A scheduled fire whose launch metadata narrows to a marker-bearing
   * `ScheduledAgentRunInput` is not cancelled for lacking `runId` / `sessionId`
   * ownership. Its services are rebuilt by `resolveRunServices`'s scheduled
   * branch, and its scheduled session write-back hook owns transcript persistence.
   * Recovery attaches only a detached result monitor so failures are visible.
   *
   * A non-scheduled run whose launch metadata lacks a `sessionId` (checkpointed
   * before #2, or not bureau-owned) is skipped — there is no compatibility
   * fallback for cross-upgrade in-flight runs.
   *
   * KNOWN SEAM — durable scheduler runs (#7b) are NOT cross-process recoverable.
   * A durable scheduler task (durable scheduler enabled) runs as an `agentRun`
   * workflow in this SAME engine with `sessionId === runId` (a synthetic
   * `scheduler-run-…` id), and the durable run path does NOT write a session
   * record (only the bureau's interactive `runDurable` path persists sessions).
   * So if the process crashes with a scheduler run in flight, `recoverAll()`
   * surfaces it here, but `resolveRunServices` finds no session for its synthetic
   * id → returns `unavailable` → the engine fails it clean before replay. The
   * reattached handle then rejects and the adapter stays write-free. Net: scheduler
   * durable runs are SAME-PROCESS suspend/resume only (their value — preemption
   * preserves progress within a live process); they surface briefly on recovery
   * and fail clean rather than resuming. This is intentional, not a gap:
   * cross-process recovery of scheduler tasks would require persisting a session
   * per task, which the in-process scheduler deliberately does not do.
   */
  /**
   * Cancel suspended scheduler-origin durable runs left behind by a hard crash
   * (#25). A preempted scheduler task is parked `suspended`, and its only live
   * pointer is the in-memory queue entry — lost on crash. `recoverAll()` never
   * surfaces a suspended run (suspended ≠ running), so without this sweep the
   * workflow and its checkpoints dangle in storage forever. This sweep is the
   * SOLE protection against a reused scheduler id colliding with suspended residue
   * (`onTerminalConflict: 'start-new'` covers only TERMINAL conflicts), so it must
   * be COMPLETE — it pages until no suspended scheduler runs remain rather than
   * stopping at a cap (a partial sweep would leave an unsafe collision).
   *
   * TOCTOU: cancelling a run flips it suspended→cancelled and shrinks the next
   * page's `total`, which would terminate a per-page-cancel loop early and
   * under-cancel. So we COLLECT every id across all pages FIRST, then cancel.
   *
   * A high sanity bound guards against a pathological/runaway backlog (or a
   * mis-paginating store): if it is hit, the sweep FAILS LOUD (throws) rather than
   * silently truncating and continuing in an unsafe state — the caller's boot
   * try/catch logs it, and the operator sees a clear signal instead of a quiet
   * partial sweep.
   */
  async function sweepSuspendedSchedulerRuns(
    engine: NonNullable<typeof runtime.durable>['engine'],
  ) {
    const PAGE_SIZE = 100;
    // Sanity cap on TOTAL pages — far above any plausible suspended-residue count.
    // Hitting it means something is wrong (a runaway backlog or a store that is
    // not advancing), so we throw rather than truncate.
    const MAX_PAGES = 10_000;
    const ids: string[] = [];
    let offset = 0;

    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        throw new Error(
          `[bureau] Suspended scheduler-run sweep exceeded ${MAX_PAGES} pages ` +
            `(${MAX_PAGES * PAGE_SIZE}+ runs) without draining — aborting boot recovery ` +
            `rather than leaving suspended residue that could collide with a reused id.`,
        );
      }
      // Match by the synthetic-id PREFIX, not the origin TAG: suspended
      // `scheduler-run-*` residue left by an earlier release carries the prefix
      // (and phantom sessionId) but may not carry the tag, and a tag-only filter
      // would never collect it (Bugbot #38). The id format is release-stable, so
      // the prefix catches both legacy and new residue. The tag remains the
      // primary recovery-time discriminant in the resolver via Weft's launch
      // context; this prefix sweep is legacy cleanup for untagged residue.
      // Pagination lives on ListFilter.
      const result = await engine.list({
        status: 'suspended',
        idPrefix: SCHEDULER_RUN_ID_PREFIX,
        limit: PAGE_SIZE,
        offset,
      });
      for (const summary of result.items) {
        ids.push(summary.id);
      }
      offset += result.items.length;
      if (offset >= result.total || result.items.length === 0) {
        break;
      }
    }

    if (ids.length === 0) return;

    const outcomes = await Promise.allSettled(ids.map((id) => engine.cancel(id)));
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Failed to cancel suspended scheduler run "${ids[index]!}": ${serializeUnknownError(outcome.reason)}`,
        });
      }
    });
  }

  /**
   * Reattach an owned interactive run inside Weft's awaited recovery hook. At
   * this point the resolver has rebuilt `services`, but the recovered workflow
   * has not advanced, so the ActiveRun surface and all event forwarding exist
   * before the first resumed step can emit anything.
   */
  async function onRecoveredWorkflow(info: RecoveredWorkflowInfo): Promise<void> {
    if (
      !isAgentRunWorkflowInput(info.input) ||
      info.input.runId !== info.workflowId ||
      !runtime.sessionStore ||
      store.getRun(info.workflowId)
    ) {
      return;
    }

    let sessionLoad: SessionLoadOutcome;
    try {
      const session = await runtime.sessionStore.load(info.input.sessionId);
      sessionLoad = { ok: true, session: session ? { ...session.metadata } : null };
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not load owning session for recovered run "${info.workflowId}"; leaving it to resume without live visibility: ${serializeUnknownError(error)}`,
      });
      return;
    }

    const verdict = classifyRecoveredRun({
      handleId: info.workflowId,
      scheduledFire: false,
      ownedSessionId: info.input.sessionId,
      metadataReadFailed: false,
      hasSessionStore: true,
      sessionLoad,
      versionMismatch: runtime.workflowVersionMismatches.has(info.workflowId),
    });
    if (verdict !== 'reattach' && verdict !== 'reattach-version-mismatch') return;

    if (verdict === 'reattach-version-mismatch') {
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Reattaching recovered run "${info.workflowId}" that resumed under a ` +
          `different workflow version than it was checkpointed with (pin-and-warn; ` +
          `see documentation/workflow-versioning.md).`,
      });
    }
    if (info.services === undefined || info.services === null) {
      throw new Error(`Recovered run "${info.workflowId}" has no reconstructed services`);
    }

    const services = info.services as DurableRunDeps;
    const eventSurface = createRecoveredRunEventSurface(
      services,
      info.workflowId,
      info.input.agentName,
    );
    await restorePendingApprovalStates(
      services.toolbox,
      sessionLoad.session,
      info.workflowId,
      info.input.sessionId,
    );
    reattachRecoveredRun(
      info.workflowId,
      info.input.sessionId,
      info.handle,
      eventSurface,
      info.services as DurableRunDeps,
      sessionLoad.session,
    );
  }

  async function recoverDurableRuns(): Promise<void> {
    if (!runtime.durable) return;

    const durable = runtime.durable;

    // Sweep suspended scheduler-origin residue FIRST and UNCONDITIONALLY (not
    // gated on a session store): a hard crash with a preempted scheduler task in
    // `suspended` leaves a workflow that recoverAll() never surfaces (suspended ≠
    // running) and that would otherwise dangle forever. A durable-scheduler-only
    // deployment (no bureau session store) still needs this. It also clears
    // suspended runs whose ids could collide with a fresh dispatch's reused
    // counter id — onTerminalConflict:'start-new' does NOT cover suspended (only
    // terminal), so the sweep is the sole protection against that collision.
    //
    // The sweep is isolated in its own try/catch: a sweep failure (its
    // sanity-cap throw, or a storage error) is logged LOUDLY but must NOT block
    // session-run reattach below — a pathological suspended-scheduler backlog
    // should not also strand every genuine session run's recovery.
    try {
      await sweepSuspendedSchedulerRuns(durable.engine);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Suspended scheduler-run sweep failed; session-run recovery continues: ${serializeUnknownError(error)}`,
      });
    }

    // recoverAll resumes the in-flight workflows (firing the services resolver per
    // run before each generator advances); if it throws, the boot try/catch logs
    // and continues.
    const handles = await durable.engine.recoverAll({ onRecoveredWorkflow });

    // Read each handle's launch metadata CONCURRENTLY, so one slow/stuck read does
    // not block registration of the rest (no head-of-line blocking). The read is
    // caught PER HANDLE so the resolved value always carries the handle identity —
    // a rejected read must not lose the handle, or we could not cancel the
    // now-resumed-but-unidentifiable run (committee round-2 finding 1). Then
    // reattach each owned handle SYNCHRONOUSLY in one turn, preserving the
    // register-before-terminal-event ordering invariant.
    const resolved = await Promise.all(
      handles.map(async (handle) => {
        try {
          return { handle, metadata: await handle.getLaunchMetadata() };
        } catch (error) {
          return { handle, metadata: null, error };
        }
      }),
    );

    const orphanCancellations: Array<{ runId: string; cancel: Promise<void> }> = [];
    const sessionStore = runtime.sessionStore;
    for (const { handle, metadata, ...rest } of resolved) {
      // The awaited recovery hook already registered owned interactive runs
      // before replay. The post-recovery pass only classifies the remaining
      // handles (scheduled fires, orphans, and unknown ownership).
      if (store.getRun(handle.id)) continue;

      const readError = 'error' in rest ? rest.error : undefined;
      if (readError !== undefined) {
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Could not read launch metadata for recovered run "${handle.id}"; cancelling: ${serializeUnknownError(readError)}`,
        });
      }

      // A run is bureau-owned only if its launch metadata narrows to an agentRun
      // input AND its input runId matches this handle's id (the workflow id is the
      // run id).
      const ownedSessionId =
        readError === undefined &&
        metadata &&
        isAgentRunWorkflowInput(metadata.input) &&
        metadata.input.runId === handle.id
          ? metadata.input.sessionId
          : undefined;

      const recoveredScheduleMarker =
        readError === undefined &&
        metadata != null &&
        !isAgentRunWorkflowInput(metadata.input) &&
        isScheduledAgentRunInput(metadata.input) &&
        !isRecoverableScheduledFireInput(metadata.input)
          ? await loadScheduleIdForRecoveredRun(durable.engine, handle.id)
          : undefined;
      let recoveredScheduledSessionId: string | undefined;
      if (
        recoveredScheduleMarker !== undefined &&
        recoveredScheduleMarker.status !== 'found' &&
        sessionStore &&
        metadata != null &&
        isScheduledAgentRunInput(metadata.input)
      ) {
        try {
          recoveredScheduledSessionId = await loadExistingScheduledSessionId(
            sessionStore,
            metadata.input,
            handle.id,
          );
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not inspect scheduled session proof for recovered run "${handle.id}"; continuing without scheduled-fire classification: ${serializeUnknownError(error)}`,
          });
        }
      }
      const scheduledFire =
        readError === undefined &&
        metadata != null &&
        !isAgentRunWorkflowInput(metadata.input) &&
        (isRecoverableScheduledFireInput(metadata.input) ||
          recoveredScheduleMarker?.status === 'found' ||
          recoveredScheduledSessionId !== undefined);

      // Load the owning session (only meaningful for an owned run with a store).
      // A throw leaves ownership UNKNOWN — classifyRecoveredRun then skips rather
      // than cancels, so a transient read blip never terminates a legitimately
      // recovering run.
      let sessionLoad: SessionLoadOutcome = { ok: true, session: null };
      if (ownedSessionId !== undefined && sessionStore) {
        try {
          const session = await sessionStore.load(ownedSessionId);
          sessionLoad = { ok: true, session: session ? { ...session.metadata } : null };
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not load owning session for recovered run "${handle.id}"; leaving it to resume without live visibility: ${serializeUnknownError(error)}`,
          });
          sessionLoad = { ok: false };
        }
      }

      const verdict = classifyRecoveredRun({
        handleId: handle.id,
        scheduledFire,
        ownedSessionId,
        metadataReadFailed: readError !== undefined,
        hasSessionStore: sessionStore !== undefined,
        sessionLoad,
        versionMismatch: runtime.workflowVersionMismatches.has(handle.id),
      });

      if (verdict === 'reattach' || verdict === 'reattach-version-mismatch') {
        if (verdict === 'reattach-version-mismatch') {
          diagnose({
            level: 'warn',
            scope: 'recovery',
            message:
              `[bureau] Reattaching recovered run "${handle.id}" that resumed under a ` +
              `different workflow version than it was checkpointed with (pin-and-warn; ` +
              `see documentation/workflow-versioning.md).`,
          });
        }
        // A mocked/custom engine that does not invoke Weft's recovery hook can
        // still reattach terminal visibility here. Real Weft recovery has
        // already taken the hook path above, including live event forwarding.
        let recoveredServices: DurableRunDeps | undefined;
        if (sessionStore && ownedSessionId) {
          const fullSession = await sessionStore.load(ownedSessionId);
          if (fullSession) {
            const recoveredAgentName = isAgentRunWorkflowInput(metadata?.input)
              ? metadata.input.agentName
              : BUREAU_AGENT_NAME;
            const requestContext = recoveredRequestContextFromMetadata(
              fullSession.metadata,
              handle.id,
              recoveredAgentName,
            );
            const runRuntime = await runtime.createRunRuntime(
              {
                message:
                  typeof fullSession.metadata['lastUserMessage'] === 'string'
                    ? fullSession.metadata['lastUserMessage']
                    : '',
                sessionId: ownedSessionId,
                runId: handle.id,
                agentName: recoveredAgentName,
                requestContext,
              },
              { liveStreaming: false },
            );
            recoveredServices = {
              toolbox: runRuntime.toolbox,
              getStepMetadata: emptyRecoveredStepMetadata,
              options: {
                generate: runRuntime.generate,
                toolbox: runRuntime.toolbox,
                conversation: new Conversation(fullSession.conversationHistory),
                prepareStep: runRuntime.prepareStep,
                onStep: runRuntime.onStep,
                validateResponse: runRuntime.validateResponse,
                executeOptions: { requestContext },
                agentName: recoveredAgentName,
                runId: handle.id,
              },
            };
          }
        }
        if (recoveredServices) {
          const fullSession = await sessionStore?.load(ownedSessionId!);
          await restorePendingApprovalStates(
            recoveredServices.toolbox,
            fullSession?.metadata,
            handle.id,
            ownedSessionId!,
          );
        }
        reattachRecoveredRun(
          handle.id,
          ownedSessionId!,
          handle,
          undefined,
          recoveredServices,
          sessionLoad.ok ? sessionLoad.session : null,
        );
      } else if (verdict === 'monitor') {
        // Scheduled fires have no ActiveRun surface, but the recovered Weft handle
        // still needs a detached result monitor so failures are visible.
        void monitorRecoveredScheduledFire(handle, diagnose);
      } else {
        if (verdict === 'cancel') {
          // Collect the cancel (do NOT fire-and-forget swallow): a rejected cancel
          // could leave an unowned, already-resumed run live with no monitor, so
          // its failure must be surfaced for operators. engine.cancel terminalizes
          // the run and rejects its waiter — covering metadata-less / read-failed /
          // foreign-input / orphaned-session residue without store.register'ing it.
          orphanCancellations.push({ runId: handle.id, cancel: durable.engine.cancel(handle.id) });
        }
        // 'skip' — ownership unknown; leave the run to resume without live visibility.
      }
    }

    // Await the orphan cancels DETACHED — boot must not block on them (same as the
    // recovered-run monitors), but a cancel that REJECTS leaves an unowned run
    // running, which is an operator-actionable failure, not something to swallow.
    if (orphanCancellations.length > 0) {
      void Promise.allSettled(orphanCancellations.map(({ cancel }) => cancel)).then((outcomes) => {
        outcomes.forEach((outcome, index) => {
          if (outcome.status === 'rejected') {
            diagnose({
              level: 'error',
              scope: 'recovery',
              message: `[bureau] Failed to cancel unowned recovered run "${orphanCancellations[index]!.runId}" — it may still be running: ${serializeUnknownError(outcome.reason)}`,
            });
          }
        });
      });
    }
  }

  function submitSchedulerTask(
    request: SubmitSchedulerTaskRequest,
  ): Promise<SubmitSchedulerTaskResponse> {
    validateSubmitSchedulerTaskRequest(request);

    if (!runtime.scheduler) {
      throw new BureauError('Scheduler not configured', 'NOT_CONFIGURED', 'scheduler');
    }

    const taskId = `scheduler-task-${crypto.randomUUID()}`;
    const priority = request.priority ?? 'scheduled';
    const metadataAgentName = request.metadata?.['agentName'];
    const agentName = typeof metadataAgentName === 'string' ? metadataAgentName : BUREAU_AGENT_NAME;

    // AB-13 — same admission gate as `createRun`, applied to the
    // scheduler-originated surface. `taskId` doubles as the flow-control run
    // identity: it is stable for the task's whole lifecycle (queued →
    // dispatched → completed, including any preempt/requeue cycles), which is
    // exactly the identity `markParked`/`markResumed`/`settle` need. There is
    // no per-task `agentName` field on `SubmitSchedulerTaskRequest`, so the
    // grouping key falls back to `metadata.agentName` (when the caller set
    // one) and otherwise the house default — matching `createRun`'s default.
    if (flowController) {
      const decision = flowController.admit({
        runId: taskId,
        agentName,
        source: 'scheduler',
        message: request.message,
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      });
      if (!decision.allowed) {
        throw new BureauError(
          `Scheduler task rejected by flow control policy (${decision.reason})`,
          'RATE_LIMITED',
        );
      }
    }

    const task: Parameters<NonNullable<typeof runtime.scheduler>['submit']>[0] = {
      id: taskId,
      priority,
      metadata: request.metadata,
      requeue: request.requeue,
      async createRun() {
        const runRuntime = await runtime.createRunRuntime(
          {
            message: request.message,
            maximumSteps: request.maximumSteps,
            systemPrompt: request.systemPrompt,
            sessionId: taskId,
            requestContext: createSchedulerServiceRequestContext(taskId, agentName),
          },
          { liveStreaming: false },
        );

        const conversation = new Conversation(createConversationHistory({ id: taskId }));
        const systemPrompt = request.systemPrompt ?? runtime.systemPrompt;
        if (systemPrompt) {
          conversation.appendSystemMessage(systemPrompt);
        }
        conversation.appendUserMessage(request.message);

        return {
          conversation,
          generate: runRuntime.generate,
          toolbox: runRuntime.toolbox,
          maximumSteps: request.maximumSteps ?? runtime.maximumSteps,
          onStep: runRuntime.onStep,
          prepareStep: runRuntime.prepareStep,
          stopWhen: options.stopWhen,
          validateResponse: runRuntime.validateResponse,
        };
      },
    };

    detachBestEffortPromise(runtime.scheduler.submit(task));

    return Promise.resolve({
      taskId,
      priority,
      status: 'queued',
    });
  }

  function listRuns(status?: string): RunSummary[] {
    const state = store.getState();
    const summaries: RunSummary[] = [];

    for (const [, runState] of state.runs) {
      if (status && runState.status !== status) {
        continue;
      }

      const sessionId = getRunSessionIdentifier(runState);
      summaries.push(serializeRunState(runState, sessionId, runAttribution.get(runState.id)));
    }

    return summaries;
  }

  function getRun(id: string) {
    const runState = store.getRun(id);
    if (!runState) {
      return undefined;
    }

    return serializeRunDetail(runState, getRunSessionIdentifier(runState), runAttribution.get(id));
  }

  function getRunReport(id: string): RunReport | undefined {
    const cached = runReports.get(id);
    if (cached) return cached;

    // Not yet terminal (or unknown) — build a partial report synchronously
    // from the live RunState. This is the graceful-shutdown path: safe to
    // call from an abort() call site or a SIGTERM handler with no await.
    const runState = store.getRun(id);
    if (!runState) return undefined;

    return buildPartialRunReport(id, runState, 'Run report requested before a terminal result');
  }

  function abortRun(id: string): RunSummary {
    const runState = store.getRun(id);
    if (!runState) {
      throw new BureauError('Run not found', 'NOT_FOUND');
    }

    if (runState.status !== 'running') {
      throw new BureauError(`Run is already ${runState.status}`, 'CONFLICT');
    }

    runState.activeRun.abort('Aborted via API');
    return {
      ...serializeRunState(runState, getRunSessionIdentifier(runState), runAttribution.get(id)),
      status: 'aborted',
    };
  }

  async function revokePendingApprovalsForRun(runId: string): Promise<void> {
    const approvalToolbox = runToolboxesByRunId.get(runId) ?? runtime.baseToolbox;
    const approvals = new Map<string, SignedPendingToolApproval>();
    for (const review of listPendingReviews()) {
      if (review.kind === 'tool-approval' && review.runId === runId) {
        approvals.set(review.id, review.approval as SignedPendingToolApproval);
      }
    }
    for (const [reviewId, approval] of pendingApprovalOverrides) {
      if (reviewId.startsWith(`approval:${runId}:`)) {
        approvals.set(reviewId, approval as SignedPendingToolApproval);
      }
    }
    for (const approval of approvals.values()) {
      if (!approval.approvalBinding || approval.approvalToken === undefined) continue;
      try {
        await approvalToolbox.revokeApproval(approval);
      } catch (error) {
        if (!isTerminalApprovalBindingError(error)) throw error;
      }
    }
  }

  async function deleteRun(id: string): Promise<void> {
    const runState = store.getRun(id);
    if (!runState) {
      throw new BureauError('Run not found', 'NOT_FOUND');
    }

    if (runState.status === 'running') {
      throw new BureauError('Cannot delete a running run', 'CONFLICT');
    }

    await revokePendingApprovalsForRun(id);
    const sessionId = getRunSessionIdentifier(runState);
    runSessionIdentifiers.delete(runState.activeRun);
    runAttribution.delete(id);
    runRequestContexts.delete(id);
    for (const reviewId of pendingApprovalOverrides.keys()) {
      if (reviewId.startsWith(`approval:${id}:`)) pendingApprovalOverrides.delete(reviewId);
    }
    for (const reviewId of invalidApprovalReviewIds) {
      if (reviewId.startsWith(`approval:${id}:`)) invalidApprovalReviewIds.delete(reviewId);
    }
    for (const reviewId of resolvedReviewIds) {
      if (reviewId.startsWith(`approval:${id}:`) || reviewId.startsWith(`human-wait:${id}:`)) {
        resolvedReviewIds.delete(reviewId);
      }
    }
    runToolboxesByRunId.delete(id);
    store.removeRun(id);
    if (sessionId) {
      await retryRunDeletionPersistenceWrite('pending-approvals', sessionId, `approval:${id}:`);
      await retryRunDeletionPersistenceWrite('resolved-reviews', sessionId, `approval:${id}:`);
      await retryRunDeletionPersistenceWrite('resolved-reviews', sessionId, `human-wait:${id}:`);
    }
    // AB-96 — drop the cached terminal RunReport too, or a long-lived bureau
    // that creates/deletes many runs would retain one forever per run id.
    runReports.delete(id);
  }

  /**
   * Read the durable engine's full state for a run (status, step, failure
   * category, termination reason). Thin passthrough to `engine.get`; `undefined`
   * when no durable engine is composed, `null` when the engine has no such run.
   */
  async function getDurableRun(runId: string) {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.get(runId);
  }

  /**
   * List durable runs from the engine, optionally filtered. Thin passthrough to
   * `engine.list`; `undefined` when no durable engine is composed.
   */
  async function listDurableRuns(filter?: ListFilter, options?: ListOptions) {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.list(filter, options);
  }

  async function runDurableMaintenance(now?: number): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    await runtime.durable.engine.runMaintenance(now);
    return true;
  }

  async function listSessions(options?: SessionListOptions) {
    return requireSessionStore().list(options);
  }

  async function getSession(id: string) {
    return requireSessionStore().load(id);
  }

  async function deleteSession(id: string): Promise<void> {
    const sessionStore = requireSessionStore();
    const session = await sessionStore.load(id);
    if (session) {
      for (const runId of persistedApprovalRunIds(session.metadata)) {
        await revokePendingApprovalsForRun(runId);
        for (const reviewId of pendingApprovalOverrides.keys()) {
          if (reviewId.startsWith(`approval:${runId}:`)) pendingApprovalOverrides.delete(reviewId);
        }
        for (const reviewId of invalidApprovalReviewIds) {
          if (reviewId.startsWith(`approval:${runId}:`)) invalidApprovalReviewIds.delete(reviewId);
        }
        runRequestContexts.delete(runId);
        runToolboxesByRunId.delete(runId);
        terminalReviewSessions.delete(runId);
        for (const [reviewId, cleanup] of reviewResolutionCleanupPending) {
          if (cleanup.runId === runId) reviewResolutionCleanupPending.delete(reviewId);
        }
      }
    }
    await sessionStore.delete(id);
  }

  /**
   * Look up the current durable run id for a session. Used by signal/update/query
   * to route the operation to the correct workflow handle.
   *
   * Requires that `lastRunStatus` is `'running'`: completed, aborted, and error
   * sessions retain their `lastRunId` but targeting a terminal workflow with a
   * signal/update would silently mis-route or surface a low-level engine error
   * instead of the expected "no active run" response.
   */
  async function requireSessionRunId(sessionId: string): Promise<string> {
    const session = await requireSessionStore().load(sessionId);
    if (!session) {
      throw new BureauError(`Session not found: ${sessionId}`, 'NOT_FOUND');
    }
    const runId = session.metadata['lastRunId'];
    if (typeof runId !== 'string' || !runId) {
      throw new BureauError(`Session ${sessionId} has no active run`, 'NOT_FOUND');
    }
    const runStatus = session.metadata['lastRunStatus'];
    if (runStatus !== 'running') {
      throw new BureauError(`Session ${sessionId} has no active run`, 'NOT_FOUND');
    }
    return runId;
  }

  async function signalSession(sessionId: string, name: string, payload?: unknown): Promise<void> {
    if (!runtime.durable)
      throw new BureauError('Durable engine not configured', 'NOT_CONFIGURED', 'durable');
    const runId = await requireSessionRunId(sessionId);
    const requestContext = runRequestContexts.get(runId);
    if (
      requestContext &&
      isTransportIssuedAuthority(requestContext) &&
      (!requestAuthorityValidator || !(await requestAuthorityValidator(requestContext)))
    ) {
      throw new BureauError(
        'Cannot signal: the request authority is no longer current.',
        'CONFLICT',
      );
    }
    await runtime.durable.engine.signal(runId, name, payload);
    // AB-13 — a signal is how a human-wait park is released (directly, or via
    // `resolveReview`'s human-wait approve path). Reacquire the concurrency
    // slot `HumanWaitParkedEvent` freed. A no-op when this runId was never
    // parked (e.g. a signal delivered to a run that never called
    // `requestHumanInput`) or when no flow control is configured.
    flowController?.markResumed(runId);
  }

  async function updateSession(
    sessionId: string,
    _name: string,
    _payload?: unknown,
  ): Promise<unknown> {
    if (!runtime.durable)
      throw new BureauError('Durable engine not configured', 'NOT_CONFIGURED', 'durable');
    const runId = await requireSessionRunId(sessionId);
    const requestContext = runRequestContexts.get(runId);
    if (
      requestContext &&
      isTransportIssuedAuthority(requestContext) &&
      (!requestAuthorityValidator || !(await requestAuthorityValidator(requestContext)))
    ) {
      throw new BureauError(
        'Cannot update: the request authority is no longer current.',
        'CONFLICT',
      );
    }
    // AB-192 / AB-41 coordinator ruling: the built-in `agentRun` workflow
    // registers no `ctx.onUpdate` handler, so this call can never reach the
    // engine successfully. Kept, not withdrawn (AB-42/AB-67 ratify update and
    // query as the distinct session-verb family) — an unconditional throw,
    // no detection branch, since there is no handler-registration signal to
    // check. See `bureau.sessionVerbCapabilities`.
    throw new BureauError(
      'updateSession()/querySession() are unsupported: the built-in agentRun workflow registers no ctx.onUpdate/ctx.onQuery handler.',
      'UNSUPPORTED_CAPABILITY',
    );
  }

  async function querySession(
    sessionId: string,
    _name: string,
    _input?: unknown,
  ): Promise<unknown> {
    if (!runtime.durable)
      throw new BureauError('Durable engine not configured', 'NOT_CONFIGURED', 'durable');
    await requireSessionRunId(sessionId);
    // AB-192 / AB-41 coordinator ruling: see the identical throw in
    // `updateSession` above — no `ctx.onQuery` handler is registered either.
    throw new BureauError(
      'updateSession()/querySession() are unsupported: the built-in agentRun workflow registers no ctx.onUpdate/ctx.onQuery handler.',
      'UNSUPPORTED_CAPABILITY',
    );
  }

  /**
   * AB-42/AB-194 — admit a caller's session input. Pre-admission checks run
   * in AB-42's fixed order: authorization (`not-found`) first, then session
   * lifecycle (`session-terminal`), then capability/capacity
   * (`unsupported-capability`) — reversing the first two would let an
   * unauthorized caller learn a session exists.
   *
   * Every reachable outcome here is a pre-admission rejection: no adopted
   * `@lostgradient/weft` version exposes WFT-84's durable mailbox yet, so
   * every authorized, non-terminal request unconditionally returns
   * `unsupported-capability`. No `SessionInputRecord` is created and no `id`
   * is consumed by this method today.
   */
  async function submitSessionInput(
    sessionId: string,
    request: SessionInputAdmissionRequest,
  ): Promise<SessionInputAdmissionOutcome> {
    // Unlike signalSession/updateSession/querySession, this does NOT throw
    // BureauError('NOT_CONFIGURED') when no session store is composed: an
    // ephemeral bureau (no persistence/storage) is a supported configuration,
    // and every sessionId is necessarily unknown in it — the correct outcome
    // per this method's own contract is `not-found`, not a throw.
    const session = runtime.sessionStore ? await runtime.sessionStore.load(sessionId) : undefined;
    if (!session || !isSessionAuthorityAuthorized(session.metadata, request.principal)) {
      return { outcome: 'not-found' };
    }
    if (isSessionRunTerminal(session.metadata)) {
      return { outcome: 'session-terminal', sessionId };
    }
    return { outcome: 'unsupported-capability', reason: 'durable-mailbox-unavailable' };
  }

  function listPendingReviews(): PendingReview[] {
    const now = Date.now();
    const reviews: PendingReview[] = [];
    const { runs } = store.getState();

    for (const [runId, runState] of runs) {
      const sessionId = getRunSessionIdentifier(runState);
      const agentName = findRunAgentName(runState);

      // Tool-approval: any step result still needing approval, across every
      // step (not just the last) — the run may have continued past it.
      const stepCompletedTimestamps = runState.actions
        .filter((action) => action.type === 'step.completed')
        .map((action) => action.timestamp);

      for (const [stepIndex, step] of runState.steps.entries()) {
        for (const result of step.results) {
          if (result.outcome !== 'action_required' || !result.pendingApproval) continue;
          const id = `approval:${runId}:${result.pendingApproval.callId}`;
          if (resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id)) continue;
          const requestedAt = stepCompletedTimestamps[stepIndex] ?? now;
          reviews.push({
            kind: 'tool-approval',
            id,
            runId,
            sessionId,
            agentName,
            approval: pendingApprovalOverrides.get(id) ?? result.pendingApproval,
            requestedAt,
            ageMilliseconds: now - requestedAt,
          });
        }
      }

      // Human-wait: the run is still parked iff it has a HumanWaitParkedEvent
      // action and its status is still 'running'. The park event fires
      // MID-step (from inside the `requestHumanInput` tool's `execute`,
      // called by `runStep`), so that same step's own trailing events —
      // `tools.executed`, `step.generated`, `step.completed` — are always
      // recorded AFTER it, even though the run is genuinely still parked at
      // that point (`ctx.waitForSignal` only runs once the whole step loop
      // exits). Requiring the park event to be the literal last action
      // therefore misses every real parked run — this instead takes the
      // MOST RECENT park event (a later step's `requestHumanInput` call
      // last-write-wins over an earlier one, mirroring the durable
      // workflow's own accumulation) and relies on `status === 'running'`
      // to exclude a run that has already resumed and finished — resuming
      // via `ctx.waitForSignal` runs the workflow straight through to
      // completion, so `runState.status` leaves `'running'` the moment a
      // parked run is actually resumed.
      let parkedAction: (typeof runState.actions)[number] | undefined;
      for (let index = runState.actions.length - 1; index >= 0; index--) {
        const action = runState.actions[index];
        if (action?.type === HumanWaitParkedEvent.type) {
          parkedAction = action;
          break;
        }
      }

      if (runState.status === 'running' && parkedAction !== undefined) {
        const rawDetail = parkedAction.detail;
        const detail: Record<string, unknown> | undefined =
          rawDetail !== null && typeof rawDetail === 'object'
            ? (rawDetail as Record<string, unknown>)
            : undefined;
        const signalName = detail?.['signalName'];
        if (typeof signalName === 'string' && signalName.length > 0) {
          const id = `human-wait:${runId}:${signalName}`;
          if (!resolvedReviewIds.has(id)) {
            const promptValue = detail?.['prompt'];
            const prompt = typeof promptValue === 'string' ? promptValue : undefined;
            reviews.push({
              kind: 'human-wait',
              id,
              runId,
              sessionId,
              agentName,
              signalName,
              prompt,
              requestedAt: parkedAction.timestamp,
              ageMilliseconds: now - parkedAction.timestamp,
            });
          }
        }
      }
    }

    for (const [runId, terminalReview] of terminalReviewSessions) {
      for (const [reviewId, approval] of pendingApprovalOverrides) {
        if (!reviewId.startsWith(`approval:${runId}:`)) continue;
        if (resolvedReviewIds.has(reviewId) || invalidApprovalReviewIds.has(reviewId)) continue;
        if (reviews.some((review) => review.id === reviewId)) continue;
        reviews.push({
          kind: 'tool-approval',
          id: reviewId,
          runId,
          sessionId: terminalReview.sessionId,
          agentName: terminalReview.agentName,
          approval,
          requestedAt: terminalReview.requestedAt,
          ageMilliseconds: now - terminalReview.requestedAt,
        });
      }
    }

    return reviews;
  }

  function releaseTerminalRunReviewState(runId: string): void {
    const runState = store.getRun(runId);
    if (!runState || runState.status === 'running') return;
    for (const review of listPendingReviews()) {
      if (review.runId === runId) return;
    }
    runRequestContexts.delete(runId);
    runToolboxesByRunId.delete(runId);
    recoveredRunIds.delete(runId);
  }

  async function resolveReview(input: ResolveReviewInput): Promise<ResolveReviewResult> {
    const review = listPendingReviews().find((candidate) => candidate.id === input.id);
    if (!review) {
      const cleanup = reviewResolutionCleanupPending.get(input.id);
      if (cleanup) {
        if (cleanup.decision !== input.decision) {
          throw new BureauError(`Review with id "${input.id}" is already resolved`, 'CONFLICT');
        }
        if (resolvingReviewIds.has(input.id)) {
          throw new BureauError(
            `Review with id "${input.id}" is already being resolved`,
            'CONFLICT',
          );
        }
        resolvingReviewIds.add(input.id);
        try {
          await persistReviewResolutionWithRetry(
            cleanup.sessionId,
            input.id,
            cleanup.kind === 'tool-approval',
            cleanup.runId,
          );
          reviewResolutionCleanupPending.delete(input.id);
          releaseTerminalRunReviewState(cleanup.runId);
          await recordReviewDecision(
            cleanup.review,
            cleanup.decision,
            cleanup.principal,
            cleanup.reason,
          );
          return { id: input.id, kind: cleanup.kind, decision: cleanup.decision };
        } finally {
          resolvingReviewIds.delete(input.id);
        }
      }
      throw new BureauError(`No pending review with id "${input.id}"`, 'NOT_FOUND');
    }

    if (resolvingReviewIds.has(review.id)) {
      throw new BureauError(`Review with id "${review.id}" is already being resolved`, 'CONFLICT');
    }
    resolvingReviewIds.add(review.id);

    let result: unknown;
    let keepPending = false;
    try {
      if (review.kind === 'tool-approval') {
        const approvalToolbox = runToolboxesByRunId.get(review.runId) ?? runtime.baseToolbox;
        if (input.decision === 'approve') {
          const { approval } = review;
          if (approval.approvalToken === undefined) {
            throw new BureauError(
              'Cannot approve: the toolbox that executed this tool call has no ' +
                'approvalSecret configured, so its pendingApproval was never signed.',
              'NOT_CONFIGURED',
              'approval',
            );
          }
          const approvalRequestContext = runRequestContexts.get(review.runId);
          if (
            approvalRequestContext &&
            isTransportIssuedAuthority(approvalRequestContext) &&
            !requestAuthorityValidator
          ) {
            throw new BureauError(
              'Cannot approve: the recovered request authority cannot be revalidated.',
              'CONFLICT',
            );
          }
          if (
            approvalRequestContext &&
            isTransportIssuedAuthority(approvalRequestContext) &&
            requestAuthorityValidator &&
            !(await requestAuthorityValidator(approvalRequestContext))
          ) {
            throw new BureauError(
              'Cannot approve: the request authority is no longer current.',
              'CONFLICT',
            );
          }
          await persistApprovalResolutionStartedWithRetry(review.sessionId, review.id);
          result = await approvalToolbox.resumeApproval(
            { ...approval, approvalToken: approval.approvalToken },
            {
              ...(Object.prototype.hasOwnProperty.call(input, 'arguments')
                ? { arguments: input.arguments }
                : {}),
              ...(approvalRequestContext ? { requestContext: approvalRequestContext } : {}),
            },
          );

          // `resumeApproval` re-runs the tool's `beforeExecute` policy from
          // scratch — a policy that re-evaluates on edited arguments (or has
          // changed since the original request) can gate it again, returning
          // ANOTHER `action_required` instead of executing. The tool did not
          // run, so this id must stay resolvable: undo the resolved mark (the
          // same recovery the catch block below does for a thrown error) so
          // the review is not silently dropped from the queue while the tool
          // call remains genuinely pending approval.
          if (
            result !== null &&
            typeof result === 'object' &&
            'outcome' in result &&
            result.outcome === 'action_required'
          ) {
            const nextApproval = (result as Record<string, unknown>)['pendingApproval'];
            if (nextApproval && typeof nextApproval === 'object') {
              const replacementApproval = nextApproval as Extract<
                PendingReview,
                { kind: 'tool-approval' }
              >['approval'];
              // Publish the replacement locally before attempting durable
              // persistence. The original binding has already been consumed;
              // keeping it in memory after a persistence failure would make a
              // later retry reuse an invalid approval.
              pendingApprovalOverrides.set(review.id, replacementApproval);
              await persistPendingApprovalOverrideWithRetry(
                review.sessionId,
                review.id,
                replacementApproval,
              );
            }
            keepPending = true;
          } else if (
            result !== null &&
            typeof result === 'object' &&
            'outcome' in result &&
            result.outcome === 'error' &&
            'approvalBindingConsumed' in result &&
            result.approvalBindingConsumed === false
          ) {
            const failedResult = result as {
              error?: { message?: string };
              errorMessage?: string;
            };
            await persistPendingApprovalOverrideWithRetry(
              review.sessionId,
              review.id,
              review.approval,
            );
            throw new BureauError(
              `Cannot approve: ${failedResult.error?.message ?? failedResult.errorMessage ?? 'tool approval resume failed before execution admission.'}`,
              'CONFLICT',
            );
          }
        } else if (review.approval.approvalBinding && review.approval.approvalToken !== undefined) {
          await persistApprovalResolutionStartedWithRetry(review.sessionId, review.id);
          try {
            await approvalToolbox.revokeApproval(review.approval as SignedPendingToolApproval);
          } catch (error) {
            // A denial is still authoritative when the binding has expired or
            // was already consumed. Only an issued, revocable binding needs
            // revocation; failure to revoke stale state must not lose the
            // operator's denial decision.
            if (!isTerminalApprovalBindingError(error)) throw error;
            diagnose({
              level: 'warn',
              scope: 'approval',
              message: `[bureau] Denied approval "${review.id}" was already terminal or absent: ${serializeUnknownError(error)}`,
            });
          }
        }
      } else if (input.decision === 'approve') {
        const requestContext = runRequestContexts.get(review.runId);
        if (
          requestContext &&
          isTransportIssuedAuthority(requestContext) &&
          (!requestAuthorityValidator || !(await requestAuthorityValidator(requestContext)))
        ) {
          throw new BureauError(
            'Cannot approve: the request authority is no longer current.',
            'CONFLICT',
          );
        }
        // Route through the public `bureau.signalSession` (rather than the
        // local closure function) so this is the exact same call surface a
        // caller could make directly — one seam, not two ways to do the same
        // thing.
        await bureau.signalSession(review.sessionId, review.signalName, input.payload);
      }
    } catch (error) {
      resolvingReviewIds.delete(review.id);
      throw error;
    }

    resolvingReviewIds.delete(review.id);
    if (!keepPending) {
      resolvedReviewIds.add(review.id);
      if (review.kind === 'tool-approval') {
        pendingApprovalOverrides.delete(review.id);
        if (
          !Array.from(pendingApprovalOverrides.keys()).some((reviewId) =>
            reviewId.startsWith(`approval:${review.runId}:`),
          )
        ) {
          terminalReviewSessions.delete(review.runId);
        }
      }
      try {
        await persistReviewResolutionWithRetry(
          review.sessionId,
          review.id,
          review.kind === 'tool-approval',
          review.runId,
        );
      } catch (error) {
        reviewResolutionCleanupPending.set(review.id, {
          sessionId: review.sessionId,
          runId: review.runId,
          kind: review.kind,
          decision: input.decision,
          review,
          principal: input.principal,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
        resolvingReviewIds.delete(review.id);
        throw error;
      }
      releaseTerminalRunReviewState(review.runId);
    }

    await recordReviewDecision(review, input.decision, input.principal, input.reason);

    return { id: review.id, kind: review.kind, decision: input.decision, result };
  }

  async function recordReviewDecision(
    review: PendingReview,
    decision: 'approve' | 'deny',
    principal: string,
    reason?: string,
  ): Promise<void> {
    const decisionType =
      review.kind === 'tool-approval'
        ? decision === 'approve'
          ? 'review.tool-approval.approved'
          : 'review.tool-approval.denied'
        : decision === 'approve'
          ? 'review.human-wait.approved'
          : 'review.human-wait.denied';

    await auditTrailInstance?.record({
      runId: review.runId,
      type: decisionType,
      detail: {
        review,
        decision,
        ...(reason !== undefined ? { reason } : {}),
      },
      principal,
    });
  }

  async function createSchedule(
    definition: DurableScheduleDefinition,
  ): Promise<import('@lostgradient/weft').ScheduleSummary | null | undefined> {
    if (!runtime.durable) return undefined;
    // A schedule whose every fire would fail is worse than rejecting up front:
    // without a configured generate/provider, each tick's `createRunRuntime` throws
    // `No generate function configured`. Mirror `createRunFromRequest`'s readiness
    // guard so we surface NOT_CONFIGURED here instead of registering a broken
    // schedule that returns a healthy-looking summary (review: codex Mn69W).
    if (!runtime.ready) {
      throw new BureauError('No generate function configured', 'NOT_CONFIGURED', 'generate');
    }
    // Register a native weft schedule that fires the `agentRun` workflow on each
    // tick. The fire path is wired through `resolveRunServices`' scheduled-fire
    // branch (see runtime-composition.ts): each tick builds fresh run deps from
    // the ScheduledAgentRunInput, seeds the prompt, and runs the agent (#109).
    //
    // Definition validation (blank recurring session, overlap 'allow' + recurring
    // session) lives in `createAgentSchedule` — the single chokepoint every caller
    // (bureau, AgentScheduler, the scheduleSelf tool) routes through — so it cannot
    // be bypassed. We surface its `InvalidScheduleError` as a BAD_REQUEST (400).
    const scheduler = createAgentScheduler({ engine: runtime.durable.engine });
    let handle;
    try {
      handle = await scheduler.schedule(definition.agentName, {
        spec: toScheduleSpec(definition.spec),
        input: definition.input,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        ...(definition.sessionId !== undefined ? { session: definition.sessionId } : {}),
        ...(definition.overlap !== undefined ? { overlap: definition.overlap } : {}),
      });
    } catch (error) {
      if (error instanceof InvalidScheduleError) {
        toBadRequest(error.message);
      }
      throw error;
    }
    return handle.describe();
  }

  async function getSchedule(
    scheduleId: string,
  ): Promise<import('@lostgradient/weft').ScheduleSummary | null | undefined> {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.getSchedule(scheduleId);
  }

  async function listSchedules(
    filter?: import('@lostgradient/weft').ScheduleFilter,
  ): Promise<
    | import('@lostgradient/weft').PaginatedResult<import('@lostgradient/weft').ScheduleSummary>
    | undefined
  > {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.listSchedules(filter);
  }

  async function pauseSchedule(scheduleId: string): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    await runtime.durable.engine.pauseSchedule(scheduleId);
    return true;
  }

  async function resumeSchedule(scheduleId: string): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    await runtime.durable.engine.resumeSchedule(scheduleId);
    return true;
  }

  async function cancelSchedule(scheduleId: string): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    await runtime.durable.engine.cancelSchedule(scheduleId);
    return true;
  }

  function getToolSummaries(): ToolSummary[] {
    return runtime.getToolSummaries();
  }

  function getConfiguration(): ConfigurationResponse {
    return {
      provider: runtime.provider,
      providers: runtime.providers,
      maximumSteps: runtime.maximumSteps,
      systemPrompt: runtime.systemPrompt,
      tools: getToolSummaries(),
    };
  }

  function dispose(): Promise<void> {
    // Idempotency guard: dispose() may be called more than once (the harness
    // does in tests, and `[Symbol.dispose]` may re-enter). Disposing the engine
    // and especially the raw Storage twice can close an already-closed SQLite
    // connection; a second pass is a no-op.
    if (disposePromise) return disposePromise;

    // AB-246/AB-64 (2026-09-02 amendment): a model-catalog refresh is
    // INDEPENDENTLY owned by Bureau's catalog, not parent-owned by a run — so
    // it isn't touched by the run/toolbox teardown below, and `dispose()`
    // awaits it here rather than aborting it out from under a caller who may
    // still be awaiting the same handle. Captured synchronously, BEFORE the
    // teardown below runs, but awaited only at the very end (not blocking
    // admission closure, active-run cancellation, or backend teardown — a
    // slow or never-settling refresh must not stall the rest of `dispose()`,
    // per review finding on PR #432). Awaits `closed()`, not `result()`: the
    // started-work contract lets a handle's cleanup acknowledgement settle
    // AFTER its result (result() only means the refresh's business outcome
    // is known; closed() means teardown actually finished), and a caller-
    // supplied `ModelCatalogService` is explicitly allowed to do that — so
    // only awaiting `closed()` observes the real cleanup fence (review
    // finding, PR #432).
    const modelCatalogRefreshClosedPromise = modelCatalog.inFlightRefresh()?.closed();

    disposePromise = (async () => {
      // Stop admission before cancelling runs. The canonical toolbox is the
      // owner of local execution lifecycle; await its shutdown as the
      // quiescence fence before releasing durable resources.
      runtime.baseToolbox.closeAdmission();
      for (const toolbox of runToolboxes) toolbox.closeAdmission();
      for (const activeRun of activeRuns) activeRun.abort('Bureau disposed');
      // AB-22 review fix: `bureau.run(...)` dispatches are tracked separately
      // (see `trackCatalogRun`) since a catalog `RunnableAgent`'s returned
      // handle is not necessarily backed by a bureau-owned `ActiveRun` — its
      // `abort()` can be arbitrary, untrusted code. Snapshot before
      // iterating (a synchronous catalog agent can settle result()
      // immediately from inside abort(), whose trackCatalogRun cleanup
      // deletes from catalogRuns mid-iteration), and isolate each call: an
      // in-flight custom handle throwing from abort() must not reject this
      // entire dispose() before the unconditional teardown below runs — that
      // would skip toolbox shutdown, durable-engine disposal, and storage
      // closure, and since disposePromise is already cached at this point,
      // every subsequent dispose() call would return the same rejection
      // forever instead of ever completing cleanup (review round 2, Codex).
      for (const catalogRun of [...catalogRuns]) {
        try {
          catalogRun.abort('Bureau disposed');
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'dispose',
            message: `[bureau] A catalog run's abort() threw during disposal; continuing teardown: ${serializeUnknownError(error)}`,
          });
        }
      }
      const toolboxes = [
        ...new Set([runtime.baseToolbox, ...runToolboxes, ...runToolboxesByRunId.values()]),
      ];
      const toolboxShutdownResults = await Promise.allSettled(
        toolboxes.map((toolbox) =>
          toolbox.shutdown({ policy: 'abort', reason: 'Bureau disposed' }),
        ),
      );
      for (const result of toolboxShutdownResults) {
        if (result.status === 'rejected') {
          diagnose({
            level: 'error',
            scope: 'dispose',
            message: `[bureau] Error during toolbox shutdown: ${serializeUnknownError(result.reason)}`,
          });
        }
      }

      // All pre-teardown is BEST-EFFORT, and the whole body is under an OUTER
      // try/finally so the critical backend teardown (engine → storage → store)
      // ALWAYS runs. The async steps (`scheduler.stop`, `memory.close`) are
      // already `.catch`'d; the synchronous steps below are equally fallible —
      // `emitter.dispatch`/`emitter.complete` route through
      // `CompletableEventTarget.dispatchEvent`, which loops over `toObservable()`
      // subscribers WITHOUT a try/catch, so a subscriber whose `next`/`complete`
      // throws propagates straight back here. That path is reachable through the
      // public Bureau surface (`toObservable()`), so the synchronous pre-teardown
      // is wrapped to swallow-and-log: a throwing subscriber must not strand the
      // SQLite/LMDB handle behind the now-`true` `disposed` guard (a second
      // dispose no-ops), leaking it permanently. Covered by the
      // "toObservable subscriber throws during dispose" regression test.
      try {
        if (runtime.scheduler) {
          detachBestEffortPromise(runtime.scheduler.stop());
        }

        if (runtime.memory) {
          detachBestEffortPromise(runtime.memory.close());
        }

        try {
          // Dispose the audit trail and webhook notifier before emitting
          // bureau.disposed so any in-flight write/delivery callbacks are
          // unsubscribed cleanly (the notifier also abandons in-flight backoff
          // waits so a disposed bureau never fires a webhook late).
          auditTrailInstance?.dispose();
          if (webhookNotifierInstance) {
            detachBestEffortPromise(webhookNotifierInstance.dispose());
          }
          if (onlineEvalSamplerInstance) {
            detachBestEffortPromise(onlineEvalSamplerInstance.dispose());
          }
          emitter.dispatch(new BureauDisposedEvent());
          storeSubscription.unsubscribe();
          for (const disposeListener of schedulerCleanup) {
            disposeListener();
          }
          for (const disposeListener of flowControlSchedulerCleanup) {
            disposeListener();
          }
          emitter.complete();
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'dispose',
            message: `[bureau] Error during dispose pre-teardown: ${serializeUnknownError(error)}`,
          });
        }
      } finally {
        // The per-run `resolveWorkflowServices` resolver is engine-scoped and is
        // released when the engine is disposed below — there is no module-global
        // reconstructor to clear here anymore.
        //
        // Dispose the durable run engine, then the raw Storage, then the store —
        // each guarded so a throw in one stage does not skip the next (engine
        // dispose is synchronous and can throw in a degraded environment; the
        // SQLite/LMDB handle must still be released).
        //
        // Durable execution is ON BY DEFAULT for a persistent storage backend, so
        // most sqlite/lmdb bureaus now own an engine. The engine dispose does NOT
        // close the raw Storage, and the KV/checkpoint views were created with
        // `disposeUnderlyingStorage: false` — so the explicit `disposeStorage` is
        // what actually releases the file handle (even when no engine was built,
        // e.g. `durableExecution: false` with sqlite).
        try {
          // Observability dispose runs BEFORE engine dispose: it ends still-open
          // spans and unsubscribes the engine lifecycle listeners. If the engine
          // were disposed first, those listeners would already be gone, so the spans
          // they would have closed in response to the engine's terminal-disposal
          // events would leak instead. Best-effort — a throw here must not skip the
          // backend teardown below.
          try {
            runtime.durable?.observability?.dispose();
          } catch (error) {
            diagnose({
              level: 'error',
              scope: 'dispose',
              message: `[bureau] Error disposing durable observability: ${serializeUnknownError(error)}`,
            });
          }
          runtime.durable?.engine[Symbol.dispose]?.();
        } finally {
          try {
            runtime.disposeStorage?.();
          } finally {
            if (ownsStore) {
              store.dispose();
            }
          }
        }
      }
      // Awaited last: everything above (admission, active runs, toolbox
      // shutdown, backend teardown) already ran without waiting on this.
      await modelCatalogRefreshClosedPromise;
    })();
    return disposePromise;
  }

  // Build the bureau object first so the audit trail (and webhook notifier)
  // can subscribe to its action events via addEventListener. The audit trail
  // is best-effort — a write failure must never crash a run (handled inside
  // createAuditTrail).
  let auditTrailInstance: AuditTrail | undefined;
  let webhookNotifierInstance: WebhookNotifier | undefined;
  let onlineEvalSamplerInstance: OnlineEvalSampler | undefined;

  const bureau: Bureau<D> = {
    store,
    memory: runtime.memory,
    scheduler: runtime.scheduler,
    sessionStore: runtime.sessionStore,
    kv: runtime.kv,
    agents: agentCatalog,
    modelCatalog,
    // `runAgent`'s runtime signature is deliberately widened (`string`,
    // `AgentRun<unknown, boolean>`) — it looks the agent up by a plain
    // runtime string via `agentCatalog.find`, the same widening
    // `BureauAgentCatalog.find` itself documents. The precise per-`TName`
    // return type on `Bureau<D>['run']` is a caller-side compile-time
    // narrowing this cast restores; at runtime the returned `AgentRun` IS
    // exactly the named entry's own handle, unaffected by the cast.
    run: runAgent as Bureau<D>['run'],
    get auditTrail(): AuditTrail | undefined {
      return auditTrailInstance;
    },
    get webhookNotifier(): WebhookNotifier | undefined {
      return webhookNotifierInstance;
    },
    get onlineEvalSampler(): OnlineEvalSampler | undefined {
      return onlineEvalSamplerInstance;
    },
    get ready() {
      return runtime.ready;
    },
    createRun: createRunFromRequest,
    submitSchedulerTask,
    listRuns,
    getRun,
    getRunReport,
    abortRun,
    deleteRun,
    getDurableRun,
    listDurableRuns,
    runDurableMaintenance,
    listSessions,
    getSession,
    deleteSession,
    signalSession,
    updateSession,
    querySession,
    submitSessionInput,
    // AB-192: constant, not computed from runtime state — the built-in
    // `agentRun` workflow never registers `ctx.onUpdate`/`ctx.onQuery`
    // handlers, so `update`/`query` are unsupported today regardless of
    // configuration. `signal` has a real delivery path (`signalSession`).
    sessionVerbCapabilities: { signal: true, update: false, query: false },
    listPendingReviews,
    resolveReview,
    setRequestAuthorityValidator(validator) {
      requestAuthorityValidator = validator;
      runtime.setRequestAuthorityValidator(validator);
      if (validator && durableRecoveryDeferred && !durableRecoveryStarted) {
        durableRecoveryDeferred = false;
        durableRecoveryStarted = true;
        const recovery = recoverDurableRuns().catch((error) => {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Deferred durable run recovery failed: ${serializeUnknownError(error)}`,
          });
        });
        void recovery.then(() => resolveDurableRecoveryBarrier?.());
      }
    },
    getRequestAuthorityValidator() {
      return requestAuthorityValidator;
    },
    waitForRecovery() {
      return durableRecoveryBarrier;
    },
    createSchedule,
    getSchedule,
    listSchedules,
    pauseSchedule,
    resumeSchedule,
    cancelSchedule,
    getConfiguration,
    getTools: getToolSummaries,
    subscribeLiveFrames(listener) {
      liveFrameListeners.add(listener);
      return () => {
        liveFrameListeners.delete(listener);
      };
    },
    addEventListener: (type, listener, listenerOptions) =>
      emitter.addEventListener(type, listener, listenerOptions),
    removeEventListener: (type, listener, listenerOptions) =>
      emitter.removeEventListener(type, listener, listenerOptions),
    on: (type, observableOptions) => emitter.on(type, observableOptions),
    once: (type, listener) => emitter.once(type, listener),
    subscribe: (type, observerOrNext, error, complete) =>
      emitter.subscribe(type, observerOrNext, error, complete),
    toObservable: () => emitter.toObservable(),
    events: (type, iteratorOptions) => emitter.events(type, iteratorOptions),
    complete: () => emitter.complete(),
    get completed() {
      return emitter.completed;
    },
    get signal() {
      return emitter.signal;
    },
    dispose,
  } satisfies Bureau<D>;

  // Wire the durable audit trail (Layer B) now that we have a bureau to
  // subscribe to. Only created when a KV store is available; ephemeral
  // bureaus have Layer A only.
  //
  // The trail is subscribed BEFORE durable run recovery so that actions
  // emitted by recovered/reattached runs — including handles that are already
  // settled, or settle during the awaits inside recoverDurableRuns() — are
  // captured in the durable trail rather than landing only in the live store.
  if (runtime.kv) {
    auditTrailInstance = createAuditTrail(bureau, runtime.kv, diagnose);
  }

  // Wire the webhook notifier (AB-21) now that the audit trail exists (an
  // exhausted delivery is recorded there). Only created when at least one
  // target is configured — the common case (no `options.webhooks`) costs
  // nothing beyond the `undefined` check in `createWebhookNotifier`.
  if (options.webhooks && options.webhooks.targets.length > 0) {
    webhookNotifierInstance = createWebhookNotifier(
      bureau,
      runtime.kv,
      auditTrailInstance,
      options.webhooks,
      diagnose,
    );
  }

  // Wire the online eval sampler (AB-53) now that the audit trail and webhook
  // notifier exist (a sampled score is recorded to the former; a threshold
  // breach is delivered through the latter). Only created when at least one
  // judge is configured with a positive sample rate — the common case (no
  // `options.onlineEvals`) costs nothing beyond the `undefined` check inside
  // `createOnlineEvalSampler`.
  if (
    options.onlineEvals &&
    options.onlineEvals.judges.length > 0 &&
    options.onlineEvals.sampleRate > 0
  ) {
    onlineEvalSamplerInstance = createOnlineEvalSampler(
      bureau,
      auditTrailInstance,
      webhookNotifierInstance,
      options.onlineEvals,
    );
  }

  // A standard `createBureau()` then `createGateway()` boot has no validator
  // until the Gateway is constructed. Defer recovery when persisted sessions
  // contain gateway-issued authority so those runs cannot execute unvalidated.
  let hasDeferredGatewayAuthority = false;
  if (runtime.durable && runtime.sessionStore) {
    try {
      const sessions: SessionSummary[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await runtime.sessionStore.list({ limit: 100, offset });
        sessions.push(...page);
        if (page.length < 100) break;
      }
      for (const session of sessions) {
        const runId = session.metadata['lastRunId'];
        const status = session.metadata['lastRunStatus'];
        const metadata = session.metadata;
        const restoredRunIds = persistedApprovalRunIds(metadata);
        if (typeof runId === 'string' && status === 'running') restoredRunIds.delete(runId);
        for (const restoredRunId of restoredRunIds) {
          const before = pendingApprovalOverrides.size;
          restorePendingApprovalOverrides(metadata, restoredRunId);
          if (pendingApprovalOverrides.size > before) {
            terminalReviewSessions.set(restoredRunId, {
              sessionId: session.id,
              agentName: session.agentName,
              requestedAt: Date.parse(session.updatedAt) || Date.now(),
            });
            await restoreTerminalReviewSession(session, restoredRunId);
          }
        }
        if (!requestAuthorityValidator && hasRecoverableTransportAuthority(session.metadata)) {
          hasDeferredGatewayAuthority = true;
        }
      }
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not inspect sessions before durable recovery${requestAuthorityValidator ? '; continuing with the configured authority validator' : '; deferring until authority validator attachment'}: ${serializeUnknownError(error)}`,
      });
      hasDeferredGatewayAuthority = !requestAuthorityValidator;
    }
  }
  if (hasDeferredGatewayAuthority) {
    durableRecoveryDeferred = true;
    durableRecoveryBarrier = new Promise<void>((resolve) => {
      resolveDurableRecoveryBarrier = resolve;
    });
  } else {
    durableRecoveryStarted = true;
    durableRecoveryBarrier = recoverDurableRuns().catch((error) => {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Durable run recovery failed during boot: ${serializeUnknownError(error)}`,
      });
    });
    await durableRecoveryBarrier;
  }

  return bureau;
}
