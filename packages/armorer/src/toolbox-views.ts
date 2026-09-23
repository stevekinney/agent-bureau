import type { AnthropicTool } from './adapters/anthropic/types';
import type { GeminiTool } from './adapters/gemini/types';
import type { OpenAIAdapterOptions } from './adapters/openai';
import type { OpenAITool } from './adapters/openai/types';
import type { InspectorDetailLevel, RegistryInspection } from './core/inspect';
import { inspectRegistry } from './core/inspect';
import type { AnyToolDefinition } from './core/tool-definition';
import type { RuntimeToolContext, ToolConfiguration } from './is-tool';
import type {
  SerializedToolbox,
  SerializedToolboxJSONSchema,
  ToolboxEntries,
  ToolboxOptions,
} from './toolbox-contracts';
import { normalizeToolCallArguments } from './toolbox-normalization';
import type { AvailableTools, ToolsFromEntries } from './toolbox-type-inference';
import type { ToolProvider } from './types';

type ToolboxViewContext<TEntries extends ToolboxEntries> = {
  readonly listTools: () => ToolsFromEntries<TEntries>;
  readonly listAvailableTools: () => Promise<AvailableTools<ToolsFromEntries<TEntries>>>;
  readonly listDefinitions: () => AnyToolDefinition[];
  readonly listAvailableDefinitions: () => Promise<AnyToolDefinition[]>;
  readonly getTool: (nameOrId: string) => ToolsFromEntries<TEntries>[number] | undefined;
  readonly storedConfigurations: () => readonly ToolConfiguration[];
  readonly createImportedExecute: (toolName: string) => ToolConfiguration['execute'];
  readonly serializeConfiguration: (
    configuration: ToolConfiguration,
  ) => SerializedToolboxJSONSchema[number];
  readonly runTool: (
    tool: ToolsFromEntries<TEntries>[number],
    parameters: unknown,
    context: unknown,
  ) => Promise<unknown>;
};

export function createToolboxViews<const TEntries extends ToolboxEntries>(
  context: ToolboxViewContext<TEntries>,
) {
  function tools(): ToolsFromEntries<TEntries> {
    return context.listTools();
  }

  function getTool(nameOrId: string): ToolsFromEntries<TEntries>[number] | undefined {
    return context.getTool(nameOrId);
  }

  function getMissingTools(names: string[]): string[] {
    return names.filter((name) => !context.getTool(name));
  }

  function hasAllTools(names: string[]): boolean {
    return names.every((name) => context.getTool(name));
  }

  async function getAvailable(): Promise<AvailableTools<ToolsFromEntries<TEntries>>> {
    return context.listAvailableTools();
  }

  function inspect(detailLevel: InspectorDetailLevel = 'standard'): RegistryInspection {
    return inspectRegistry(context.listDefinitions(), detailLevel);
  }

  async function toOpenAITools(): Promise<OpenAITool[]> {
    const { toOpenAITools: convertToOpenAITools } = await import('./adapters/openai');
    return convertToOpenAITools(await context.listAvailableDefinitions());
  }

  async function toAnthropicTools(): Promise<AnthropicTool[]> {
    const { toAnthropicTools: convertToAnthropicTools } = await import('./adapters/anthropic');
    return convertToAnthropicTools(await context.listAvailableDefinitions());
  }

  async function toGeminiTools(): Promise<GeminiTool[]> {
    const { toGeminiTools: convertToGeminiTools } = await import('./adapters/gemini');
    return convertToGeminiTools(await context.listAvailableDefinitions());
  }

  async function toProvider(
    provider: ToolProvider,
    adapterOptions?: unknown,
  ): Promise<OpenAITool[] | AnthropicTool[] | GeminiTool[]> {
    const availableTools = await context.listAvailableDefinitions();
    switch (provider) {
      case 'openai': {
        const { openAIToolAdapter } = await import('./adapters/openai');
        return openAIToolAdapter.export(availableTools, normalizeOpenAIOptions(adapterOptions));
      }
      case 'anthropic': {
        const { anthropicToolAdapter } = await import('./adapters/anthropic');
        return anthropicToolAdapter.export(availableTools);
      }
      case 'gemini': {
        const { geminiToolAdapter } = await import('./adapters/gemini');
        return geminiToolAdapter.export(availableTools);
      }
      default:
        return Promise.reject(new Error('Unsupported provider.'));
    }
  }

  function asExecuteResolver(): NonNullable<ToolboxOptions['getTool']> {
    return (configuration) => {
      const sourceTool = context.getTool(configuration.name);
      if (!sourceTool) return context.createImportedExecute(configuration.name);
      return async (parameters, toolContext) => {
        return context.runTool(
          sourceTool,
          parameters,
          requireRuntimeToolContext(toolContext, sourceTool, parameters),
        );
      };
    };
  }

  function toJSON(): SerializedToolbox;
  function toJSON(options: { format: 'configuration' }): SerializedToolbox;
  function toJSON(options: { format: 'json-schema' }): SerializedToolboxJSONSchema;
  function toJSON(options?: {
    format?: 'configuration' | 'json-schema';
  }): SerializedToolbox | SerializedToolboxJSONSchema {
    if (options?.format === 'json-schema') {
      return context
        .storedConfigurations()
        .map((configuration) => context.serializeConfiguration(configuration));
    }
    return context.storedConfigurations();
  }

  return {
    tools,
    getTool,
    getMissingTools,
    hasAllTools,
    getAvailable,
    inspect,
    toProvider,
    toOpenAITools,
    toAnthropicTools,
    toGeminiTools,
    asExecuteResolver,
    toJSON,
  };
}

export function requireRuntimeToolContext(
  value: unknown,
  tool: ToolsFromEntries<ToolboxEntries>[number],
  parameters: unknown,
): RuntimeToolContext {
  if (isRuntimeToolContext(value)) return value;
  const record = isRecord(value) ? value : {};
  const dispatch = Reflect.get(record, 'dispatch');
  return {
    ...record,
    dispatch: typeof dispatch === 'function' ? (event: Event) => dispatch(event) : () => true,
    progress: () => undefined,
    toolCall: { id: '', name: tool.name, arguments: normalizeToolCallArguments(parameters) },
    configuration: tool.configuration,
  };
}

function isRuntimeToolContext(value: unknown): value is RuntimeToolContext {
  if (!isRecord(value)) return false;
  return (
    typeof value['dispatch'] === 'function' &&
    typeof value['progress'] === 'function' &&
    isRecord(value['toolCall']) &&
    isRecord(value['configuration'])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeOpenAIOptions(value: unknown): OpenAIAdapterOptions | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('OpenAI adapter options must be an object.');
  }
  if (!('naming' in value) || value.naming === undefined) return {};
  if (value.naming === 'default' || value.naming === 'safe-id') return { naming: value.naming };
  throw new TypeError('OpenAI adapter option naming must be "default" or "safe-id".');
}
