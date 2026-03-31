import { combineToolboxes, createTool, createToolbox, type Toolbox } from 'armorer';
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
import type { KeyValueStore } from 'storage';
import { resolveKeyValueStore } from 'storage';
import { z } from 'zod';

import type {
  BureauOptions,
  CacheConfiguration,
  CreateRunRequest,
  ProviderConfiguration,
  ProviderRouteConfiguration,
  RoutingConfiguration,
  SkillCatalogEntry,
  SkillProvider,
  ToolPolicy,
  ToolSummary,
} from './types';

function isMemoryInstance(value: CreateMemoryOptions | Memory): value is Memory {
  return typeof (value as Memory).remember === 'function';
}

function redactProvider(provider: ProviderConfiguration): Omit<ProviderConfiguration, 'apiKey'> {
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
  store: KeyValueStore | undefined,
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

type SkillSession = {
  activate(name: string, toolPolicy?: ToolPolicy): void;
  deactivate(name: string): void;
  isActive(name: string): boolean;
};

function createSkillSession(): SkillSession {
  const active = new Map<string, ToolPolicy | undefined>();

  return {
    activate(name: string, toolPolicy?: ToolPolicy) {
      active.set(name, toolPolicy);
    },
    deactivate(name: string) {
      active.delete(name);
    },
    isActive(name: string) {
      return active.has(name);
    },
  };
}

function escapeXml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  };

  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

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

export interface RuntimeComposition {
  kv: KeyValueStore | undefined;
  memory: Memory | undefined;
  sessionStore: SessionStore | undefined;
  scheduler: Scheduler | undefined;
  ready: boolean;
  provider: Omit<ProviderConfiguration, 'apiKey'> | undefined;
  providers: ProviderRouteConfiguration[];
  maximumSteps: number;
  systemPrompt: string | undefined;
  getToolSummaries(): ToolSummary[];
  createRunRuntime(request: CreateRunRequest & { sessionId: string }): Promise<{
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
): Promise<RuntimeComposition> {
  const maximumSteps = options.maximumSteps ?? 10;
  const systemPrompt = options.systemPrompt;

  let kv: KeyValueStore | undefined = options.persistence;
  if (!kv && options.storage) {
    kv = await resolveKeyValueStore(options.storage);
  }

  let memory: Memory | undefined;
  if (options.memory) {
    memory = isMemoryInstance(options.memory) ? options.memory : createMemory(options.memory);
    await memory.init();
  }

  const sessionStore = kv ? createSessionStore(kv) : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; gateway never inspects the type parameter
  const baseToolbox: Toolbox<any> = options.toolbox ?? createToolbox([], { context: {} });

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

  const schedulerGenerate =
    options.generate ??
    (baseProviders.length === 1 && !options.routing
      ? applyCache(
          resolveProviderGenerate(baseProviders[0]!.provider, undefined, options.streaming),
          options.cache,
          kv,
        )
      : undefined);

  const scheduler =
    schedulerGenerate && options.scheduler?.enabled !== false
      ? createScheduler({
          generate: schedulerGenerate,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Toolbox<any> variance; see baseToolbox annotation
          toolbox: baseToolbox,
          idleDelay: options.scheduler?.idleDelay ?? 1000,
        })
      : undefined;

  if (scheduler) {
    scheduler.start();
  }

  function createRunRuntime(request: CreateRunRequest & { sessionId: string }) {
    const streamEventTarget =
      options.streaming?.enabled === false ? undefined : new TypedEventTarget<StreamEventMap>();

    let generate: GenerateFunction | undefined = options.generate;

    if (!generate) {
      if (baseProviders.length === 0) {
        generate = undefined;
      } else if (options.routing && baseProviders.length > 1) {
        const routingConfiguration = createRoutingStrategy(options.routing);
        const routes = baseProviders.map((route) => ({
          name: route.name,
          generate: resolveProviderGenerate(route.provider, streamEventTarget, options.streaming),
        }));

        const routingGenerate = createRoutingGenerate({
          routes,
          fallback: routes[0]!.name,
          strategy: routingConfiguration.strategy,
        });

        generate =
          routingConfiguration.kind === 'cost-aware'
            ? withUsageTracking(routingGenerate, routingConfiguration.onUsage)
            : routingGenerate;
      } else if (baseProviders.length > 1) {
        generate = createFalloverGenerate({
          providers: baseProviders.map((route) => ({
            name: route.name,
            generate: resolveProviderGenerate(route.provider, streamEventTarget, options.streaming),
          })),
        });
      } else {
        generate = resolveProviderGenerate(
          baseProviders[0]!.provider,
          streamEventTarget,
          options.streaming,
        );
      }
    }

    if (!generate) {
      throw new Error('No generate function configured');
    }

    generate = applyCache(generate, options.cache, kv);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Toolbox generic variance; gateway never inspects the type parameter
    let toolbox: Toolbox<any> = baseToolbox;
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
