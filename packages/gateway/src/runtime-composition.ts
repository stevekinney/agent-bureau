import type { TextValueStore } from '@lostgradient/weft/storage';
import { resolveStorage, textValueStore } from '@lostgradient/weft/storage';
import {
  combineToolboxes,
  createTool,
  createToolbox,
  type Toolbox,
  type ToolCallInput,
} from 'armorer';
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
import { TypedEventTarget } from 'lifecycle';
import type { CreateMemoryOptions, Memory } from 'memory';
import { createMemory } from 'memory';
import type {
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

function createMemoryPersistHook(memory: Memory, sessionId: string): OnStepHook {
  return async (context) => {
    if (!context.final || !context.content.trim()) {
      return;
    }

    await memory.remember(context.content, {
      namespace: sessionId,
      source: 'experiential',
      step: context.step,
    });
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

export interface RuntimeComposition {
  kv: TextValueStore | undefined;
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
    request: CreateRunRequest & { sessionId: string },
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

  let kv: TextValueStore | undefined = options.persistence;
  if (!kv && options.storage) {
    kv = textValueStore(await resolveStorage(options.storage));
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
        })
      : undefined;

  if (scheduler) {
    scheduler.start();
  }

  function createRunRuntime(
    request: CreateRunRequest & { sessionId: string },
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
      onStep.push(createMemoryPersistHook(memory, request.sessionId));
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

  return {
    kv,
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
