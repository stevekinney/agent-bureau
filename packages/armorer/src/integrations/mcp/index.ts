import type { ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ElicitRequest,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
  Implementation,
  ServerNotification,
  ServerRequest,
  Tool as MCPTool,
  ToolAnnotations,
  ToolExecution,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { isZodSchema } from '../../core/schema-utilities';
import { createTool } from '../../create-tool';
import type {
  Tool,
  ToolElicitationRequest,
  ToolElicitationRequester,
  ToolElicitationResult,
  ToolExecuteWithOptions,
} from '../../is-tool';
import { isTool } from '../../is-tool';
import { jsonSchemaToZod } from '../../json-schema-to-zod';
import type { ToolResultLike } from '../../types';

type ToolboxLike = {
  tools: () => readonly Tool[];
  getAvailable?: () => Promise<ReadonlyArray<Tool>>;
  execute?: (
    call: { id?: string; name: string; arguments: unknown },
    options?: { signal?: AbortSignal; elicit?: ToolElicitationRequester },
  ) => Promise<ToolResultLike>;
  getTool?: (nameOrId: string) => Tool | undefined;
};

export type MCPToolConfiguration = {
  title?: string;
  description?: string;
  schema?: AnySchema;
  annotations?: ToolAnnotations;
  execution?: ToolExecution;
  meta?: Record<string, unknown>;
};

export type MCPResourceRegistrar = (server: McpServer) => void;
export type MCPPromptRegistrar = (server: McpServer) => void;

export type MCPToolLike = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: AnySchema;
  annotations?: ToolAnnotations;
  execution?: ToolExecution;
  _meta?: Record<string, unknown>;
};

export type MCPToolHandler = (
  args: unknown,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => Promise<CallToolResult>;

export type MCPToolDefinition = MCPToolLike & {
  inputSchema: AnySchema;
  handler: MCPToolHandler;
};

export type MCPToolSource = MCPTool | MCPToolLike | MCPToolDefinition;

export type ToMCPToolsOptions = {
  toolConfiguration?: (tool: Tool) => MCPToolConfiguration;
  formatResult?: (result: ToolResultLike) => CallToolResult;
  executeTool?: (
    tool: Tool,
    params: unknown,
    callId?: string,
    signal?: AbortSignal,
    elicit?: ToolElicitationRequester,
  ) => Promise<ToolResultLike>;
};

export type FromMCPToolsOptions = {
  callTool?: (request: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<CallToolResult>;
  formatResult?: (result: CallToolResult, tool: MCPToolSource) => unknown;
};

export type CreateMCPOptions = ServerOptions & {
  serverInfo?: Implementation;
  toolConfiguration?: ToMCPToolsOptions['toolConfiguration'];
  formatResult?: ToMCPToolsOptions['formatResult'];
  resources?: MCPResourceRegistrar | MCPResourceRegistrar[];
  prompts?: MCPPromptRegistrar | MCPPromptRegistrar[];
};

const DEFAULT_SERVER_INFO: Implementation = {
  name: 'toolbox',
  version: '0.0.0',
};

export async function createMCP(
  toolbox: ToolboxLike,
  options: CreateMCPOptions = {},
): Promise<McpServer> {
  const { serverInfo, toolConfiguration, formatResult, resources, prompts, ...serverOptions } =
    options;
  const { McpServer: McpServerClass } = await requireMcp();
  const server = new McpServerClass(serverInfo ?? DEFAULT_SERVER_INFO, serverOptions);
  const registered = new Map<string, RegisteredTool>();

  const registerTool = (tool: MCPToolDefinition) => {
    const toolName = tool.name;
    const existing = registered.get(toolName);
    if (existing) {
      existing.remove();
    }

    const registeredTool = server.registerTool(
      toolName,
      toMcpRegisteredToolConfiguration(tool),
      tool.handler,
    );

    registered.set(toolName, registeredTool);
  };

  const availableTools =
    typeof toolbox.getAvailable === 'function' ? await toolbox.getAvailable() : toolbox.tools();
  const executeTool =
    typeof toolbox.execute === 'function' && typeof toolbox.getTool === 'function'
      ? (
          tool: Tool,
          params: unknown,
          callId?: string,
          signal?: AbortSignal,
          elicit?: ToolElicitationRequester,
        ) =>
          toolbox.getTool!(tool.name) === tool
            ? toolbox.execute!(
                {
                  ...(callId !== undefined ? { id: callId } : {}),
                  name: tool.name,
                  arguments: params ?? {},
                },
                signal || elicit
                  ? { ...(signal ? { signal } : {}), ...(elicit ? { elicit } : {}) }
                  : undefined,
              )
            : tool.executeWith({
                params: params ?? {},
                ...(callId !== undefined ? { callId } : {}),
                ...(elicit ? { elicit } : {}),
              })
      : undefined;

  for (const tool of toMcpTools(availableTools, { toolConfiguration, formatResult, executeTool })) {
    registerTool(tool);
  }

  applyRegistrars(server, resources);
  applyRegistrars(server, prompts);

  return server;
}

export function toMcpTools(
  input: ToolboxLike | Tool | readonly Tool[],
  options: ToMCPToolsOptions = {},
): MCPToolDefinition[] {
  const tools = normalizeToolInput(input);
  return tools.map((tool) => toMcpToolDefinition(tool, options));
}

export function fromMcpTools(
  tools: readonly MCPToolSource[],
  options: FromMCPToolsOptions = {},
): Tool[] {
  return tools.map((mcpTool) => {
    const schema = resolveMcpSchema(mcpTool.inputSchema) ?? z.object({}).passthrough();
    const metadata = metadataFromMcpTool(mcpTool);
    const createOptions: Parameters<typeof createTool>[0] = {
      name: mcpTool.name,
      description: mcpTool.description ?? mcpTool.title ?? mcpTool.name,
      input: schema as z.ZodTypeAny,
      async execute(params) {
        const callResult = await executeMcpTool(mcpTool, params, options.callTool);
        return options.formatResult
          ? options.formatResult(callResult, mcpTool)
          : parseMcpCallResult(callResult);
      },
    };
    if (metadata) {
      createOptions.metadata = metadata;
    }
    return createTool(createOptions);
  }) as Tool[];
}

function toMcpToolDefinition(tool: Tool, options: ToMCPToolsOptions): MCPToolDefinition {
  const metadataConfiguration = toolConfigurationFromMetadata(tool);
  const configuration = {
    ...metadataConfiguration,
    ...(options.toolConfiguration?.(tool) ?? {}),
  };
  const meta = configuration.meta ?? tool.metadata;
  const readOnlyHint = tool.metadata?.readOnly === true;
  const annotations = readOnlyHint
    ? {
        ...(configuration.annotations ?? {}),
        ...(configuration.annotations?.readOnlyHint === undefined ? { readOnlyHint: true } : {}),
      }
    : configuration.annotations;
  const resolvedInputSchema =
    resolveMcpSchema(configuration.schema) ?? (tool.input as unknown as AnySchema);

  const mcpTool: MCPToolDefinition = {
    name: tool.name,
    description: configuration.description ?? tool.description,
    inputSchema: resolvedInputSchema,
    handler: async (args, extra) => {
      const params = args ?? {};
      let result: ToolResultLike;
      try {
        const callId = extra?.requestId !== undefined ? String(extra.requestId) : undefined;
        const elicit = extra ? createMcpToolElicitationRequester(extra) : undefined;
        if (options.executeTool) {
          result = await options.executeTool(tool, params, callId, extra?.signal, elicit);
        } else {
          const runnable = tool as unknown as {
            executeWith: (options: ToolExecuteWithOptions) => Promise<ToolResultLike>;
          };
          const executeOptions: ToolExecuteWithOptions = { params };
          if (callId !== undefined) {
            executeOptions.callId = callId;
          }
          if (extra?.signal) {
            executeOptions.signal = extra.signal;
          }
          if (elicit) {
            executeOptions.elicit = elicit;
          }
          result = await runnable.executeWith(executeOptions);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: toTextContent(message),
          isError: true,
        };
      }
      return options.formatResult ? options.formatResult(result) : toCallToolResult(result);
    },
  };

  if (configuration.title !== undefined) {
    mcpTool.title = configuration.title;
  }
  if (annotations !== undefined) {
    mcpTool.annotations = annotations;
  }
  if (configuration.execution !== undefined) {
    mcpTool.execution = configuration.execution;
  }
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    mcpTool._meta = meta;
  }

  return mcpTool;
}

function toMcpRegisteredToolConfiguration(tool: MCPToolDefinition): {
  title?: string;
  description?: string;
  inputSchema: AnySchema;
  annotations?: ToolAnnotations;
  execution?: ToolExecution;
  _meta?: Record<string, unknown>;
} {
  const configuration: {
    title?: string;
    description?: string;
    inputSchema: AnySchema;
    annotations?: ToolAnnotations;
    execution?: ToolExecution;
    _meta?: Record<string, unknown>;
  } = {
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
  if (tool.title !== undefined) {
    configuration.title = tool.title;
  }
  if (tool.annotations !== undefined) {
    configuration.annotations = tool.annotations;
  }
  if (tool.execution !== undefined) {
    configuration.execution = tool.execution;
  }
  if (tool._meta !== undefined) {
    configuration._meta = tool._meta;
  }
  return configuration;
}

function normalizeToolInput(input: ToolboxLike | Tool | readonly Tool[]): Tool[] {
  if (isToolboxLike(input)) {
    return [...input.tools()];
  }
  if (Array.isArray(input)) {
    return input.map((tool) => {
      if (!isTool(tool) && !isToolLike(tool)) {
        throw new TypeError('Invalid tool input: expected Tool');
      }
      return tool;
    });
  }
  if (isTool(input) || isToolLike(input)) {
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

function isToolLike(value: unknown): value is Tool {
  return (
    isRecord(value) &&
    isString(value['name']) &&
    isString(value['description']) &&
    'input' in value &&
    typeof value['executeWith'] === 'function'
  );
}

function hasMcpToolHandler(tool: MCPToolSource): tool is MCPToolDefinition {
  return typeof (tool as MCPToolDefinition).handler === 'function';
}

async function executeMcpTool(
  tool: MCPToolSource,
  params: unknown,
  callTool: FromMCPToolsOptions['callTool'],
): Promise<CallToolResult> {
  if (hasMcpToolHandler(tool)) {
    return tool.handler(params ?? {});
  }
  if (!callTool) {
    throw new Error(`fromMcpTools() requires callTool() for "${tool.name}".`);
  }
  return callTool({
    name: tool.name,
    arguments: isRecord(params) ? params : {},
  });
}

function metadataFromMcpTool(tool: MCPToolSource): Tool['metadata'] {
  const metadata: NonNullable<Tool['metadata']> = {};
  if (tool.annotations?.readOnlyHint === true) {
    metadata['readOnly'] = true;
  }

  const mcp: { title?: string; description?: string } = {};
  if (tool.title !== undefined) mcp['title'] = tool.title;
  if (tool.description !== undefined) mcp['description'] = tool.description;
  if (Object.keys(mcp).length) {
    metadata['mcp'] = mcp;
  }

  return Object.keys(metadata).length ? metadata : undefined;
}

function parseMcpCallResult(result: CallToolResult): unknown {
  if (result.isError) {
    throw new Error(extractMcpErrorMessage(result));
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  if (!content.length) {
    return undefined;
  }
  const textBlocks = content.filter(isTextContentBlock);
  if (textBlocks.length !== content.length) {
    return content;
  }
  const [first] = textBlocks;
  if (textBlocks.length === 1 && first) {
    return parseTextContent(first.text);
  }
  return textBlocks.map((block) => parseTextContent(block.text));
}

function extractMcpErrorMessage(result: CallToolResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join('\n');
  return text.trim().length ? text : 'MCP tool call failed.';
}

function parseTextContent(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isTextContentBlock(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value['type'] === 'text' && isString(value['text']);
}

function toCallToolResult(result: ToolResultLike): CallToolResult {
  if (result.outcome === 'error') {
    const message =
      result.error?.message ?? getLegacyErrorMessage(result) ?? stringifyResult(result.content);
    return {
      content: toTextContent(message),
      isError: true,
    };
  }

  const executionValue = getExecutionValue(result);
  const text = stringifyResult(executionValue);
  const content = toTextContent(text);
  const structured = toStructuredContent(executionValue);

  if (structured) {
    return {
      content,
      structuredContent: structured,
    };
  }

  return { content };
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

function getExecutionValue(result: ToolResultLike): unknown {
  if ('result' in result) {
    return result.result;
  }
  return result.content;
}

function getLegacyErrorMessage(result: ToolResultLike): string | undefined {
  if ('errorMessage' in result && typeof result.errorMessage === 'string') {
    return result.errorMessage;
  }
  return undefined;
}

function toStructuredContent(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toTextContent(text: string): CallToolResult['content'] {
  if (!text.length) return [];
  return [{ type: 'text' as const, text }];
}

export function toolConfigurationFromMetadata(tool: Tool): MCPToolConfiguration | undefined {
  const metadata = tool.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const mcp = (metadata as Record<string, unknown>)['mcp'];
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) {
    return undefined;
  }
  const configuration = mcp as Partial<MCPToolConfiguration>;
  const resolved: MCPToolConfiguration = {};
  if (configuration.title !== undefined) resolved.title = configuration.title;
  if (configuration.description !== undefined) resolved.description = configuration.description;
  if (configuration.schema !== undefined) resolved.schema = configuration.schema;
  let annotations = configuration.annotations ? { ...configuration.annotations } : undefined;
  if (metadata.readOnly === true) {
    if (!annotations) {
      annotations = { readOnlyHint: true };
    } else if (annotations.readOnlyHint === undefined) {
      annotations.readOnlyHint = true;
    }
  }
  if (annotations) resolved.annotations = annotations;
  if (configuration.execution !== undefined) resolved.execution = configuration.execution;
  if (configuration.meta !== undefined) resolved.meta = configuration.meta;
  return resolved;
}

function applyRegistrars(
  server: McpServer,
  registrars:
    | MCPResourceRegistrar
    | MCPPromptRegistrar
    | Array<MCPResourceRegistrar | MCPPromptRegistrar>
    | undefined,
) {
  if (!registrars) return;
  if (Array.isArray(registrars)) {
    for (const registrar of registrars) {
      registrar(server);
    }
    return;
  }
  registrars(server);
}

function resolveMcpSchema(schema: unknown): AnySchema | undefined {
  if (schema === undefined) return undefined;
  if (isZodSchema(schema)) return schema as unknown as AnySchema;
  if (isZodRawShape(schema)) {
    return z.object(schema) as unknown as AnySchema;
  }
  const converted = jsonSchemaToZod(schema);
  return converted ? (converted as unknown as AnySchema) : undefined;
}

function isZodRawShape(value: unknown): value is Record<string, z.ZodTypeAny> {
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every((entry) => isZodSchema(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

type McpSdk = typeof import('@modelcontextprotocol/sdk/server/mcp.js');

let cachedMcpSdk: McpSdk | undefined;
const defaultMcpLoader = async (): Promise<McpSdk> => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('@modelcontextprotocol/sdk/server/mcp.js') as McpSdk;
};
let mcpLoader: () => McpSdk | Promise<McpSdk> = defaultMcpLoader;

async function requireMcp(): Promise<McpSdk> {
  if (cachedMcpSdk) return cachedMcpSdk;
  try {
    cachedMcpSdk = await mcpLoader();
    return cachedMcpSdk;
  } catch (error) {
    const hint =
      'Missing peer dependency "@modelcontextprotocol/sdk". Install it to use armorer/mcp.';
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.message = `${hint}\n${wrapped.message}`;
    throw wrapped;
  }
}

type McpTypesSdk = typeof import('@modelcontextprotocol/sdk/types.js');

let cachedMcpTypesSdk: McpTypesSdk | undefined;
const defaultMcpTypesLoader = async (): Promise<McpTypesSdk> => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('@modelcontextprotocol/sdk/types.js') as McpTypesSdk;
};
let mcpTypesLoader: () => McpTypesSdk | Promise<McpTypesSdk> = defaultMcpTypesLoader;

async function requireMcpTypes(): Promise<McpTypesSdk> {
  if (cachedMcpTypesSdk) return cachedMcpTypesSdk;
  try {
    cachedMcpTypesSdk = await mcpTypesLoader();
    return cachedMcpTypesSdk;
  } catch (error) {
    const hint =
      'Missing peer dependency "@modelcontextprotocol/sdk". Install it to use armorer/mcp elicitation.';
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.message = `${hint}\n${wrapped.message}`;
    throw wrapped;
  }
}

/**
 * Translates a transport-agnostic {@link ToolElicitationRequest} into MCP
 * wire params for an `elicitation/create` request (form or URL mode).
 */
function toElicitRequestParams(
  request: ToolElicitationRequest,
): ElicitRequestFormParams | ElicitRequestURLParams {
  if (request.mode === 'url') {
    if (!request.url) {
      throw new TypeError('URL-mode elicitation requires a `url`.');
    }
    return {
      mode: 'url',
      message: request.message,
      url: request.url,
      elicitationId: crypto.randomUUID(),
      // The precise literal-typed `url` params shape is generated from the MCP
      // spec's zod schema; our generic request only carries the plain fields
      // that schema requires, so this cast is a boundary translation, not a
      // type-safety escape hatch.
    } as ElicitRequestURLParams;
  }
  return {
    mode: 'form',
    message: request.message,
    requestedSchema: (request.schema ?? {
      type: 'object',
      properties: {},
    }) as ElicitRequestFormParams['requestedSchema'],
  } as ElicitRequestFormParams;
}

/** Translates an MCP `ElicitResult` back into our transport-agnostic shape. */
function fromElicitResult(result: ElicitResult): ToolElicitationResult {
  if (result.action === 'accept') {
    return { action: 'accept', content: result.content ?? {} };
  }
  if (result.action === 'decline') {
    return { action: 'decline' };
  }
  return { action: 'cancel' };
}

/** Translates an MCP `ElicitRequest`'s params into our transport-agnostic shape. */
function toToolElicitationRequest(params: ElicitRequest['params']): ToolElicitationRequest {
  if (params.mode === 'url') {
    return { message: params.message, mode: 'url', url: params.url };
  }
  return {
    message: params.message,
    mode: 'form',
    schema: params.requestedSchema as unknown as Record<string, unknown>,
  };
}

/**
 * Translates our transport-agnostic result back into an MCP `ElicitResult`.
 * The wire schema requires `content` on every action (not just `accept`) —
 * the SDK's transform only fills in `{}` for genuinely `undefined` input, not
 * a missing key, so we always send the field explicitly.
 */
function toElicitResult(result: ToolElicitationResult): ElicitResult {
  return {
    action: result.action,
    content: (result.action === 'accept' ? (result.content ?? {}) : {}) as ElicitResult['content'],
  };
}

/**
 * Builds an MCP client request handler for `elicitation/create`, adapting a
 * transport-agnostic {@link ToolElicitationRequester} to the SDK's wire
 * shape. Register it on an MCP `Client` to handle elicitation requests sent
 * by a connected server:
 *
 * ```ts
 * import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
 * import { createMcpElicitationHandler } from 'armorer/mcp';
 *
 * client.setRequestHandler(
 *   ElicitRequestSchema,
 *   createMcpElicitationHandler(async (request) => {
 *     // request.mode === 'form' | 'url'
 *     return { action: 'accept', content: { approved: true } };
 *   }),
 * );
 * ```
 *
 * This is the "MCP client" direction (`fromMcpTools`): an elicitation
 * request from the connected server is translated into a
 * {@link ToolElicitationRequest} and handed to `respond`.
 */
export function createMcpElicitationHandler(
  respond: ToolElicitationRequester,
): (
  request: ElicitRequest,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => Promise<ElicitResult> {
  return async (request) => {
    const toolRequest = toToolElicitationRequest(request.params);
    const result = await respond(toolRequest);
    return toElicitResult(result);
  };
}

/**
 * Builds a {@link ToolElicitationRequester} backed by the MCP server's
 * `extra.sendRequest`, letting a tool's `execute` ask the connected client
 * for approval or human input mid-execution. This is the "MCP server"
 * direction (`createMCP`): the calling client answers the elicitation, and
 * the tool sees the response through `context.elicit(...)`.
 */
export function createMcpToolElicitationRequester(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ToolElicitationRequester {
  return async (request) => {
    const { ElicitResultSchema } = await requireMcpTypes();
    const params = toElicitRequestParams(request);
    const result = await extra.sendRequest(
      { method: 'elicitation/create', params },
      ElicitResultSchema,
    );
    return fromElicitResult(result as ElicitResult);
  };
}

export const internalMcpTestUtilities = {
  resetModuleState() {
    cachedMcpSdk = undefined;
    mcpLoader = defaultMcpLoader;
    cachedMcpTypesSdk = undefined;
    mcpTypesLoader = defaultMcpTypesLoader;
  },
  setModuleLoader(loader: (() => McpSdk | Promise<McpSdk>) | undefined) {
    cachedMcpSdk = undefined;
    mcpLoader = loader ?? defaultMcpLoader;
  },
};
