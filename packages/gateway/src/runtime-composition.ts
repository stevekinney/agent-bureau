import type { WorkflowServicesResolution, WorkflowServicesResolverInfo } from '@lostgradient/weft';
import type { Storage, TextValueStore } from '@lostgradient/weft/storage';
import { resolveStorage, textValueStore } from '@lostgradient/weft/storage';
import {
  combineToolboxes,
  createTool,
  createToolbox,
  type Toolbox,
  type ToolCallInput,
} from 'armorer';
import { Conversation } from 'conversationalist';
import {
  createAnthropicGenerate,
  createAnthropicGenerateStream,
  createComplexityStrategy,
  createCostAwareStrategy,
  createFalloverGenerate,
  createGeminiGenerate,
  createGeminiGenerateStream,
  createOpenAIGenerate,
  createOpenAIGenerateStream,
  createRoutingGenerate,
  createStepBasedStrategy,
} from 'herald';
import type { ForwardableSource, HookReplayPolicy } from 'lifecycle';
import { CompletableEventTarget, forwardEvents, TypedEventTarget } from 'lifecycle';
import type { CreateMemoryOptions, Memory } from 'memory';
import { createMemory } from 'memory';
import type {
  CombinedOperativeEventMap,
  GenerateFunction,
  OnStepHook,
  PrepareStepHook,
  Scheduler,
  SessionStore,
  StreamEventMap,
  ValidateResponseHook,
} from 'operative';
import {
  createGuardrails,
  createIdentityHook,
  createScheduler,
  createSessionStore,
  withCache,
  withEnhancedStreaming,
} from 'operative';
import type {
  AnyRunEngine,
  CheckpointStore,
  DurableRunDeps,
  RunEngineObservability,
} from 'operative/durable';
import {
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  isAgentRunWorkflowInput,
  SCHEDULER_RUN_ID_PREFIX,
} from 'operative/durable';
import type { SkillSession } from 'skills';
import { createSkillSession, escapeXml } from 'skills';
import { z } from 'zod';

import type {
  BureauOptions,
  CacheConfiguration,
  CreateRunRequest,
  ProviderConfiguration,
  RedactedProviderConfiguration,
  RedactedProviderRouteConfiguration,
  RoutingConfiguration,
  SkillCatalogEntry,
  SkillProvider,
  ToolPolicy,
  ToolSummary,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; gateway never inspects the type parameter
type GatewayToolbox = Toolbox<any>;

function isMemoryInstance(value: CreateMemoryOptions | Memory): value is Memory {
  return typeof (value as Memory).remember === 'function';
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
        return withEnhancedStreaming(createAnthropicGenerateStream(provider), {
          eventTarget: streamEventTarget,
          onTextDelta: streamingConfiguration?.onTextDelta,
        });
      case 'openai':
        return withEnhancedStreaming(createOpenAIGenerateStream(provider), {
          eventTarget: streamEventTarget,
          onTextDelta: streamingConfiguration?.onTextDelta,
        });
      case 'gemini':
        return withEnhancedStreaming(createGeminiGenerateStream(provider), {
          eventTarget: streamEventTarget,
          onTextDelta: streamingConfiguration?.onTextDelta,
        });
      default:
        break;
    }
  }

  switch (provider.provider) {
    case 'anthropic':
      return createAnthropicGenerate(provider);
    case 'openai':
      return createOpenAIGenerate(provider);
    case 'gemini':
      return createGeminiGenerate(provider);
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

async function buildSkillCatalog(
  provider: SkillProvider,
  skillPolicy: ToolPolicy | undefined,
): Promise<string | undefined> {
  let entries = await provider.listSkills();

  const enabledChecks = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      enabled: await provider.isEnabled(entry.name),
    })),
  );
  entries = enabledChecks.filter((entry) => entry.enabled).map((entry) => entry.entry);

  if (skillPolicy?.allowList) {
    const allowed = new Set(skillPolicy.allowList);
    entries = entries.filter((entry) => allowed.has(entry.name));
  }

  if (skillPolicy?.denyList) {
    const denied = new Set(skillPolicy.denyList);
    entries = entries.filter((entry) => !denied.has(entry.name));
  }

  if (entries.length === 0) {
    return undefined;
  }

  const skillElements = entries
    .map(
      (entry: SkillCatalogEntry) =>
        `<skill name="${escapeXml(entry.name)}">${escapeXml(entry.description)}</skill>`,
    )
    .join('\n');

  return `<available_skills>
You have the following skills available. Use the activate_skill tool to load a skill's full instructions.

${skillElements}
</available_skills>`;
}

function createSkillManagementToolbox(
  provider: SkillProvider,
  session: SkillSession,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; gateway never inspects the type parameter
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

function createUnavailableToolbox(): GatewayToolbox {
  const emptyToolbox = createToolbox([], { context: {} });
  const execute = ((
    toolCalls: ToolCallInput | ToolCallInput[],
    executionOptions?: Parameters<GatewayToolbox['execute']>[1],
  ) => {
    const normalizedToolCalls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
    if (normalizedToolCalls.length > 0) {
      throw new Error('No toolbox configured but tool calls were received');
    }

    return emptyToolbox.execute([], executionOptions);
  }) as unknown as GatewayToolbox['execute'];

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
  kv: TextValueStore | undefined;
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
    options?: { liveStreaming?: boolean },
  ): Promise<{
    generate: GenerateFunction;
    toolbox: Toolbox;
    prepareStep: PrepareStepHook[];
    onStep: OnStepHook[];
    validateResponse: ValidateResponseHook[];
    streamEventTarget: TypedEventTarget<StreamEventMap> | undefined;
  }>;
}

export async function createRuntimeComposition(
  options: BureauOptions,
  dependencies: RuntimeCompositionDependencies = defaultRuntimeCompositionDependencies,
): Promise<RuntimeComposition> {
  const maximumSteps = options.maximumSteps ?? 10;
  const systemPrompt = options.systemPrompt;

  // #28: per-recovered-run emitter+toolbox the resolver pre-allocates and the
  // bureau's reattach loop consumes — see RuntimeComposition.pendingRecoveryEmitters.
  const pendingRecoveryEmitters = new Map<string, PendingRecoveryEvents>();

  let kv: TextValueStore | undefined = options.persistence;
  // Keep the raw Storage so the durable engine can share the exact backend with
  // the text-value KV view (Weft requires one engine per durable store).
  let durableStorage: Storage | undefined;
  if (!kv && options.storage) {
    durableStorage = await resolveStorage(options.storage);
    kv = textValueStore(durableStorage, { disposeUnderlyingStorage: false });
  }

  // Durable execution is ON BY DEFAULT whenever a PERSISTENT storage backend is
  // configured AND no custom `persistence` shadows it — a normal `createRun()`
  // that crashes resumes from its last checkpoint with no opt-in. The default
  // follows persistence because that is the only place resume is real: `memory`
  // storage loses its checkpoints with the process, so default-on there would be
  // pure overhead with zero recovery. The `persistence === undefined` guard keeps
  // `wantsDurable` ⟺ buildable: a custom `persistence` shadows `storage` (the
  // block above is skipped, so `durableStorage` is never resolved), and the
  // engine and session store cannot then share one backend — so the honest
  // default there is OFF, not a silently-wanted-but-unbuilt engine. The explicit
  // `durableExecution` flag overrides the default either way — `true` forces the
  // engine on even for `memory` (so durable behavior is testable locally),
  // `false` forces it off even for sqlite/lmdb.
  const wantsDurable =
    options.durableExecution ??
    (options.storage !== undefined &&
      options.storage.type !== 'memory' &&
      options.persistence === undefined);

  // A custom `persistence` value shadows `storage` entirely (the
  // `if (!kv && options.storage)` block above is skipped), so no raw `Storage`
  // is resolved and a durable engine cannot be built on the same backend the
  // sessions live on. Durable recovery REQUIRES the checkpoint store and the
  // session store to share one durable backend — the boot reconstructor scans
  // the SESSION store for `running` runs, so checkpoints in a separate backend
  // would never be resumed. Therefore `durableExecution: true` + a custom
  // `persistence` is contradictory: honor it silently and we ship an engine
  // that looks durable but can't recover. Fail loud at composition instead.
  // (Flag UNSET + `persistence` is fine — it falls to the documented
  // default-off, since there was no explicit request to honor.)
  if (options.durableExecution === true && options.persistence !== undefined) {
    throw new Error(
      'durableExecution: true is incompatible with a custom `persistence` value. ' +
        'A durable engine must share its backend with the session store, but ' +
        '`persistence` shadows `storage` — so the engine and sessions would live ' +
        'on different backends and a recovered run could never be found. Provide ' +
        '`storage` (sqlite/lmdb) WITHOUT `persistence` to get durable execution, ' +
        'or drop `durableExecution: true` to use the custom persistence layer ' +
        'with the in-memory run loop.',
    );
  }

  let durable: DurableComposition | undefined;
  if (wantsDurable && durableStorage) {
    // Build the checkpoint store over the SAME backend the engine persists to.
    const checkpointStore = createCheckpointStore(
      textValueStore(durableStorage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow = createRunWorkflow(checkpointStore);
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
      ...(options.observability !== undefined ? { observability: options.observability } : {}),
      ...(options.onLog ? { onLog: options.onLog } : {}),
      // durableGuardrails is a Pick of these exact CreateRunEngineOptions fields, so
      // it spreads straight through; createRunEngine guards each one internally, so
      // passing `undefined` members is harmless.
      ...options.durableGuardrails,
    });
  }

  let memory: Memory | undefined;
  if (options.memory) {
    memory = isMemoryInstance(options.memory) ? options.memory : createMemory(options.memory);
    await memory.init();
  }

  const sessionStore = kv ? createSessionStore(kv) : undefined;
  const baseToolbox: GatewayToolbox = options.toolbox ?? createToolbox([], { context: {} });
  const hasSkillTools = options.skills !== undefined && options.skills.includeTools !== false;
  const fallbackToolbox: GatewayToolbox =
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- GatewayToolbox variance; scheduler does not inspect tool tuple types
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
    runtimeOptions?: { liveStreaming?: boolean },
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; gateway never inspects the type parameter
    let toolbox: Toolbox<any> = fallbackToolbox;
    const prepareStep: PrepareStepHook[] = [];
    const onStep: OnStepHook[] = [];
    const validateResponse: ValidateResponseHook[] = [];

    if (options.identity) {
      prepareStep.push(createIdentityHook(options.identity));
    }

    if (memory) {
      prepareStep.push(createMemoryRecallHook(memory, request.sessionId));
      onStep.push(createMemoryPersistHook(memory, request.sessionId, request.runId));
    }

    if (options.skills) {
      const skillSession = createSkillSession();

      prepareStep.push(async (context) => {
        if (context.step !== 0) {
          return;
        }

        const catalog = await buildSkillCatalog(
          options.skills!.provider,
          options.skills!.skillPolicy,
        );
        if (catalog) {
          context.conversation.appendSystemMessage(catalog, {
            _skillCatalogInjected: true,
          });
        }
      });

      if (options.skills.includeTools !== false) {
        const skillToolbox = createSkillManagementToolbox(options.skills.provider, skillSession);
        toolbox = combineToolboxes(toolbox, skillToolbox);
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
  ): Promise<DurableRunDeps | null> {
    if (!session) return null;
    const message = session.metadata['lastUserMessage'];
    const runRuntime = await createRunRuntime(
      {
        message: typeof message === 'string' ? message : '',
        sessionId: session.id,
        // Thread the recovered run's id so the memory-persist hook's idempotency
        // key (`${runId}:${step}`) matches the pre-crash execution — the durable
        // recovery path is exactly where the at-least-once re-fire happens.
        ...(runId !== undefined ? { runId } : {}),
      },
      { liveStreaming: false },
    );
    return {
      toolbox: runRuntime.toolbox,
      options: {
        generate: runRuntime.generate,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Toolbox generic variance; the durable layer never inspects the tool-tuple type parameter (matches createRunRuntime's internal Toolbox<any>).
        toolbox: runRuntime.toolbox,
        conversation: new Conversation(session.conversationHistory),
        maximumSteps,
        stopWhen: options.stopWhen,
        prepareStep: runRuntime.prepareStep,
        onStep: runRuntime.onStep,
        validateResponse: runRuntime.validateResponse,
      },
    };
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
    if (!sessionStore) {
      return { status: 'unavailable', reason: 'no session store configured' };
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
    // SCHEDULER-ORIGIN GUARD (#25): a durable scheduler run carries a SYNTHETIC
    // sessionId equal to its own runId, prefixed `scheduler-run-` (there is no
    // bureau session behind it). The resolver's `info` does NOT carry tags
    // (WorkflowServicesResolverInfo is {workflowId, workflowType, input}), so we
    // discriminate by `sessionId === runId` AND the scheduler id prefix. The prefix
    // is load-bearing for contractual safety: a genuine session run's id is
    // `run-<uuid>`, so even a session that coincidentally set `sessionId === runId`
    // is NOT misclassified. Return unavailable BEFORE the sessionStore.load — a
    // load would always miss, and a scheduler run is a live-process concern that
    // boot recovery must not resume as a session run. The boot sweep cancels any
    // suspended scheduler residue.
    if (
      info.input.sessionId === info.input.runId &&
      info.input.runId.startsWith(SCHEDULER_RUN_ID_PREFIX)
    ) {
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
      services = await buildRunDepsFromSession(session, info.workflowId);
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
    pendingRecoveryEmitters.set(info.workflowId, {
      emitter: recoveryEmitter,
      stopToolboxForward: () => toolboxForward.stop(),
    });
    return { status: 'available', services: { ...services, emitter: recoveryEmitter } };
  }

  return {
    kv,
    durable,
    pendingRecoveryEmitters,
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
