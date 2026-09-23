import type { AnthropicTool } from './adapters/anthropic/types';
import type { GeminiTool } from './adapters/gemini/types';
import type { OpenAITool } from './adapters/openai/types';
import type { ToolConfiguration } from './is-tool';
import type { ImportedToolboxOptions, ToolboxOptions } from './toolbox-contracts';
import { createImportedToolbox } from './toolbox-imports';
import type { Toolbox } from './toolbox-interface';
import type { ToolProvider } from './types';

type CreateToolbox = (entries?: readonly ToolConfiguration[], options?: ToolboxOptions) => Toolbox;

export function createToolboxProviderSurface(createToolbox: CreateToolbox) {
  return {
    fromOpenAITools: (
      tools: OpenAITool | readonly OpenAITool[],
      options: ImportedToolboxOptions = {},
    ) => createToolboxFromOpenAITools(tools, options, createToolbox),
    fromAnthropicTools: (
      tools: AnthropicTool | readonly AnthropicTool[],
      options: ImportedToolboxOptions = {},
    ) => createToolboxFromAnthropicTools(tools, options, createToolbox),
    fromGeminiTools: (
      tools: GeminiTool | readonly GeminiTool[],
      options: ImportedToolboxOptions = {},
    ) => createToolboxFromGeminiTools(tools, options, createToolbox),
    fromProvider: (
      provider: ToolProvider,
      definitions:
        | OpenAITool
        | readonly OpenAITool[]
        | AnthropicTool
        | readonly AnthropicTool[]
        | GeminiTool
        | readonly GeminiTool[],
      options: ImportedToolboxOptions = {},
    ) => createToolboxFromProvider(provider, definitions, options, createToolbox),
  };
}

export async function createToolboxFromOpenAITools(
  tools: OpenAITool | readonly OpenAITool[],
  options: ImportedToolboxOptions,
  createToolbox: CreateToolbox,
): Promise<Toolbox> {
  const { fromOpenAITools } = await import('./adapters/openai');
  if (isOpenAITool(tools)) {
    return createImportedToolbox(fromOpenAITools(tools), options, createToolbox);
  }
  if (isOpenAIToolArray(tools)) {
    return createImportedToolbox(fromOpenAITools(tools), options, createToolbox);
  }
  throw new TypeError('OpenAI provider definitions are invalid.');
}

export async function createToolboxFromAnthropicTools(
  tools: AnthropicTool | readonly AnthropicTool[],
  options: ImportedToolboxOptions,
  createToolbox: CreateToolbox,
): Promise<Toolbox> {
  const { fromAnthropicTools } = await import('./adapters/anthropic');
  if (isAnthropicTool(tools)) {
    return createImportedToolbox(fromAnthropicTools(tools), options, createToolbox);
  }
  if (isAnthropicToolArray(tools)) {
    return createImportedToolbox(fromAnthropicTools(tools), options, createToolbox);
  }
  throw new TypeError('Anthropic provider definitions are invalid.');
}

export async function createToolboxFromGeminiTools(
  tools: GeminiTool | readonly GeminiTool[],
  options: ImportedToolboxOptions,
  createToolbox: CreateToolbox,
): Promise<Toolbox> {
  const { fromGeminiTools } = await import('./adapters/gemini');
  return createImportedToolbox(fromGeminiTools(tools), options, createToolbox);
}

export async function createToolboxFromProvider(
  provider: ToolProvider,
  definitions:
    | OpenAITool
    | readonly OpenAITool[]
    | AnthropicTool
    | readonly AnthropicTool[]
    | GeminiTool
    | readonly GeminiTool[],
  options: ImportedToolboxOptions,
  createToolbox: CreateToolbox,
): Promise<Toolbox> {
  switch (provider) {
    case 'openai':
      return createToolboxFromOpenAITools(requireOpenAITools(definitions), options, createToolbox);
    case 'anthropic':
      return createToolboxFromAnthropicTools(
        requireAnthropicTools(definitions),
        options,
        createToolbox,
      );
    case 'gemini':
      return createToolboxFromGeminiTools(requireGeminiTools(definitions), options, createToolbox);
    default:
      return Promise.reject(new TypeError('Unsupported provider.'));
  }
}

function requireOpenAITools(
  value:
    | OpenAITool
    | readonly OpenAITool[]
    | AnthropicTool
    | readonly AnthropicTool[]
    | GeminiTool
    | readonly GeminiTool[],
): OpenAITool | readonly OpenAITool[] {
  if (Array.isArray(value)) {
    if (value.every(isOpenAITool)) return value;
  } else if (isOpenAITool(value)) {
    return value;
  }
  throw new TypeError('OpenAI provider definitions are invalid.');
}

function requireAnthropicTools(
  value:
    | OpenAITool
    | readonly OpenAITool[]
    | AnthropicTool
    | readonly AnthropicTool[]
    | GeminiTool
    | readonly GeminiTool[],
): AnthropicTool | readonly AnthropicTool[] {
  if (Array.isArray(value)) {
    if (value.every(isAnthropicTool)) return value;
  } else if (isAnthropicTool(value)) {
    return value;
  }
  throw new TypeError('Anthropic provider definitions are invalid.');
}

function requireGeminiTools(
  value:
    | OpenAITool
    | readonly OpenAITool[]
    | AnthropicTool
    | readonly AnthropicTool[]
    | GeminiTool
    | readonly GeminiTool[],
): GeminiTool | readonly GeminiTool[] {
  if (Array.isArray(value)) {
    if (value.every(isGeminiTool)) return value;
  } else if (isGeminiTool(value)) {
    return value;
  }
  throw new TypeError('Gemini provider definitions are invalid.');
}

function isOpenAITool(value: unknown): value is OpenAITool {
  if (!isRecord(value) || value['type'] !== 'function' || !isRecord(value['function']))
    return false;
  const definition = value['function'];
  return typeof definition['name'] === 'string' && isRecord(definition['parameters']);
}

function isOpenAIToolArray(value: unknown): value is readonly OpenAITool[] {
  return Array.isArray(value) && value.every(isOpenAITool);
}

function isAnthropicTool(value: unknown): value is AnthropicTool {
  return (
    isRecord(value) && typeof value['name'] === 'string' && typeof value['description'] === 'string'
  );
}

function isAnthropicToolArray(value: unknown): value is readonly AnthropicTool[] {
  return Array.isArray(value) && value.every(isAnthropicTool);
}

function isGeminiTool(value: unknown): value is GeminiTool {
  return isRecord(value) && Array.isArray(value['functionDeclarations']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
