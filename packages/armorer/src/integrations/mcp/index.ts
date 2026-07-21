import type {
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
  TaskStore,
  TaskToolExecution,
  ToolTaskHandler,
} from '@modelcontextprotocol/sdk/experimental/tasks';
import type { ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type {
  RequestHandlerExtra,
  RequestTaskStore,
} from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ElicitRequest,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
  Implementation,
  Result,
  ServerCapabilities,
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
  /**
   * Reports whether the connected client declared the `elicitation`
   * capability. When it returns `false`, `context.elicit` is left
   * `undefined` instead of a requester that would fail at call time — tools
   * using the common `if (context.elicit)` feature-detection pattern then
   * correctly fall back to their no-elicitation path. Defaults to `true`
   * (always expose `elicit`) when omitted.
   */
  supportsElicitation?: () => boolean;
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

/**
 * Creates an MCP server from a toolbox.
 *
 * Tools whose resolved MCP `execution.taskSupport` is `'required'` or
 * `'optional'` (set via {@link MCPToolConfiguration.execution}, typically
 * through `toolConfiguration()` or `tool.metadata.mcp.execution`) are
 * registered as MCP Tasks-extension tools instead of plain call/response
 * tools. This lets clients poll a long-running tool via `tasks/get`,
 * retrieve its result via `tasks/result`, and cancel it via `tasks/cancel`
 * (MCP spec revision `2025-11-25`, `@modelcontextprotocol/sdk` experimental
 * tasks module). If no `taskStore` is supplied in `options`, a fresh
 * `InMemoryTaskStore` is created and wrapped so that a client's
 * `tasks/cancel` call aborts the tool's `AbortSignal`.
 */
export async function createMCP(
  toolbox: ToolboxLike,
  options: CreateMCPOptions = {},
): Promise<McpServer> {
  const { serverInfo, toolConfiguration, formatResult, resources, prompts, ...serverOptions } =
    options;

  const availableTools =
    typeof toolbox.getAvailable === 'function' ? await toolbox.getAvailable() : toolbox.tools();
  const toolEntries = availableTools.map((tool) => ({
    tool,
    configuration: resolveToolConfiguration(tool, toolConfiguration),
  }));
  const hasTaskTools = toolEntries.some((entry) =>
    isTaskSupportedExecution(entry.configuration.execution),
  );

  const taskAbortControllers = new Map<string, AbortController>();
  let resolvedServerOptions = serverOptions;
  if (hasTaskTools) {
    const { InMemoryTaskStore } = await requireMcpTasks();
    const baseTaskStore = serverOptions.taskStore ?? new InMemoryTaskStore();
    resolvedServerOptions = {
      ...serverOptions,
      taskStore: createTaskAwareTaskStore(baseTaskStore, taskAbortControllers),
      capabilities: withTaskCapabilities(serverOptions.capabilities),
    };
  }

  const { McpServer: McpServerClass } = await requireMcp();
  const server = new McpServerClass(serverInfo ?? DEFAULT_SERVER_INFO, resolvedServerOptions);
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

  const supportsElicitation = () =>
    server.server.getClientCapabilities()?.elicitation !== undefined;

  const toolOptions: ToMCPToolsOptions = {
    toolConfiguration,
    formatResult,
    executeTool,
    supportsElicitation,
  };

  for (const { tool, configuration } of toolEntries) {
    const toolName = tool.name;
    const existing = registered.get(toolName);
    if (existing) {
      existing.remove();
    }

    let registeredTool: RegisteredTool;
    if (isTaskSupportedExecution(configuration.execution)) {
      registeredTool = registerMcpTaskTool(
        server,
        tool,
        configuration,
        configuration.execution,
        toolOptions,
        taskAbortControllers,
      );
    } else {
      const definition = buildMcpToolDefinitionFromConfiguration(tool, configuration, toolOptions);
      registeredTool = server.registerTool(
        toolName,
        toMcpRegisteredToolConfiguration(definition),
        definition.handler,
      );
    }

    registered.set(toolName, registeredTool);
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

/**
 * Resolves a tool's MCP configuration by merging metadata-derived
 * configuration (`tool.metadata.mcp`) with the caller-supplied
 * `toolConfiguration()` callback, mirroring the precedence used inline by
 * {@link toMcpToolDefinition} and {@link createMCP}'s task-tool path.
 */
function resolveToolConfiguration(
  tool: Tool,
  toolConfiguration: ToMCPToolsOptions['toolConfiguration'],
): MCPToolConfiguration {
  const metadataConfiguration = toolConfigurationFromMetadata(tool);
  return {
    ...metadataConfiguration,
    ...(toolConfiguration?.(tool) ?? {}),
  };
}

/** A tool's MCP `execution` hint that opts it into the Tasks extension. */
function isTaskSupportedExecution(
  execution: ToolExecution | undefined,
): execution is TaskToolExecution {
  return execution?.taskSupport === 'required' || execution?.taskSupport === 'optional';
}

type ResolvedMcpToolShape = {
  title?: string;
  description: string;
  inputSchema: AnySchema;
  annotations?: ToolAnnotations;
  meta?: Record<string, unknown>;
};

/** Resolves the title/description/schema/annotations/meta shared by both the plain-call and task-tool registration paths. */
function resolveMcpToolShape(
  tool: Tool,
  configuration: MCPToolConfiguration,
): ResolvedMcpToolShape {
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
    handler: async (args, extra) => {
      const params = args ?? {};
      let result: ToolResultLike;
      try {
        const callId = extra?.requestId !== undefined ? String(extra.requestId) : undefined;
        const clientSupportsElicitation = options.supportsElicitation
          ? options.supportsElicitation()
          : true;
        const elicit =
          extra && clientSupportsElicitation ? createMcpToolElicitationRequester(extra) : undefined;
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

  if (shape.title !== undefined) {
    mcpTool.title = shape.title;
  }
  if (shape.annotations !== undefined) {
    mcpTool.annotations = shape.annotations;
  }
  if (configuration.execution !== undefined) {
    mcpTool.execution = configuration.execution;
  }
  if (shape.meta !== undefined) {
    mcpTool._meta = shape.meta;
  }

  return mcpTool;
}

/**
 * Registers a tool as an MCP Tasks-extension tool (`server.experimental.tasks.registerToolTask`)
 * instead of a plain call/response tool. The tool's `execute` starts running in the background
 * immediately, fire-and-forget, as soon as the task-augmented `tools/call` request creates the
 * task; its result is recorded via the request-scoped `RequestTaskStore` so `tasks/get` can poll
 * status, `tasks/result` can retrieve the outcome, and `tasks/cancel` can abort it (see
 * {@link createTaskAwareTaskStore}).
 */
function registerMcpTaskTool(
  server: McpServer,
  tool: Tool,
  configuration: MCPToolConfiguration,
  execution: TaskToolExecution,
  options: ToMCPToolsOptions,
  taskAbortControllers: Map<string, AbortController>,
): RegisteredTool {
  const shape = resolveMcpToolShape(tool, configuration);

  const taskConfig: {
    title?: string;
    description: string;
    inputSchema: AnySchema;
    annotations?: ToolAnnotations;
    execution: TaskToolExecution;
    _meta?: Record<string, unknown>;
  } = {
    description: shape.description,
    inputSchema: shape.inputSchema,
    execution,
  };
  if (shape.title !== undefined) {
    taskConfig.title = shape.title;
  }
  if (shape.annotations !== undefined) {
    taskConfig.annotations = shape.annotations;
  }
  if (shape.meta !== undefined) {
    taskConfig._meta = shape.meta;
  }

  return server.experimental.tasks.registerToolTask(
    tool.name,
    taskConfig,
    createMcpTaskToolHandler(tool, options, taskAbortControllers),
  );
}

/**
 * Default poll interval (ms) advertised on a newly created task, and — for
 * `taskSupport: 'optional'` tools called without task augmentation — the
 * interval the SDK's own automatic-polling fallback (`handleAutomaticTaskPolling`)
 * waits before its first status check. Kept short so an optional task tool
 * that finishes quickly doesn't force a synchronous caller to wait out a
 * multi-second default poll interval.
 */
const DEFAULT_TASK_POLL_INTERVAL_MS = 250;

/**
 * Builds the `createTask` / `getTask` / `getTaskResult` triad the Tasks
 * extension requires. `createTask` starts the tool's execution in the
 * background (not awaited) against a per-task `AbortController`; that
 * controller is registered in `taskAbortControllers` so a later
 * `tasks/cancel` (routed through {@link createTaskAwareTaskStore}) can abort
 * it, and is also linked to `extra.signal` so that cancelling the underlying
 * `tools/call` request itself — the only cancellation path available for a
 * `taskSupport: 'optional'` tool invoked without task augmentation, since the
 * SDK's automatic-polling fallback never surfaces a task id to the client —
 * also stops the tool's work. `getTask`/`getTaskResult` simply delegate to
 * the request-scoped `RequestTaskStore`, per the SDK's documented
 * `registerToolTask` pattern.
 */
function createMcpTaskToolHandler(
  tool: Tool,
  options: ToMCPToolsOptions,
  taskAbortControllers: Map<string, AbortController>,
): ToolTaskHandler<AnySchema> {
  return {
    async createTask(args, extra: CreateTaskRequestHandlerExtra) {
      const task = await extra.taskStore.createTask({
        ...(extra.taskRequestedTtl !== undefined ? { ttl: extra.taskRequestedTtl } : {}),
        pollInterval: DEFAULT_TASK_POLL_INTERVAL_MS,
      });

      const controller = new AbortController();
      if (extra.signal.aborted) {
        controller.abort(extra.signal.reason);
      } else {
        extra.signal.addEventListener('abort', () => controller.abort(extra.signal.reason), {
          once: true,
        });
      }
      taskAbortControllers.set(task.taskId, controller);

      const clientSupportsElicitation = options.supportsElicitation
        ? options.supportsElicitation()
        : true;
      const elicit = clientSupportsElicitation
        ? createMcpToolElicitationRequester(extra)
        : undefined;

      void runMcpTaskTool(
        tool,
        args,
        extra.taskStore,
        task.taskId,
        controller,
        elicit,
        options,
      ).finally(() => {
        taskAbortControllers.delete(task.taskId);
      });
      return { task };
    },
    async getTask(_args, extra: TaskRequestHandlerExtra) {
      return extra.taskStore.getTask(extra.taskId);
    },
    async getTaskResult(_args, extra: TaskRequestHandlerExtra) {
      const result = await extra.taskStore.getTaskResult(extra.taskId);
      return asCallToolResult(result);
    },
  };
}

/**
 * Runs a task-tool's execution to completion (or failure) and records the
 * outcome via `storeTaskResult`. If the task was cancelled while running
 * (`controller.signal.aborted`), the store has already transitioned to the
 * terminal `cancelled` status — recording a completion/failure on top of
 * that would both be rejected by the store (terminal states don't
 * transition) and semantically wrong, so this returns without storing.
 * `storeTaskResult` can also reject on its own (e.g. the task's TTL elapsed
 * and the store already removed it, or a session-scoped store rejects the
 * write) — this call is fire-and-forget from the caller's perspective, so
 * that rejection is swallowed here rather than becoming an unhandled
 * promise rejection.
 */
async function runMcpTaskTool(
  tool: Tool,
  params: unknown,
  taskStore: RequestTaskStore,
  taskId: string,
  controller: AbortController,
  elicit: ToolElicitationRequester | undefined,
  options: Pick<ToMCPToolsOptions, 'executeTool' | 'formatResult'>,
): Promise<void> {
  let outcome: { ok: true; result: ToolResultLike } | { ok: false; error: unknown };
  try {
    const result = options.executeTool
      ? await options.executeTool(tool, params, taskId, controller.signal, elicit)
      : await (
          tool as unknown as {
            executeWith: (options: ToolExecuteWithOptions) => Promise<ToolResultLike>;
          }
        ).executeWith({
          params: params ?? {},
          callId: taskId,
          signal: controller.signal,
          ...(elicit ? { elicit } : {}),
        });
    outcome = { ok: true, result };
  } catch (error) {
    outcome = { ok: false, error };
  }

  if (controller.signal.aborted) {
    return;
  }

  const callResult = outcome.ok
    ? options.formatResult
      ? options.formatResult(outcome.result)
      : toCallToolResult(outcome.result)
    : toErrorCallToolResult(outcome.error);

  try {
    await taskStore.storeTaskResult(
      taskId,
      callResult.isError ? 'failed' : 'completed',
      callResult,
    );
  } catch {
    // The task was cancelled or its TTL elapsed while the tool was finishing
    // (or a session-scoped store otherwise rejected the write) — the store
    // has already finalized or removed the task, so there is nothing left
    // to record.
  }
}

function toErrorCallToolResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: toTextContent(message), isError: true };
}

/**
 * Narrows a task-store `Result` (loose by design, since `tasks/result` can
 * carry the result of any request type) to `CallToolResult`. Safe here
 * because {@link runMcpTaskTool} only ever calls `storeTaskResult` with a
 * genuine `CallToolResult`.
 */
function asCallToolResult(result: Result): CallToolResult {
  if (isRecord(result) && Array.isArray((result as { content?: unknown }).content)) {
    return result as CallToolResult;
  }
  throw new TypeError('Task result store returned a value that is not a CallToolResult.');
}

/**
 * Wraps a base {@link TaskStore} so that a client's `tasks/cancel` call —
 * which the SDK implements as `taskStore.updateTaskStatus(taskId,
 * 'cancelled', ...)` — also aborts the `AbortController` registered for
 * that task in `createTask`, actually stopping the in-flight tool
 * execution rather than merely flipping a status flag.
 *
 * The store update is awaited *before* aborting: for a session-scoped store,
 * `baseStore.updateTaskStatus` is what verifies the caller's session is
 * actually allowed to cancel this task, and a terminal task rejects the
 * transition outright. Aborting first would stop real work on a
 * cancellation the store goes on to reject.
 */
function createTaskAwareTaskStore(
  baseStore: TaskStore,
  taskAbortControllers: Map<string, AbortController>,
): TaskStore {
  return {
    createTask: (taskParams, requestId, request, sessionId) =>
      baseStore.createTask(taskParams, requestId, request, sessionId),
    getTask: (taskId, sessionId) => baseStore.getTask(taskId, sessionId),
    storeTaskResult: (taskId, status, result, sessionId) =>
      baseStore.storeTaskResult(taskId, status, result, sessionId),
    getTaskResult: (taskId, sessionId) => baseStore.getTaskResult(taskId, sessionId),
    listTasks: (cursor, sessionId) => baseStore.listTasks(cursor, sessionId),
    async updateTaskStatus(taskId, status, statusMessage, sessionId) {
      await baseStore.updateTaskStatus(taskId, status, statusMessage, sessionId);
      if (status === 'cancelled') {
        taskAbortControllers
          .get(taskId)
          ?.abort(new Error('Task cancelled by client via tasks/cancel.'));
      }
    },
  };
}

/** Merges in the `tasks` server capability required to advertise Tasks-extension support for `tools/call`. */
function withTaskCapabilities(existing: ServerCapabilities | undefined): ServerCapabilities {
  const existingTasks = existing?.tasks;
  return {
    ...existing,
    tasks: {
      ...existingTasks,
      list: existingTasks?.list ?? {},
      cancel: existingTasks?.cancel ?? {},
      requests: {
        ...existingTasks?.requests,
        tools: {
          ...existingTasks?.requests?.tools,
          call: existingTasks?.requests?.tools?.call ?? {},
        },
      },
    },
  };
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
  cachedMcpSdk = await loadMcpSdk(
    mcpLoader,
    'Missing peer dependency "@modelcontextprotocol/sdk". Install it to use armorer/mcp.',
  );
  return cachedMcpSdk;
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
  cachedMcpTypesSdk = await loadMcpSdk(
    mcpTypesLoader,
    'Missing peer dependency "@modelcontextprotocol/sdk". Install it to use armorer/mcp elicitation.',
  );
  return cachedMcpTypesSdk;
}

type McpTasksSdk = typeof import('@modelcontextprotocol/sdk/experimental/tasks');

let cachedMcpTasksSdk: McpTasksSdk | undefined;
const defaultMcpTasksLoader = async (): Promise<McpTasksSdk> => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('@modelcontextprotocol/sdk/experimental/tasks') as McpTasksSdk;
};
let mcpTasksLoader: () => McpTasksSdk | Promise<McpTasksSdk> = defaultMcpTasksLoader;

async function requireMcpTasks(): Promise<McpTasksSdk> {
  if (cachedMcpTasksSdk) return cachedMcpTasksSdk;
  cachedMcpTasksSdk = await loadMcpSdk(
    mcpTasksLoader,
    'Missing peer dependency "@modelcontextprotocol/sdk". Install it to use armorer/mcp task-based tools.',
  );
  return cachedMcpTasksSdk;
}

async function loadMcpSdk<T>(
  loader: () => T | Promise<T>,
  missingPeerDependencyHint: string,
): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.message = `${missingPeerDependencyHint}\n${wrapped.message}`;
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
      // Propagate the tool call's abort signal so a cancelled `tools/call`
      // also cancels the nested `elicitation/create` request instead of
      // leaving it pending until the client answers or it times out.
      extra.signal ? { signal: extra.signal } : undefined,
    );
    return fromElicitResult(result as ElicitResult, request);
  };
}

export const internalMcpTestUtilities = {
  resetModuleState() {
    cachedMcpSdk = undefined;
    mcpLoader = defaultMcpLoader;
    cachedMcpTypesSdk = undefined;
    mcpTypesLoader = defaultMcpTypesLoader;
    cachedMcpTasksSdk = undefined;
    mcpTasksLoader = defaultMcpTasksLoader;
  },
  setModuleLoader(loader: (() => McpSdk | Promise<McpSdk>) | undefined) {
    cachedMcpSdk = undefined;
    mcpLoader = loader ?? defaultMcpLoader;
  },
};

export type {
  CompleteMcpOAuthAuthorizationOptions,
  ConnectMcpClientWithOAuthOptions,
  McpAuthorizationCallbackParams,
  McpOAuthProviderOptions,
  McpOAuthStorageState,
  McpOAuthTokenStorage,
} from './oauth';
export {
  completeMcpOAuthAuthorization,
  connectMcpClientWithOAuth,
  createInMemoryMcpOAuthTokenStorage,
  createMcpOAuthProvider,
  fromMcpClientTools,
  internalMcpOAuthTestUtilities,
  isMcpUnauthorizedError,
  McpAuthorizationIssuerValidationError,
  parseMcpAuthorizationCallback,
  validateMcpAuthorizationResponseIssuer,
} from './oauth';
