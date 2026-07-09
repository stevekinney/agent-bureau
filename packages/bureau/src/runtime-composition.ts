import {
  decode,
  deserializeCheckpoint,
  type WorkflowServicesResolution,
  type WorkflowServicesResolverInfo,
} from '@lostgradient/weft';
import {
  KEYS,
  resolveStorage,
  type Storage,
  type StorageConfiguration,
  type TextValueStore,
  textValueStore,
} from '@lostgradient/weft/storage';
import type { ConditionalTextValueStore } from '@lostgradient/weft/storage/text-value-store';
import {
  combineToolboxes,
  createTool,
  createToolbox,
  type Toolbox,
  type ToolboxEventMap,
  type ToolCallInput,
} from 'armorer';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
} from 'conversationalist';
import type { ForwardableSource, HookReplayPolicy } from 'lifecycle';
import { CompletableEventTarget, forwardEvents, TypedEventTarget } from 'lifecycle';
import type { CreateMemoryOptions, Memory } from 'memory';
import { createMemory } from 'memory';
import type {
  AgentSession,
  CombinedOperativeEventMap,
  GenerateFunction,
  JSONValue,
  OnStepHook,
  PrepareStepHook,
  Scheduler,
  SessionStore,
  SessionSummary,
  StreamEventMap,
  ValidateResponseHook,
} from 'operative';
import {
  createAgentSession,
  createGuardrails,
  createIdentityHook,
  createScheduler,
  createSessionStore,
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
  withCache,
  withEnhancedStreaming,
} from 'operative';
import { createAnthropicProvider, createAnthropicProviderStream } from 'operative/anthropic';
import type {
  AnyRunEngine,
  CheckpointStore,
  DurableRunDeps,
  RunEngineObservability,
  ScheduledAgentRunInput,
  StepRecord,
} from 'operative/durable';
import {
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  isAgentRunWorkflowInput,
  isScheduledAgentRunInput,
  SCHEDULER_ORIGIN_TAG,
  SCHEDULER_RUN_ID_PREFIX,
  WorkflowVersionMismatchEvent,
} from 'operative/durable';
import { createGeminiProvider, createGeminiProviderStream } from 'operative/gemini';
import { createOpenAIProvider, createOpenAIProviderStream } from 'operative/openai';
import {
  createComplexityStrategy,
  createCostAwareStrategy,
  createFalloverGenerate,
  createRoutingGenerate,
  createStepBasedStrategy,
} from 'operative/providers';
import type { SkillProvider as SkillsPackageProvider, SkillSession, ToolPolicy } from 'skills';
import {
  createSkillCatalogHook,
  createSkillSession,
  createStorageSkillProvider,
  escapeXml,
} from 'skills';
import { z } from 'zod';

import { serializeUnknownError } from './serialization';
import type {
  BureauOptions,
  CacheConfiguration,
  CreateRunRequest,
  PersistenceOptions,
  ProviderConfiguration,
  RedactedProviderConfiguration,
  RedactedProviderRouteConfiguration,
  RoutingConfiguration,
  SkillCatalogEntry,
  SkillProvider,
  ToolSummary,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; bureau never inspects the type parameter
type BureauToolbox = Toolbox<any>;

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
  value: StorageConfiguration | ConditionalTextValueStore,
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
function resolvePersistenceOptions(options: BureauOptions): {
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

function removeLastScheduledFireTranscript(
  history: ConversationHistory,
  runId: string,
): ConversationHistory {
  const promptIndex = lastScheduledFirePromptIndex(history, runId);
  if (promptIndex === -1) return history;
  const nextUserIndex = history.ids.findIndex((id, index) => {
    if (index <= promptIndex) return false;
    return history.messages[id]?.role === 'user';
  });
  return removeConversationIndexRange(
    history,
    promptIndex,
    nextUserIndex === -1 ? history.ids.length - 1 : nextUserIndex - 1,
  );
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
function createMemoryRecallHook(memory: Memory, sessionId: string): PrepareStepHook {
  return async (context) => {
    if (context.step !== 0) {
      return;
    }

    const messages = context.conversation.getMessages();
    const latestUserMessage = [...messages]
      .reverse()
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

function resolveProviderGenerate(
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

function createRoutingStrategy(configuration: RoutingConfiguration): RoutingResult {
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
            if (signals.toolCount <= (configuration.simpleMaxTools ?? 2)) {
              if (signals.lastMessageLength <= (configuration.simpleMaxLength ?? 500)) {
                return 'simple';
              }
            }

            if (configuration.frontier && signals.conversationDepth > 20) {
              return 'frontier';
            }

            return 'complex';
          },
        }),
      };
    case 'cost-aware': {
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

function applyCache(
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

type RuntimeCompositionDependencies = {
  resolveProviderGenerate: typeof resolveProviderGenerate;
};

const defaultRuntimeCompositionDependencies: RuntimeCompositionDependencies = {
  resolveProviderGenerate,
};

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
 * A JSON-serializable snapshot of one active skill's name and optional tool policy.
 * Written to session metadata as `lastActiveSkills` after each step so a recovered
 * run can seed a fresh {@link SkillSession} with the pre-crash active set.
 */
export interface ActiveSkillEntry {
  name: string;
  toolPolicy?: ToolPolicy;
}

const activeSkillsStepMetadataKey = '__bureauActiveSkills';
const activeSkillsStepMetadataVersion = 1;

function activeSkillsStepMetadata(entries: ActiveSkillEntry[]): JSONValue {
  return {
    version: activeSkillsStepMetadataVersion,
    entries: entries as unknown as JSONValue,
  };
}

function activeSkillsFromStepMetadata(
  metadata: StepRecord['metadata'],
): ActiveSkillEntry[] | undefined {
  const raw = metadata?.[activeSkillsStepMetadataKey];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const snapshot = raw as Record<string, unknown>;
  if (snapshot['version'] !== activeSkillsStepMetadataVersion) return undefined;
  const entries = snapshot['entries'];
  return isActiveSkillEntryArray(entries) ? entries : undefined;
}

/**
 * Validate that a value is a valid {@link ActiveSkillEntry} array for deserialization
 * from session metadata.
 */
function isActiveSkillEntryArray(value: unknown): value is ActiveSkillEntry[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate['name'] !== 'string') return false;
    if (candidate['toolPolicy'] !== undefined) {
      const policy = candidate['toolPolicy'];
      if (typeof policy !== 'object' || policy === null) return false;
      const p = policy as Record<string, unknown>;
      if (p['allowList'] !== undefined && !Array.isArray(p['allowList'])) return false;
      if (p['denyList'] !== undefined && !Array.isArray(p['denyList'])) return false;
    }
  }
  return true;
}

function activeSkillSessionMetadataForStep(
  entries: ActiveSkillEntry[],
  step: number,
  runId?: string,
): Record<string, JSONValue> {
  return {
    lastActiveSkills: entries as unknown as JSONValue,
    ...(runId !== undefined
      ? {
          lastActiveSkillsRunId: runId,
          lastActiveSkillsStep: step,
        }
      : {}),
  };
}

function recordedAgentStep(value: unknown): StepRecord | undefined {
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
 * A thin wrapper over a {@link SkillSession} that also tracks the per-skill tool
 * policy passed to {@link SkillSession.activate}. The base `SkillSession` interface
 * only exposes skill names (via `getActiveSkills`) and the MERGED policy (via
 * `getActiveToolPolicy`); for durable recovery we need the per-skill policy so we
 * can reconstruct the exact pre-crash active-skill set.
 */
interface TrackedSkillSession extends SkillSession {
  /**
   * Returns the current active skills as {@link ActiveSkillEntry} pairs, including
   * each skill's individual tool policy. Safe to serialize to session metadata.
   */
  getActiveEntries(): ActiveSkillEntry[];
}

/**
 * Wrap a {@link SkillSession} with per-skill policy tracking. All other methods
 * delegate unchanged; `activate` and `deactivate` additionally maintain an
 * internal Map of `name → toolPolicy` so `getActiveEntries()` can return the
 * full snapshot needed for durable recovery.
 */
function createTrackedSkillSession(): TrackedSkillSession {
  const inner = createSkillSession();
  const policyMap = new Map<string, ToolPolicy | undefined>();

  return {
    getActiveSkills: () => inner.getActiveSkills(),
    isActive: (name) => inner.isActive(name),
    activate(name, toolPolicy) {
      policyMap.set(name, toolPolicy);
      inner.activate(name, toolPolicy);
    },
    deactivate(name) {
      policyMap.delete(name);
      inner.deactivate(name);
    },
    getActiveToolPolicy: () => inner.getActiveToolPolicy(),
    getActiveEntries(): ActiveSkillEntry[] {
      return inner.getActiveSkills().map((name) => {
        const toolPolicy = policyMap.get(name);
        return toolPolicy !== undefined ? { name, toolPolicy } : { name };
      });
    },
  };
}

/**
 * Snapshot the active skill set to session metadata after each completed step.
 *
 * EFFECTFUL hook (seam #11): on a durable recovery the crashed in-flight step
 * re-runs from its boundary, so this hook can fire AGAIN for the same step. The
 * write is IDEMPOTENT — a re-fire for step N overwrites `lastActiveSkills` with the
 * same value (completed steps do not re-run their tool executions, so the active-skill
 * set is unchanged on replay). This is a state snapshot, NOT an append — the last
 * writer wins (matching the single-source-of-truth model for `lastActiveSkills`).
 *
 * Replay classification: `effectful` (writes to external storage) but SAFE across
 * recovery re-fires because the payload is deterministic for a given step boundary
 * (completed steps replay identically, producing the same active-skill set).
 */
function createSkillStateSnapshotHook(
  trackedSession: TrackedSkillSession,
  sessionId: string,
  store: SessionStore,
  runId?: string,
): OnStepHook {
  return async (context) => {
    const entries = trackedSession.getActiveEntries();
    try {
      await store.updateMetadata(
        sessionId,
        activeSkillSessionMetadataForStep(entries, context.step, runId),
      );
    } catch {
      // Non-fatal: if we can't snapshot the active skills, recovery falls back to
      // an empty session (the pre-existing behavior). Don't propagate — a failed
      // state snapshot must not abort the step.
    }
  };
}

function createSkillManagementToolbox(
  provider: SkillProvider,
  session: SkillSession,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; bureau never inspects the type parameter
): Toolbox<any> {
  return createToolbox([
    createTool({
      name: 'activate_skill',
      description:
        'Activate a skill by name. Returns the skill instructions and available resources.',
      input: z.object({
        name: z.string().describe('The skill name to activate'),
      }),
      async execute(params) {
        if (session.isActive(params.name)) {
          return { alreadyActive: true, name: params.name };
        }

        const enabled = await provider.isEnabled(params.name);
        if (!enabled) {
          return { error: 'Skill is disabled', name: params.name };
        }

        const skill = await provider.loadSkill(params.name);
        if (!skill) {
          return { error: 'Skill not found', name: params.name };
        }

        const resources = await provider.listResources(params.name);
        session.activate(params.name, skill.metadata.toolPolicy);

        const escapedName = escapeXml(params.name);
        let xml = `<skill_content name="${escapedName}">\n${skill.body}`;

        if (resources.length > 0) {
          const resourceElements = resources
            .map((path) => `  <file>${escapeXml(path)}</file>`)
            .join('\n');
          xml += `\n\nSkill resources:\n<skill_resources>\n${resourceElements}\n</skill_resources>`;
        }

        xml += '\n</skill_content>';
        return xml;
      },
    }),
    createTool({
      name: 'load_skill_resource',
      description: 'Load a resource file from an active skill.',
      input: z.object({
        skillName: z.string().describe('The skill name'),
        path: z.string().describe('The resource path within the skill'),
      }),
      async execute(params) {
        if (!session.isActive(params.skillName)) {
          return { error: 'Skill is not active', skillName: params.skillName };
        }

        const content = await provider.loadResource(params.skillName, params.path);
        if (content === undefined) {
          return {
            error: 'Resource not found',
            skillName: params.skillName,
            path: params.path,
          };
        }

        return { content };
      },
    }),
    createTool({
      name: 'deactivate_skill',
      description: 'Deactivate a skill and remove it from the active set.',
      input: z.object({
        name: z.string().describe('The skill name to deactivate'),
      }),
      execute(params) {
        const deactivated = session.isActive(params.name);
        if (deactivated) {
          session.deactivate(params.name);
        }

        return Promise.resolve({ deactivated, name: params.name });
      },
    }),
    createTool({
      name: 'list_skills',
      description: 'List available skills and whether they are active.',
      input: z.object({}),
      async execute() {
        const entries = await provider.listSkills();
        return {
          skills: entries.map((entry: SkillCatalogEntry) => ({
            ...entry,
            active: session.isActive(entry.name),
          })),
        };
      },
    }),
  ]);
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
  engine: AnyRunEngine;
  checkpointStore: CheckpointStore;
  observability?: RunEngineObservability;
}

/**
 * The pieces the resolver pre-allocates for a recovered run so the reattached
 * ActiveRun can surface live events (#28):
 * - `emitter` — what `runStep` dispatches step events to during resume; it becomes
 *   the reattached ActiveRun's event surface (reattach reuses this exact instance).
 * - `stopToolboxForward` — the cleanup for the `toolbox → emitter` forwarding that
 *   the RESOLVER wires immediately (the moment services are built), so `toolbox:*`
 *   action events are captured from the very first resumed step. Wiring it at
 *   reattach instead would drop events the toolbox emits in the window between the
 *   resolver firing (inside `recoverAll`) and reattach installing the bridge.
 *   Reattach takes ownership and calls it on completion; the drain/dispose paths
 *   call it for entries that are never reattached, so the subscription never leaks.
 */
export interface PendingRecoveryEvents {
  emitter: CompletableEventTarget<CombinedOperativeEventMap>;
  stopToolboxForward: () => void;
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
   * Per-recovered-run emitters the resolver pre-allocates and injects into the
   * rebuilt `services` (#28), keyed by `runId`. `reattachRecoveredRun` consumes
   * (and DELETES) the entry so the reattached ActiveRun reuses the SAME emitter
   * the resumed generator's `runStep` dispatches to — closing seam #10's toolbox/
   * step-event visibility for recovered runs. Entry lifetime is one boot recovery
   * pass: any entry the resolver populated but recovery did not reattach (the run
   * failed/skipped) MUST be drained, since the emitter closes over nothing
   * credential-bearing itself but the Map otherwise leaks across boots. The bureau
   * clears it on dispose as a backstop.
   */
  pendingRecoveryEmitters: Map<string, PendingRecoveryEvents>;
  /**
   * Run ids the durable engine flagged, during boot recovery, as resuming
   * under a DIFFERENT workflow version than the one they were checkpointed
   * with (AB-10 — workflow versioning for in-flight durable runs). Populated
   * by the `onWorkflowVersionMismatch` callback wired into `createRunEngine`,
   * which fires once per recovered run BEFORE `engine.recoverAll()` returns —
   * so this set is fully populated by the time the bureau's recovery loop
   * calls `classifyRecoveredRun`. Never cleared: entries are read exactly once
   * per boot recovery pass and the set is rebuilt fresh on the next boot.
   */
  workflowVersionMismatches: Set<string>;
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
  memory: Memory | undefined;
  sessionStore: SessionStore | undefined;
  scheduler: Scheduler | undefined;
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
      /** Active-skill entries to pre-seed the run's SkillSession for durable recovery. */
      initialActiveSkills?: ReadonlyArray<ActiveSkillEntry>;
    },
  ): Promise<{
    generate: GenerateFunction;
    toolbox: Toolbox;
    prepareStep: PrepareStepHook[];
    onStep: OnStepHook[];
    validateResponse: ValidateResponseHook[];
    streamEventTarget: TypedEventTarget<StreamEventMap> | undefined;
    getActiveSkillEntries: () => ActiveSkillEntry[];
  }>;
}

export async function createRuntimeComposition(
  options: BureauOptions,
  dependencies: RuntimeCompositionDependencies = defaultRuntimeCompositionDependencies,
): Promise<RuntimeComposition> {
  const maximumSteps = options.maximumSteps ?? 10;
  const systemPrompt = options.systemPrompt;

  // Gate the resolver until the whole composition is assembled. `createRunEngine`
  // is constructed with `startScheduler: true` BELOW, before later consts
  // (`sessionStore`, the `createRunRuntime` closure deps) are initialized — so a
  // persisted schedule's poller tick could fire `resolveRunServices` mid-build and
  // hit a not-yet-initialized binding (review: codex). This flag, declared before
  // the engine and flipped true just before we return, lets the resolver bail out
  // cleanly (the fire fails terminally and the next tick — once ready — succeeds).
  // Recovery is unaffected: the bureau calls `recoverAll()` only after this returns.
  let compositionReady = false;

  // #28: per-recovered-run emitter+toolbox the resolver pre-allocates and the
  // bureau's reattach loop consumes — see RuntimeComposition.pendingRecoveryEmitters.
  const pendingRecoveryEmitters = new Map<string, PendingRecoveryEvents>();

  // AB-10: run ids the durable engine flags as version-mismatched during boot
  // recovery — see RuntimeComposition.workflowVersionMismatches.
  const workflowVersionMismatches = new Set<string>();

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

  // The effective StorageConfiguration to resolve: prefer the new `persistence`
  // form over the legacy `storage` field.
  const effectiveStorageConfig = persistenceStorageConfig ?? options.storage;

  let kv: ConditionalTextValueStore | undefined = persistenceKvStore;
  // Keep the raw Storage so the durable engine can share the exact backend with
  // the text-value KV view (Weft requires one engine per durable store).
  let durableStorage: Storage | undefined;
  if (!kv && effectiveStorageConfig) {
    durableStorage = await resolveStorage(effectiveStorageConfig);
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
  const wantsDurable =
    options.durableExecution ??
    (effectiveStorageConfig !== undefined &&
      effectiveStorageConfig.type !== 'memory' &&
      !hasKvOnlyPersistence);

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
    // startScheduler: true is then REQUIRED too (Weft 0.6.0). recover:false
    // decouples *who drives recovery* from *whether timers fire*, and the poller
    // defaults to following recover — so without this flag a recover:false engine
    // leaves durable `ctx.sleep(...)` / `engine.schedule(...)` timers parked
    // forever. The bureau owns recovery but still needs durable timers, so it
    // arms the poller explicitly.
    durable = await createRunEngine({
      storage: durableStorage,
      runWorkflow,
      checkpointStore,
      recover: false,
      startScheduler: true,
      resolveWorkflowServices: resolveRunServices,
      ...(effectiveObservability !== undefined ? { observability: effectiveObservability } : {}),
      ...(effectiveOnLog ? { onLog: effectiveOnLog } : {}),
      // durableGuardrails is a Pick of these exact CreateRunEngineOptions fields, so
      // it spreads straight through; createRunEngine guards each one internally, so
      // passing `undefined` members is harmless.
      ...options.durableGuardrails,
      // history from PersistenceOptions takes precedence over durableGuardrails.history
      ...(persistenceHistory !== undefined ? { history: persistenceHistory } : {}),
      runWorkflowVersion: options.workflowVersion,
      // AB-10: record the mismatch so the boot recovery loop below can pass it
      // to `classifyRecoveredRun` (distinct 'reattach-version-mismatch' verdict)
      // before it inspects `workflowVersionMismatches`.
      onWorkflowVersionMismatch: (event: WorkflowVersionMismatchEvent) => {
        workflowVersionMismatches.add(event.runId);
        console.warn(
          `[bureau] Recovered run "${event.runId}" was checkpointed under workflow version ` +
            `"${event.storedVersion}" but is resuming under "${event.registeredVersion}". ` +
            `Recovery proceeds against the currently-deployed code (pin-and-warn) — see ` +
            `documentation/workflow-versioning.md.`,
        );
      },
    });
  }

  let memory: Memory | undefined;
  if (options.memory) {
    memory = isMemoryInstance(options.memory) ? options.memory : createMemory(options.memory);
    await memory.init();
  }

  // Resolve the SkillProvider from the bureau's persistence store when no
  // explicit provider is supplied — same store-sharing pattern as memory.
  // `createStorageSkillProvider` wraps the KV view with the `skill:` prefix
  // namespace (disjoint from Weft's reserved prefixes and memory's
  // `app:agent-bureau:memory:v1:` prefix — asserted disjoint by test).
  //
  // The resolved provider is typed as `SkillsPackageProvider` (the full skills
  // package interface with `saveResource`/`setEnabled`) so it is accepted by
  // `createSkillCatalogHook`, which expects the full interface. The bureau's
  // local `SkillProvider` type is a structural subset and is compatible.
  const resolvedSkillProvider: SkillsPackageProvider | undefined =
    (options.skills?.provider as SkillsPackageProvider | undefined) ??
    (options.skills !== undefined && kv !== undefined ? createStorageSkillProvider(kv) : undefined);

  const sessionStore = kv ? createSessionStore(kv) : undefined;
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- BureauToolbox variance; scheduler does not inspect tool tuple types
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

  function createRunRuntime(
    request: CreateRunRequest & { sessionId: string; runId?: string },
    runtimeOptions?: {
      liveStreaming?: boolean;
      /**
       * Active-skill entries to seed the run's {@link SkillSession} with on
       * construction. Used by the durable recovery path: when
       * `buildRunDepsFromSession` rebuilds deps for a recovered run, it reads the
       * `lastActiveSkills` snapshot from session metadata and passes it here so the
       * recovered toolbox is aware of skills activated in completed pre-crash steps
       * (those steps are memoized and do not re-run their `activate_skill` calls).
       */
      initialActiveSkills?: ReadonlyArray<ActiveSkillEntry>;
    },
  ) {
    const liveStreaming = runtimeOptions?.liveStreaming ?? true;
    const streamEventTarget =
      !liveStreaming || options.generate !== undefined || options.streaming?.enabled === false
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; bureau never inspects the type parameter
    let toolbox: Toolbox<any> =
      options.toolbox !== undefined
        ? baseToolbox.extend()
        : hasSkillTools
          ? fallbackToolbox.extend()
          : createUnavailableToolbox();
    const prepareStep: PrepareStepHook[] = [];
    const onStep: OnStepHook[] = [];
    const validateResponse: ValidateResponseHook[] = [];
    let getActiveSkillEntries = (): ActiveSkillEntry[] => [];

    if (options.identity) {
      prepareStep.push(createIdentityHook(options.identity));
    }

    if (memory) {
      prepareStep.push(createMemoryRecallHook(memory, request.sessionId));
      onStep.push(createMemoryPersistHook(memory, request.sessionId, request.runId));
    }

    if (options.skills && resolvedSkillProvider) {
      // Use a policy-tracking session so getActiveEntries() can reconstruct the
      // per-skill policy for the durable snapshot hook (see createTrackedSkillSession).
      const skillSession = createTrackedSkillSession();

      // Seed active skills from a prior checkpoint on durable recovery. Completed
      // pre-crash steps are memoized by Weft and do not re-run their tool
      // executions, so a fresh empty session would miss any `activate_skill` calls
      // made in those steps. `initialActiveSkills` carries the last-known snapshot
      // (written by createSkillStateSnapshotHook after each step) so the recovered
      // toolbox reflects the pre-crash active set without replaying the tools.
      // Replay classification: seam #11 — safe (read-only rehydration from
      // persisted state; no external side effect on the skill provider).
      if (runtimeOptions?.initialActiveSkills) {
        for (const entry of runtimeOptions.initialActiveSkills) {
          skillSession.activate(entry.name, entry.toolPolicy);
        }
      }
      getActiveSkillEntries = () => skillSession.getActiveEntries();

      if (options.skills.includeTools !== false) {
        // Inject the skill catalog on step 0 — same hook pattern as identity.
        // `createSkillCatalogHook` from the `skills` package handles enabled-status
        // filtering, skill policy (allow/deny list), and graceful degradation on
        // provider errors. The hook caches the catalog for the run (one fetch per run).
        //
        // The catalog is gated on `includeTools !== false` because its text directs
        // the model to call `activate_skill`. When tools are disabled, that tool is
        // not wired and a model following the catalog instruction would call an
        // unavailable tool and fail. All three skill-tool surfaces (toolbox, tool
        // summaries, and catalog) must be consistently absent when tools are off.
        // (PRRT_kwDORvupsc6MZ-vj)
        const catalogHook = createSkillCatalogHook({
          provider: resolvedSkillProvider,
          skillPolicy: options.skills.skillPolicy,
        });
        prepareStep.push(async (context) => {
          const catalog = await catalogHook.prepareStep(context);
          if (catalog) {
            context.conversation.appendSystemMessage(catalog, {
              _skillCatalogInjected: true,
            });
          }
        });

        const skillToolbox = createSkillManagementToolbox(resolvedSkillProvider, skillSession);
        toolbox = combineToolboxes(toolbox, skillToolbox);
      }

      // Snapshot the active skill set to session metadata after each step.
      // Present only when a session store is configured (durable / KV-backed path).
      // This is what allows buildRunDepsFromSession to rehydrate the skill set on
      // a cross-process recovery (see resolveRunServices → buildRunDepsFromSession).
      if (sessionStore) {
        onStep.push(
          createSkillStateSnapshotHook(
            skillSession,
            request.sessionId,
            sessionStore,
            request.runId,
          ),
        );
      }
    }

    if (options.guardrails) {
      const guardrails = createGuardrails(options.guardrails);
      prepareStep.push(guardrails.prepareStep);
      validateResponse.push(guardrails.validateResponse);
    }

    return Promise.resolve({
      generate,
      toolbox,
      prepareStep,
      onStep,
      validateResponse,
      streamEventTarget,
      getActiveSkillEntries,
    });
  }

  /**
   * Rebuild a recovered run's non-serializable {@link DurableRunDeps} from durable
   * config: reconstruct the run runtime from the owning session's persisted
   * request — the same `createRunRuntime` a fresh run uses. Returns `null` when
   * the session is absent (the run is not bureau-owned / not reconstructable).
   *
   * The reconstructed `conversation` is a placeholder: a resumed run reads its
   * transcript from the checkpoint, not from `options.conversation`. No `emitter`
   * is attached — a recovered run has no live event surface (the accepted
   * seam #5b: recovered runs are observable via `getSession`, not `getRun`).
   */
  async function buildRunDepsFromSession(
    session: Awaited<ReturnType<NonNullable<typeof sessionStore>['load']>>,
    runId?: string,
    agentName?: string,
  ): Promise<DurableRunDeps | null> {
    if (!session) return null;
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
    // before the crash. `lastActiveSkills` is written by createSkillStateSnapshotHook
    // after each step boundary and is validated here before use (PRRT_kwDORvupsc6MZ1Md).
    const lastActiveSkillsRaw = session.metadata['lastActiveSkills'];
    const initialActiveSkills = isActiveSkillEntryArray(lastActiveSkillsRaw)
      ? lastActiveSkillsRaw
      : undefined;
    const runRuntime = await createRunRuntime(
      {
        message: typeof message === 'string' ? message : '',
        sessionId: session.id,
        // Thread the recovered run's id so the memory-persist hook's idempotency
        // key (`${runId}:${step}`) matches the pre-crash execution — the durable
        // recovery path is exactly where the at-least-once re-fire happens.
        ...(runId !== undefined ? { runId } : {}),
        ...(agentName !== undefined ? { agentName } : {}),
      },
      { liveStreaming: false, initialActiveSkills },
    );
    return {
      toolbox: runRuntime.toolbox,
      getStepMetadata: () => ({
        [activeSkillsStepMetadataKey]: activeSkillsStepMetadata(runRuntime.getActiveSkillEntries()),
      }),
      options: {
        generate: runRuntime.generate,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Toolbox generic variance; the durable layer never inspects the tool-tuple type parameter (matches createRunRuntime's internal Toolbox<any>).
        toolbox: runRuntime.toolbox,
        conversation: new Conversation(session.conversationHistory),
        maximumSteps: recoveredMaximumSteps,
        stopWhen: options.stopWhen,
        prepareStep: runRuntime.prepareStep,
        onStep: runRuntime.onStep,
        validateResponse: runRuntime.validateResponse,
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
    getActiveSkillEntries: () => ActiveSkillEntry[],
  ): OnStepHook {
    return async (context) => {
      await store.update(sessionId, (existing: AgentSession | undefined) => {
        const activeSkillEntries = getActiveSkillEntries();
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
              : activeSkillSessionMetadataForStep(activeSkillEntries, context.step, runId)),
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

  async function loadScheduleIdForRecoveredRun(
    workflowId: string,
  ): Promise<RecoveredScheduleMarker> {
    if (!durableStorage) return { status: 'missing' };
    try {
      const value = await durableStorage.get(KEYS.scheduleRun(workflowId));
      if (!value) return { status: 'missing' };
      const decoded = decode(value);
      return typeof decoded === 'string' && decoded.trim().length > 0
        ? { status: 'found', scheduleId: decoded }
        : { status: 'missing' };
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
  ): Promise<ActiveSkillEntry[] | undefined> {
    if (!recovering || !session) return undefined;

    const metadata = session.metadata;
    const lastActiveSkillsRaw = metadata['lastActiveSkills'];
    const lastActiveSkillsStep = metadata['lastActiveSkillsStep'];
    if (
      metadata['lastScheduledFireRunId'] !== runId ||
      metadata['lastActiveSkillsRunId'] !== runId ||
      typeof lastActiveSkillsStep !== 'number' ||
      !Number.isInteger(lastActiveSkillsStep) ||
      lastActiveSkillsStep < 0
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
        .filter((step) => step.step <= lastActiveSkillsStep)
        .sort((a, b) => b.step - a.step)
        .find((step) => activeSkillsFromStepMetadata(step.metadata) !== undefined);

      if (latestCommittedStep !== undefined) {
        return activeSkillsFromStepMetadata(latestCommittedStep.metadata);
      }

      if (
        committedStepRecords.some((step) => step.step === lastActiveSkillsStep) &&
        isActiveSkillEntryArray(lastActiveSkillsRaw)
      ) {
        return lastActiveSkillsRaw;
      }

      return undefined;
    } catch (error) {
      options.onLog?.({
        workflowId: runId,
        workflowType: 'agentRun',
        timestamp: Date.now(),
        level: 'warn',
        message: `Unable to verify scheduled fire skill snapshot checkpoint for run "${runId}": ${serializeUnknownError(error)}`,
      });
      return undefined;
    }
  }

  /**
   * Build fresh {@link DurableRunDeps} for a NATIVE WEFT SCHEDULE FIRE (#109).
   *
   * Discriminated by `info.schedule !== undefined` on a live timer tick, or by a
   * persisted `ScheduledAgentRunInput` that carries the schedule marker written by
   * `createAgentSchedule()` during `recoverAll()` (Weft does not currently include
   * `info.schedule` on recovered scheduled fires). It builds deps exactly as a
   * fresh `createRun` would, seeding the conversation with the scheduled prompt
   * and using `info.workflowId` (the per-fire id Weft minted) as the runId. The
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
    const existingStatelessSessionId =
      !recurring && recoveredScheduleId === undefined
        ? recoveredMarkerSessionId(recoveredScheduleMarker)
        : undefined;
    const sessionId =
      scheduledInput.sessionId ??
      existingStatelessSessionId ??
      `sched-${recoveredScheduleId ?? 'unknown'}-${runId}`;

    // A recurring fire continues its stored session; a fresh-per-fire (stateless)
    // session never exists yet. A recurring schedule's FIRST fire into a new
    // sessionId also has no stored session — that case must seed the systemPrompt
    // too, exactly as createRunFromRequest does for any new session (a recurring
    // session that already exists already carries the prompt from its first fire,
    // so it is not re-seeded).
    const existing =
      recurring || info.schedule === undefined ? await store.load(sessionId) : undefined;
    const replaceCurrentFireTranscript =
      info.schedule === undefined && existing?.metadata['lastScheduledFireRunId'] === runId;
    let conversation: Conversation;
    if (existing) {
      conversation = new Conversation(
        replaceCurrentFireTranscript
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
    const initialActiveSkills = await loadCommittedScheduledActiveSkills(
      existing,
      runId,
      info.schedule === undefined,
    );

    const runRuntime = await createRunRuntime(
      { message: scheduledInput.input, sessionId, runId, agentName },
      { liveStreaming: false, initialActiveSkills },
    );

    const services: DurableRunDeps = {
      toolbox: runRuntime.toolbox,
      getStepMetadata: () => ({
        [activeSkillsStepMetadataKey]: activeSkillsStepMetadata(runRuntime.getActiveSkillEntries()),
      }),
      options: {
        generate: runRuntime.generate,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Toolbox generic variance; the durable layer never inspects the tool-tuple type parameter (matches createRunRuntime's internal Toolbox<any>).
        toolbox: runRuntime.toolbox,
        conversation,
        maximumSteps,
        stopWhen: options.stopWhen,
        prepareStep: runRuntime.prepareStep,
        // Append the session write-back hook so recurring fires accumulate and a
        // stateless fire is observable; runs AFTER the runtime's own onStep hooks.
        onStep: [
          ...runRuntime.onStep,
          createScheduledSessionPersistHook(
            store,
            sessionId,
            agentName,
            baseConversationHistory,
            runId,
            replaceCurrentFireTranscript,
            runRuntime.getActiveSkillEntries,
          ),
        ],
        validateResponse: runRuntime.validateResponse,
        agentName,
        runId,
      },
    };

    // Plain available services — no `emitter`, and intentionally NOT registered in
    // `pendingRecoveryEmitters` and NOT wrapped in the C3 tool-bubble forwarding.
    // Those exist so the bureau's reattach loop can consume them for a recovered
    // ActiveRun; a scheduled fire has no reattach behind it, so wiring them would
    // leak a Map entry + toolbox subscription per fire.
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
    if (!compositionReady) {
      return { status: 'unavailable', reason: `run ${info.workflowId}: composition not ready` };
    }
    if (!sessionStore) {
      return { status: 'unavailable', reason: 'no session store configured' };
    }
    // NATIVE SCHEDULED FIRE (#109/#126): Weft sets `info.schedule` for a live
    // schedule tick, but recovered scheduled fires may only carry the persisted
    // ScheduledAgentRunInput. Recovery must also see the persisted schedule marker
    // written by createAgentSchedule(); the broad `{ agentName, input }` shape alone
    // is not enough to bypass the interactive session-ownership guards below.
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
        console.error(
          `[bureau] Could not inspect scheduled session proof for recovered run "${info.workflowId}"; continuing without scheduled-fire classification: ${serializeUnknownError(error)}`,
        );
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

    let services: DurableRunDeps | null;
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
        console.error(
          `[bureau] Failed to reconcile unrecoverable run "${info.workflowId}" ` +
            `(session ${sessionId}) to error: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        );
      }
      return { status: 'unavailable', reason: `run ${info.workflowId} not reconstructable` };
    }
    if (services === null) {
      // Unreachable now (the owning-session check above guarantees a non-null
      // session, and `buildRunDepsFromSession` only returns null for a null
      // session) — kept as a defensive fail-closed in case that invariant ever
      // changes, since rebuilding from a null session would otherwise NPE.
      return { status: 'unavailable', reason: `run ${info.workflowId} not reconstructable` };
    }
    // #28: pre-allocate the recovered run's emitter HERE (before the generator
    // advances) and inject it into the rebuilt services, so `runStep` dispatches
    // its step events to it during resume. CRITICAL (Codex round-1): also wire the
    // `toolbox → emitter` forwarding RIGHT NOW, not at reattach — `toolbox:*` action
    // events originate from the toolbox, and a recovered run can fire its first
    // step (inside `recoverAll`) before the bureau's reattach loop runs on the next
    // turn. Forwarding from the moment the toolbox exists closes that window. The
    // bureau's reattach loop reuses this same emitter (by runId) as the reattached
    // ActiveRun's surface and takes ownership of `stopToolboxForward`; the Map entry
    // is drained (and the forward stopped) by reattach, the cancel/skip branches, or
    // dispose, so the subscription never leaks across boots.
    const recoveryEmitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const toolboxForward = forwardEvents(
      // The toolbox is variance-widened; the durable layer never inspects the
      // tool-tuple type, matching createDurableActiveRun's documented cast.
      services.toolbox as unknown as ForwardableSource,
      recoveryEmitter,
      'toolbox',
    );

    // C3 — curated tool.* bubble events stamped with {agentName, runId, step}.
    // Mirrors the same block in createDurableActiveRun so the audit trail and
    // operative store receive identical tool.* events regardless of whether the
    // run is freshly started or durably recovered. Without this, recovered runs
    // emitted blank-id tool.* events (regression PRRT_kwDORvupsc6MXoT3).
    //
    // Wire from HERE (not at reattach) — mirrors the toolboxForward rationale:
    // a recovered run can fire its first step INSIDE recoverAll before the
    // bureau's reattach loop runs, so we must capture tool events from the
    // moment the toolbox exists. Cleanup is bundled into stopToolboxForward so
    // the subscriptions live exactly as long as the toolbox forwarding.
    const recoveryC3Cleanups: Array<(() => void) | undefined> = [];
    {
      const runId = info.workflowId;
      const agentName = info.input.agentName;
      let currentStep = 0;

      const stepListener = (e: StepStartedEvent) => {
        currentStep = e.step;
      };
      recoveryEmitter.addEventListener(StepStartedEvent.type, stepListener);
      recoveryC3Cleanups.push(() =>
        recoveryEmitter.removeEventListener(StepStartedEvent.type, stepListener),
      );

      const toolbox = services.toolbox as unknown as {
        addEventListener?: <K extends keyof ToolboxEventMap>(
          type: K,
          listener: (e: ToolboxEventMap[K]) => void,
          options?: AddEventListenerOptions,
        ) => () => void;
      };

      const onExecuteStart = (e: ToolboxEventMap['execute-start']) => {
        recoveryEmitter.dispatchEvent(
          new ToolStartedBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: e.call.name,
              toolCallId: e.call.id,
              params: e.params,
              startedAt: Date.now(),
            },
          ),
        );
      };

      const onSettled = (e: ToolboxEventMap['settled']) => {
        const hasError = e.error !== undefined;
        const status: 'success' | 'error' = hasError ? 'error' : 'success';
        recoveryEmitter.dispatchEvent(
          new ToolSettledBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: e.call.name,
              toolCallId: e.call.id,
              status,
              result: e.result,
              error: e.error,
            },
          ),
        );
        if (hasError) {
          recoveryEmitter.dispatchEvent(
            new ToolErrorBubbleEvent(
              { agentName, runId, step: currentStep },
              {
                toolName: e.call.name,
                toolCallId: e.call.id,
                error: e.error,
              },
            ),
          );
        }
      };

      const onToolProgress = (e: ToolboxEventMap['progress']) => {
        recoveryEmitter.dispatchEvent(
          new ToolProgressBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: e.call.name,
              toolCallId: e.call.id,
              percent: e.percent,
              message: e.message,
            },
          ),
        );
      };

      const onPolicyDenied = (e: ToolboxEventMap['policy-denied']) => {
        recoveryEmitter.dispatchEvent(
          new ToolPolicyDeniedBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: e.call.name,
              toolCallId: e.call.id,
              reason: e.reason,
            },
          ),
        );
      };

      if (toolbox.addEventListener) {
        const addListener = toolbox.addEventListener.bind(toolbox);
        recoveryC3Cleanups.push(
          addListener('execute-start', onExecuteStart),
          addListener('settled', onSettled),
          addListener('progress', onToolProgress),
          addListener('policy-denied', onPolicyDenied),
        );
      }
    }

    pendingRecoveryEmitters.set(info.workflowId, {
      emitter: recoveryEmitter,
      stopToolboxForward: () => {
        toolboxForward.stop();
        for (const cleanup of recoveryC3Cleanups) cleanup?.();
      },
    });
    return { status: 'available', services: { ...services, emitter: recoveryEmitter } };
  }

  // Every closure dependency the resolver reads is now initialized; open the gate
  // so scheduler-poller ticks (and the bureau's subsequent `recoverAll()`) resolve.
  compositionReady = true;

  return {
    kv,
    durable,
    pendingRecoveryEmitters,
    workflowVersionMismatches,
    disposeStorage: durableStorage ? () => durableStorage[Symbol.dispose]() : undefined,
    memory,
    sessionStore,
    scheduler,
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
  };
}
