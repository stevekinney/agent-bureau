import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { BaseContext } from '@modelcontextprotocol/client';
import {
  McpServer,
  type CallToolResult,
  type ElicitRequest,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  type Implementation,
  type Tool as MCPTool,
  type RegisteredTool,
  type ServerContext,
  type ServerOptions,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { isZodSchema } from '../../core/schema-utilities';
import { createTool } from '../../create-tool';
import { createExecutionLifecycle } from '../../execution-lifecycle';
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
  schema?: unknown;
  annotations?: ToolAnnotations;
  meta?: Record<string, unknown>;
};

export type MCPResourceRegistrar = (server: McpServer) => void;
export type MCPPromptRegistrar = (server: McpServer) => void;

export type MCPToolLike = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

export type MCPToolHandler = (args: unknown, context?: ServerContext) => Promise<CallToolResult>;

export type MCPToolDefinition = MCPToolLike & {
  inputSchema: z.ZodType;
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
  /**
   * Reports whether the connected client declared the `elicitation`
   * capability. When it returns `false`, `context.elicit` is left
   * `undefined` instead of a requester that would fail at call time — tools
   * using the common `if (context.elicit)` feature-detection pattern then
   * correctly fall back to their no-elicitation path. Defaults to `true`
   * (always expose `elicit`) when omitted.
   */
  supportsElicitation?: () => boolean;
  /** Internal server-owned lifecycle used by createMCP. */
  executionLifecycle?: ReturnType<typeof createExecutionLifecycle>;
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

export type MCPServer = McpServer & {
  /** Inspects and controls request-scoped executions owned by this server. */
  executionLifecycle: ReturnType<typeof createExecutionLifecycle>;
  /** Closes admission, aborts and settles executions, and returns cleanup evidence. */
  shutdown: () => Promise<import('../../execution-lifecycle').ExecutionCleanupReport>;
};

const DEFAULT_SERVER_INFO: Implementation = {
  name: 'toolbox',
  version: '0.0.0',
};

// `toElicitRequestParams` is a standalone request-shaping utility, not
// composed from any toolbox's own `RuntimeServices`, so its identifier
// generation draws from one process-local default instance (AB-92 AC4,
// AB-254).
const defaultElicitationRuntime = createDefaultRuntimeServices();

/**
 * Creates an MCP server from a toolbox.
 *
 * Every toolbox tool is exposed as an ordinary MCP `tools/call` handler.
 */
export async function createMCP(
  toolbox: ToolboxLike,
  options: CreateMCPOptions = {},
): Promise<MCPServer> {
  const { serverInfo, toolConfiguration, formatResult, resources, prompts, ...serverOptions } =
    options;

  const availableTools =
    typeof toolbox.getAvailable === 'function' ? await toolbox.getAvailable() : toolbox.tools();
  const toolEntries = availableTools.map((tool) => ({
    tool,
    configuration: resolveToolConfiguration(tool, toolConfiguration),
  }));
  const executionLifecycle = createExecutionLifecycle('mcp-server');
  const server = new McpServer(serverInfo ?? DEFAULT_SERVER_INFO, serverOptions);
  const registered = new Map<string, RegisteredTool>();

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
                { ...(signal ? { signal } : {}), ...(elicit ? { elicit } : {}) },
              )
            : tool.executeWith({
                params: params ?? {},
                ...(callId !== undefined ? { callId } : {}),
                ...(elicit ? { elicit } : {}),
              })
      : undefined;

  const supportsElicitation = () =>
    server.server.getClientCapabilities()?.elicitation !== undefined;

  const toolOptions: ToMCPToolsOptions = {
    ...(toolConfiguration !== undefined ? { toolConfiguration } : {}),
    ...(formatResult !== undefined ? { formatResult } : {}),
    ...(executeTool !== undefined ? { executeTool } : {}),
    supportsElicitation,
    executionLifecycle,
  };

  for (const { tool, configuration } of toolEntries) {
    const toolName = tool.name;
    const existing = registered.get(toolName);
    if (existing) {
      existing.remove();
    }

    const definition = buildMcpToolDefinitionFromConfiguration(tool, configuration, toolOptions);
    const registeredTool: RegisteredTool = server.registerTool(
      toolName,
      toMcpRegisteredToolConfiguration(definition),
      definition.handler,
    );

    registered.set(toolName, registeredTool);
  }

  applyRegistrars(server, resources);
  applyRegistrars(server, prompts);

  // MCP's SDK close only tears down the transport. The server owns execution
  // admission, so close must first stop and settle every tool invocation.
  const sdkClose = server.close.bind(server);
  let shutdownPromise:
    Promise<import('../../execution-lifecycle').ExecutionCleanupReport> | undefined;
  let closePromise: Promise<void> | undefined;
  const shutdown = async () => {
    const report = await executionLifecycle.shutdown({
      policy: 'abort',
      reason: 'MCP server shut down',
    });
    return report;
  };
  server.close = () => {
    shutdownPromise ??= shutdown();
    closePromise ??= (async () => {
      await shutdownPromise;
      await sdkClose();
    })();
    return closePromise;
  };
  (server as MCPServer).shutdown = () => {
    shutdownPromise ??= shutdown();
    return shutdownPromise;
  };
  (server as MCPServer).executionLifecycle = executionLifecycle;

  return server as MCPServer;
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
    const schema = resolveMcpSchema(mcpTool.inputSchema) ?? z.object({}).loose();
    const metadata = metadataFromMcpTool(mcpTool);
    const createOptions = {
      name: mcpTool.name,
      description: mcpTool.description ?? mcpTool.title ?? mcpTool.name,
      input: schema,
      ...(metadata === undefined ? {} : { metadata }),
      async execute(params: unknown) {
        const callResult = await executeMcpTool(mcpTool, params, options.callTool);
        return options.formatResult
          ? options.formatResult(callResult, mcpTool)
          : parseMcpCallResult(callResult);
      },
    };
    return createTool(createOptions);
  });
}

/**
 * Resolves a tool's MCP configuration by merging metadata-derived
 * configuration (`tool.metadata.mcp`) with the caller-supplied
 * `toolConfiguration()` callback, mirroring the precedence used inline by
 * {@link toMcpToolDefinition} and {@link createMCP}.
 */
function resolveToolConfiguration(
  tool: Tool,
  toolConfiguration: ToMCPToolsOptions['toolConfiguration'],
): MCPToolConfiguration {
  const metadataConfiguration = toolConfigurationFromMetadata(tool);
  return {
    ...metadataConfiguration,
    ...toolConfiguration?.(tool),
  };
}

type ResolvedMcpToolShape = {
  title?: string;
  description: string;
  inputSchema: z.ZodType;
  annotations?: ToolAnnotations;
  meta?: Record<string, unknown>;
};

/** Resolves the title, description, schema, annotations, and metadata for MCP registration. */
function resolveMcpToolShape(
  tool: Tool,
  configuration: MCPToolConfiguration,
): ResolvedMcpToolShape {
  const meta = configuration.meta ?? tool.metadata;
  const readOnlyHint = tool.metadata?.readOnly === true;
  const annotations = readOnlyHint
    ? {
        ...configuration.annotations,
        ...(configuration.annotations?.readOnlyHint === undefined ? { readOnlyHint: true } : {}),
      }
    : configuration.annotations;
  const resolvedInputSchema = resolveMcpSchema(configuration.schema) ?? tool.input;

  const shape: ResolvedMcpToolShape = {
    description: configuration.description ?? tool.description,
    inputSchema: resolvedInputSchema,
  };
  if (configuration.title !== undefined) {
    shape.title = configuration.title;
  }
  if (annotations !== undefined) {
    shape.annotations = annotations;
  }
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    shape.meta = meta;
  }
  return shape;
}

function toMcpToolDefinition(tool: Tool, options: ToMCPToolsOptions): MCPToolDefinition {
  const configuration = resolveToolConfiguration(tool, options.toolConfiguration);
  return buildMcpToolDefinitionFromConfiguration(tool, configuration, options);
}

function buildMcpToolDefinitionFromConfiguration(
  tool: Tool,
  configuration: MCPToolConfiguration,
  options: ToMCPToolsOptions,
): MCPToolDefinition {
  const shape = resolveMcpToolShape(tool, configuration);

  const mcpTool: MCPToolDefinition = {
    name: tool.name,
    description: shape.description,
    inputSchema: shape.inputSchema,
    handler: async (args, context) => {
      const params = args ?? {};
      const execution = options.executionLifecycle?.begin({
        toolName: tool.name,
        callId: context?.mcpReq.id !== undefined ? String(context.mcpReq.id) : `mcp-${tool.name}`,
        ...(context?.mcpReq.signal !== undefined ? { signal: context.mcpReq.signal } : {}),
      });
      execution?.activate();
      let result: ToolResultLike;
      try {
        const callId = context?.mcpReq.id !== undefined ? String(context.mcpReq.id) : undefined;
        const clientSupportsElicitation = options.supportsElicitation
          ? options.supportsElicitation()
          : true;
        const elicit =
          context && clientSupportsElicitation
            ? createMcpToolElicitationRequester(context)
            : undefined;
        if (options.executeTool) {
          result = await options.executeTool(
            tool,
            params,
            callId,
            execution?.signal ?? context?.mcpReq.signal,
            elicit,
          );
        } else {
          const runnable = tool as unknown as {
            executeWith: (options: ToolExecuteWithOptions) => Promise<ToolResultLike>;
          };
          const executeOptions: ToolExecuteWithOptions = { params };
          if (callId !== undefined) {
            executeOptions.callId = callId;
          }
          const signal = execution?.signal ?? context?.mcpReq.signal;
          if (signal) {
            executeOptions.signal = signal;
          }
          if (elicit) {
            executeOptions.elicit = elicit;
          }
          result = await runnable.executeWith(executeOptions);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorResult = {
          content: toTextContent(message),
          isError: true,
        };
        execution?.settle(errorResult);
        return errorResult;
      }
      const callResult = options.formatResult
        ? options.formatResult(result)
        : toCallToolResult(result);
      execution?.settle(callResult);
      return callResult;
    },
  };

  if (shape.title !== undefined) {
    mcpTool.title = shape.title;
  }
  if (shape.annotations !== undefined) {
    mcpTool.annotations = shape.annotations;
  }
  if (shape.meta !== undefined) {
    mcpTool._meta = shape.meta;
  }

  return mcpTool;
}

function toMcpRegisteredToolConfiguration(tool: MCPToolDefinition): {
  title?: string;
  description?: string;
  inputSchema: z.ZodType;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
} {
  const configuration: {
    title?: string;
    description?: string;
    inputSchema: z.ZodType;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  } = {
    inputSchema: tool.inputSchema,
  };
  if (tool.title !== undefined) {
    configuration.title = tool.title;
  }
  if (tool.description !== undefined) {
    configuration.description = tool.description;
  }
  if (tool.annotations !== undefined) {
    configuration.annotations = tool.annotations;
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
    const message = result.error?.message ?? stringifyResult(result.content);
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

function resolveMcpSchema(schema: unknown): z.ZodType | undefined {
  if (schema === undefined) return undefined;
  if (isZodSchema(schema)) return schema;
  if (isZodRawShape(schema)) {
    return z.object(schema);
  }
  const converted = jsonSchemaToZod(schema);
  return converted || undefined;
}

function isZodRawShape(value: unknown): value is Record<string, z.ZodType> {
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
      elicitationId: defaultElicitationRuntime.identifiers.next('elicitation'),
      // The precise literal-typed `url` params shape is generated from the MCP
      // spec's zod schema; our generic request only carries the plain fields
      // that schema requires, so this cast is a boundary translation, not a
      // type-safety escape hatch.
    };
  }
  return {
    mode: 'form',
    message: request.message,
    requestedSchema: (request.schema ?? {
      type: 'object',
      properties: {},
    }) as ElicitRequestFormParams['requestedSchema'],
  };
}

/**
 * Translates an MCP `ElicitResult` back into our transport-agnostic shape.
 *
 * For an accepted form-mode result, validates `content` against the
 * requested schema first — a tool calling `context.elicit()` trusts the
 * response to honor the schema it asked for, so a client returning malformed
 * content (wrong types, missing required fields) fails loudly here instead
 * of silently reaching the tool and driving an incorrect action.
 */
function fromElicitResult(
  result: ElicitResult,
  request: ToolElicitationRequest,
): ToolElicitationResult {
  if (result.action === 'accept') {
    const content = result.content ?? {};
    if (request.mode !== 'url') {
      const schema = jsonSchemaToZod(request.schema ?? { type: 'object', properties: {} });
      const parsed = schema?.safeParse(content);
      if (parsed && !parsed.success) {
        throw new TypeError(
          `Elicitation response for "${request.message}" did not match the requested schema: ${parsed.error.message}`,
        );
      }
    }
    return { action: 'accept', content };
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
 * import { Client } from '@modelcontextprotocol/client';
 * import { createMcpElicitationHandler } from 'armorer';
 *
 * client.setRequestHandler(
 *   'elicitation/create',
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
): (request: ElicitRequest, extra: BaseContext) => Promise<ElicitResult> {
  return async (request) => {
    const toolRequest = toToolElicitationRequest(request.params);
    const result = await respond(toolRequest);
    return toElicitResult(result);
  };
}

/**
 * Builds a {@link ToolElicitationRequester} backed by the MCP server's
 * `context.mcpReq.elicitInput`, letting a tool's `execute` ask the connected client
 * for approval or human input mid-execution. This is the "MCP server"
 * direction (`createMCP`): the calling client answers the elicitation, and
 * the tool sees the response through `context.elicit(...)`.
 */
export function createMcpToolElicitationRequester(extra: ServerContext): ToolElicitationRequester {
  return async (request) => {
    const params = toElicitRequestParams(request);
    const result = await extra.mcpReq.elicitInput(
      params,
      // Propagate the tool call's abort signal so a cancelled `tools/call`
      // also cancels the nested `elicitation/create` request instead of
      // leaving it pending until the client answers or it times out.
      extra.mcpReq.signal ? { signal: extra.mcpReq.signal } : undefined,
    );
    return fromElicitResult(result, request);
  };
}
