import type { Tool, ToolResult } from '../../../index';
import { isTool } from '../../../is-tool';

type ToolboxLike = {
  tools: () => readonly Tool[];
};

type OpenAIAgentsModule = typeof import('@openai/agents');
type OpenAIAgentsStrictToolOptions = Extract<
  Parameters<OpenAIAgentsModule['tool']>[0],
  { strict?: true }
>;
type OpenAIAgentsToolParameters = OpenAIAgentsStrictToolOptions['parameters'];

export type OpenAIAgentTool = ReturnType<OpenAIAgentsModule['tool']>;

export type OpenAIAgentToolConfiguration = {
  name?: string;
  description?: string;
  parameters?: OpenAIAgentsToolParameters;
};

export type OpenAIAgentToolOptions = {
  toolConfiguration?: (tool: Tool) => OpenAIAgentToolConfiguration;
  formatResult?: (result: ToolResult) => unknown;
};

export type OpenAIAgentToolsResult = {
  tools: OpenAIAgentTool[];
  toolNames: string[];
  mutatingToolNames: string[];
  dangerousToolNames: string[];
};

export type OpenAIToolGateOptions = {
  registry: ToolboxLike | Tool | readonly Tool[];
  readOnly?: boolean;
  allowMutation?: boolean;
  allowDangerous?: boolean;
  builtin?: {
    readOnly?: string[];
    mutating?: string[];
    dangerous?: string[];
  };
  allowUnknown?: boolean;
  toolConfiguration?: (tool: Tool) => OpenAIAgentToolConfiguration;
  messages?: {
    mutating?: string;
    dangerous?: string;
    unknown?: (toolName: string) => string;
  };
};

export type OpenAIToolGateDecision = { behavior: 'allow' | 'deny'; message?: string };

/**
 * Converts Toolbox tools to OpenAI Agents SDK format.
 *
 * @example
 * ```ts
 * import { toOpenAIAgentTools } from 'armorer/open-ai/agents';
 *
 * const tools = await toOpenAIAgentTools(toolbox);
 *
 * const agent = new Agent({
 *   name: 'Assistant',
 *   instructions: 'You are a helpful assistant',
 *   tools: tools.tools,
 * });
 * ```
 */
export async function toOpenAIAgentTools(
  input: ToolboxLike | Tool | readonly Tool[],
  options: OpenAIAgentToolOptions = {},
): Promise<OpenAIAgentToolsResult> {
  const tools = normalizeToTools(input);
  const { tool: sdkTool } = await loadOpenAIAgentsModule();

  const toolNames: string[] = [];
  const mutatingToolNames: string[] = [];
  const dangerousToolNames: string[] = [];

  const sdkTools = tools.map((tool) => {
    const override = options.toolConfiguration?.(tool);
    const name = override?.name ?? tool.name;
    const description = override?.description ?? tool.description;
    const parameters =
      override?.parameters ?? (tool.input as unknown as OpenAIAgentsToolParameters);

    toolNames.push(name);
    if (isMutating(tool)) mutatingToolNames.push(name);
    if (isDangerous(tool)) dangerousToolNames.push(name);

    return sdkTool({
      name,
      description,
      parameters,
      strict: true,
      execute: async (args: unknown) => {
        const result = await tool.executeWith({ params: args ?? {} });
        return options.formatResult
          ? options.formatResult(result)
          : formatToolResult(result);
      },
    });
  });

  return {
    tools: sdkTools,
    toolNames,
    mutatingToolNames,
    dangerousToolNames,
  };
}

export function createOpenAIToolGate(
  options: OpenAIToolGateOptions,
): (toolName: string) => Promise<OpenAIToolGateDecision> {
  const readOnly = options.readOnly ?? false;
  const allowMutation = options.allowMutation ?? !readOnly;
  const allowDangerous = options.allowDangerous ?? true;
  const builtin = options.builtin ?? {};
  const allowUnknown = options.allowUnknown ?? false;
  const messages = {
    mutating:
      options.messages?.mutating ??
      (readOnly
        ? 'Read-only mode: mutating tools disabled.'
        : 'Use --apply to allow mutating tools.'),
    dangerous:
      options.messages?.dangerous ??
      (readOnly || !allowMutation
        ? 'Use --apply to allow mutating tools.'
        : 'Use --dangerous to allow this tool.'),
    unknown: options.messages?.unknown ?? ((name: string) => `Tool not allowed: ${name}`),
  };

  const registryTools = normalizeToTools(options.registry);
  const toolInfo = new Map<
    string,
    {
      mutating: boolean;
      dangerous: boolean;
    }
  >();
  for (const tool of registryTools) {
    const override = options.toolConfiguration?.(tool);
    const name = override?.name ?? tool.name;
    toolInfo.set(name, {
      mutating: isMutating(tool),
      dangerous: isDangerous(tool),
    });
  }

  const readOnlyTools = new Set(builtin.readOnly ?? []);
  const mutatingTools = new Set(builtin.mutating ?? []);
  const dangerousTools = new Set(builtin.dangerous ?? []);

  return (toolName: string) => {
    const info = toolInfo.get(toolName);
    if (info) {
      if (info.mutating && (readOnly || !allowMutation)) {
        return Promise.resolve({ behavior: 'deny', message: messages.mutating });
      }
      if (info.dangerous && !allowDangerous) {
        return Promise.resolve({ behavior: 'deny', message: messages.dangerous });
      }
      return Promise.resolve({ behavior: 'allow' });
    }

    if (readOnlyTools.has(toolName)) {
      return Promise.resolve({ behavior: 'allow' });
    }
    if (mutatingTools.has(toolName)) {
      if (readOnly || !allowMutation) {
        return Promise.resolve({ behavior: 'deny', message: messages.mutating });
      }
      return Promise.resolve({ behavior: 'allow' });
    }
    if (dangerousTools.has(toolName)) {
      if (!allowDangerous) {
        return Promise.resolve({ behavior: 'deny', message: messages.dangerous });
      }
      return Promise.resolve({ behavior: 'allow' });
    }
    if (allowUnknown) {
      return Promise.resolve({ behavior: 'allow' });
    }
    return Promise.resolve({
      behavior: 'deny',
      message: messages.unknown(toolName),
    });
  };
}

function normalizeToTools(input: ToolboxLike | Tool | readonly Tool[]): Tool[] {
  if (isToolboxLike(input)) {
    return [...input.tools()];
  }
  if (Array.isArray(input)) {
    return input.map((tool) => {
      if (!isTool(tool)) {
        throw new TypeError('Invalid tool input: expected Tool');
      }
      return tool;
    });
  }
  if (isTool(input)) {
    return [input];
  }
  throw new TypeError('Invalid input: expected tool, tool array, or Toolbox');
}

function isToolboxLike(value: unknown): value is ToolboxLike {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { tools?: unknown };
  return typeof candidate.tools === 'function';
}

function isMutating(tool: Tool): boolean {
  const metadata = tool.metadata;
  const tags = tool.tags?.map((tag) => tag.toLowerCase()) ?? [];
  const tagSet = new Set(tags);
  if (metadata?.mutates === true) return true;
  if (metadata?.readOnly === true) return false;
  if (tagSet.has('mutating')) return true;
  if (tagSet.has('readonly') || tagSet.has('read-only')) return false;
  return false;
}

function isDangerous(tool: Tool): boolean {
  const metadata = tool.metadata;
  const tags = tool.tags?.map((tag) => tag.toLowerCase()) ?? [];
  const tagSet = new Set(tags);
  if (metadata?.dangerous === true) return true;
  if (tagSet.has('dangerous')) return true;
  return false;
}

function formatToolResult(result: ToolResult): unknown {
  if (result.outcome === 'error') {
    const message =
      result.error?.message ?? result.errorMessage ?? stringifyResult(result.content);
    throw new Error(message);
  }

  return result.result;
}

function stringifyResult(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

let cachedOpenAIAgentsModule: OpenAIAgentsModule | undefined;
let cachedOpenAIAgentsModulePromise: Promise<OpenAIAgentsModule> | undefined;
const defaultOpenAIAgentsModuleLoader = () => import('@openai/agents');
let openAIAgentsModuleLoader: () => Promise<OpenAIAgentsModule> =
  defaultOpenAIAgentsModuleLoader;

async function loadOpenAIAgentsModule(): Promise<OpenAIAgentsModule> {
  if (cachedOpenAIAgentsModule) return cachedOpenAIAgentsModule;
  if (!cachedOpenAIAgentsModulePromise) {
    cachedOpenAIAgentsModulePromise = openAIAgentsModuleLoader()
      .then((module) => {
        cachedOpenAIAgentsModule = module;
        return module;
      })
      .catch((error) => {
        const hint =
          'Missing peer dependency "@openai/agents". Install it to use armorer/open-ai/agents.';
        const wrapped = error instanceof Error ? error : new Error(String(error));
        wrapped.message = `${hint}\n${wrapped.message}`;
        throw wrapped;
      });
  }
  return cachedOpenAIAgentsModulePromise;
}

export const internalOpenAIAgentsTestUtilities = {
  resetModuleState() {
    cachedOpenAIAgentsModule = undefined;
    cachedOpenAIAgentsModulePromise = undefined;
    openAIAgentsModuleLoader = defaultOpenAIAgentsModuleLoader;
  },
  setModuleLoader(loader: (() => Promise<OpenAIAgentsModule>) | undefined) {
    cachedOpenAIAgentsModule = undefined;
    cachedOpenAIAgentsModulePromise = undefined;
    openAIAgentsModuleLoader = loader ?? defaultOpenAIAgentsModuleLoader;
  },
};
