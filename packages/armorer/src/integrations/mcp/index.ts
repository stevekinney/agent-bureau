import { createRequire } from 'node:module';

import type { ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
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
import type { Tool, ToolExecuteWithOptions } from '../../is-tool';
import { isTool } from '../../is-tool';
import type { ToolResult } from '../../types';

type ToolboxLike = {
  tools: () => readonly Tool[];
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
  formatResult?: (result: ToolResult) => CallToolResult;
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

export function createMCP(
  toolbox: ToolboxLike,
  options: CreateMCPOptions = {},
): McpServer {
  const {
    serverInfo,
    toolConfiguration,
    formatResult,
    resources,
    prompts,
    ...serverOptions
  } = options;
  const { McpServer: McpServerClass } = requireMcp();
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

  for (const tool of toMcpTools(toolbox, { toolConfiguration, formatResult })) {
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
        ...(configuration.annotations?.readOnlyHint === undefined
          ? { readOnlyHint: true }
          : {}),
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
      let result: ToolResult;
      try {
        const runnable = tool as unknown as {
          executeWith: (options: ToolExecuteWithOptions) => Promise<ToolResult>;
        };
        const executeOptions: ToolExecuteWithOptions = { params };
        if (extra?.requestId !== undefined) {
          executeOptions.callId = String(extra.requestId);
        }
        if (extra?.signal) {
          executeOptions.signal = extra.signal;
        }
        result = await runnable.executeWith(executeOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: toTextContent(message),
          isError: true,
        };
      }
      return options.formatResult
        ? options.formatResult(result)
        : toCallToolResult(result);
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

function toCallToolResult(result: ToolResult): CallToolResult {
  if (result.outcome === 'error') {
    const message =
      result.error?.message ?? result.errorMessage ?? stringifyResult(result.content);
    return {
      content: toTextContent(message),
      isError: true,
    };
  }

  const text = stringifyResult(result.result);
  const content = toTextContent(text);
  const structured = toStructuredContent(result.result);

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

export function toolConfigurationFromMetadata(
  tool: Tool,
): MCPToolConfiguration | undefined {
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
  if (configuration.description !== undefined)
    resolved.description = configuration.description;
  if (configuration.schema !== undefined) resolved.schema = configuration.schema;
  let annotations = configuration.annotations
    ? { ...configuration.annotations }
    : undefined;
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

type JsonSchemaObject = {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: unknown;
  items?: unknown;
  enum?: unknown[];
  const?: unknown;
  nullable?: boolean;
  additionalProperties?: boolean | Record<string, unknown>;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
};

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

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny | undefined {
  if (!isRecord(schema)) return undefined;
  const definition = schema as JsonSchemaObject;

  if (Array.isArray(definition.anyOf)) {
    return applyNullable(unionSchemas(definition.anyOf.map(jsonSchemaToZod)), definition);
  }

  if (Array.isArray(definition.oneOf)) {
    return applyNullable(unionSchemas(definition.oneOf.map(jsonSchemaToZod)), definition);
  }

  if (Array.isArray(definition.allOf)) {
    return applyNullable(
      intersectSchemas(definition.allOf.map(jsonSchemaToZod)),
      definition,
    );
  }

  if (Array.isArray(definition.enum)) {
    return applyNullable(enumToZod(definition.enum), definition);
  }

  if (Object.prototype.hasOwnProperty.call(definition, 'const')) {
    return applyNullable(literalSchema(definition.const), definition);
  }

  const schemaType = definition.type;
  let base: z.ZodTypeAny | undefined;

  if (Array.isArray(schemaType)) {
    base = unionSchemas(schemaType.map((type) => schemaFromType(definition, type)));
  } else if (typeof schemaType === 'string') {
    base = schemaFromType(definition, schemaType);
  } else if (definition.properties || definition.additionalProperties !== undefined) {
    base = objectSchema(definition);
  }

  return applyNullable(base, definition);
}

function schemaFromType(
  definition: JsonSchemaObject,
  schemaType: string,
): z.ZodTypeAny | undefined {
  switch (schemaType) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return arraySchema(definition);
    case 'object':
      return objectSchema(definition);
    default:
      return undefined;
  }
}

function arraySchema(definition: JsonSchemaObject): z.ZodTypeAny {
  const { items } = definition;
  if (Array.isArray(items)) {
    const itemSchema = unionSchemas(items.map(jsonSchemaToZod)) ?? z.any();
    return z.array(itemSchema);
  }
  const itemSchema = jsonSchemaToZod(items) ?? z.any();
  return z.array(itemSchema);
}

function objectSchema(definition: JsonSchemaObject): z.ZodTypeAny {
  const properties = isRecord(definition.properties) ? definition.properties : {};
  const required = new Set(
    Array.isArray(definition.required) ? definition.required.filter(isString) : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    const schema = jsonSchemaToZod(value) ?? z.any();
    shape[key] = required.has(key) ? schema : schema.optional();
  }
  let objectSchema = z.object(shape);
  const additional = definition.additionalProperties;
  if (additional === false) {
    objectSchema = objectSchema.strict();
  } else if (isRecord(additional)) {
    const catchall = jsonSchemaToZod(additional) ?? z.any();
    objectSchema = objectSchema.catchall(catchall);
  } else {
    objectSchema = objectSchema.passthrough();
  }
  return objectSchema;
}

function enumToZod(values: unknown[]): z.ZodTypeAny | undefined {
  if (!values.length) {
    return z.never();
  }
  if (values.every((value) => typeof value === 'string')) {
    return z.enum(values as [string, ...string[]]);
  }
  const literals = values.map(literalSchema).filter(Boolean) as z.ZodTypeAny[];
  return unionSchemas(literals);
}

function literalSchema(value: unknown): z.ZodTypeAny | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return z.literal(value);
  }
  return undefined;
}

function unionSchemas(
  schemas: Array<z.ZodTypeAny | undefined>,
): z.ZodTypeAny | undefined {
  const filtered = schemas.filter(Boolean) as z.ZodTypeAny[];
  if (!filtered.length) return undefined;
  if (filtered.length === 1) return filtered[0];
  return z.union(filtered as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function intersectSchemas(
  schemas: Array<z.ZodTypeAny | undefined>,
): z.ZodTypeAny | undefined {
  const filtered = schemas.filter(Boolean) as z.ZodTypeAny[];
  if (!filtered.length) return undefined;
  return filtered.reduce((acc, schema) => z.intersection(acc, schema));
}

function applyNullable(
  schema: z.ZodTypeAny | undefined,
  definition: JsonSchemaObject,
): z.ZodTypeAny | undefined {
  if (!schema) return undefined;
  if (definition.nullable === true) {
    return z.union([schema, z.null()]);
  }
  return schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

type McpSdk = typeof import('@modelcontextprotocol/sdk/server/mcp.js');

let cachedMcpSdk: McpSdk | undefined;
const defaultMcpLoader = (): McpSdk => {
  const require = createRequire(import.meta.url);
  return require('@modelcontextprotocol/sdk/server/mcp.js') as McpSdk;
};
let mcpLoader = defaultMcpLoader;

function requireMcp(): McpSdk {
  if (cachedMcpSdk) return cachedMcpSdk;
  try {
    cachedMcpSdk = mcpLoader();
    return cachedMcpSdk;
  } catch (error) {
    const hint =
      'Missing peer dependency "@modelcontextprotocol/sdk". Install it to use armorer/mcp.';
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.message = `${hint}\n${wrapped.message}`;
    throw wrapped;
  }
}

export const internalMcpTestUtilities = {
  resetModuleState() {
    cachedMcpSdk = undefined;
    mcpLoader = defaultMcpLoader;
  },
  setModuleLoader(loader: (() => McpSdk) | undefined) {
    cachedMcpSdk = undefined;
    mcpLoader = loader ?? defaultMcpLoader;
  },
};
