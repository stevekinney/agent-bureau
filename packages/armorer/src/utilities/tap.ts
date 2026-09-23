import { z } from 'zod';

import type { ComposedTool } from '../compose-types';
import { createTool, type InferSchemaInput } from '../create-tool';
import type { DefaultToolEvents, Tool, ToolContext, ToolEventsMap, ToolMetadata } from '../is-tool';
import type { ToolCallReturn } from '../types';

type TapEffect<TOutput> = (output: TOutput, context: ToolContext) => void | Promise<void>;

/**
 * Wraps a tool to run a side effect after execution without modifying the output.
 *
 * Useful for logging, metrics, notifications, or other side effects that shouldn't
 * change the tool's return value. The effect receives the output and can perform
 * async operations.
 *
 * @param tool - The tool to wrap
 * @param effect - Function to run after tool execution (receives output and context)
 * @returns A new tool that runs the effect and returns the original output
 *
 * @example Logging tool output
 * ```typescript
 * import { createTool } from 'armorer';
 * import { tap } from 'armorer';
 * import { z } from 'zod';
 *
 * const fetchUser = createTool({
 *   name: 'fetch-user',
 *   input: z.object({ id: z.string() }),
 *   async execute({ id }) {
 *     return { id, name: 'John' };
 *   },
 * });
 *
 * const loggedFetch = tap(fetchUser, (output) => {
 *   console.log('Fetched user:', output);
 * });
 *
 * const result = await loggedFetch({ id: '123' });
 * // Logs: "Fetched user: { id: '123', name: 'John' }"
 * // Returns: { id: '123', name: 'John' }
 * ```
 *
 * @example Sending metrics
 * ```typescript
 * const monitoredTool = tap(expensiveTool, async (output, context) => {
 *   await metrics.record({
 *     tool: 'expensive-operation',
 *     duration: context.duration,
 *     success: true,
 *   });
 * });
 * ```
 */
export function tap<
  TSchema extends z.ZodType,
  TEvents extends ToolEventsMap,
  TOutput,
  TMetadata extends ToolMetadata | undefined,
>(
  tool: Tool<TSchema, TEvents, TOutput, TMetadata>,
  effect: TapEffect<ToolCallReturn<TOutput>>,
): ComposedTool<InferSchemaInput<TSchema>, ToolCallReturn<TOutput>, TMetadata> {
  const name = `tap(${tool.name})`;
  const description = `Tap tool: ${tool.description}`;
  const tags = tool.tags && tool.tags.length ? tool.tags : undefined;
  const input = tool.input;
  const metadata = tool.metadata;

  const runTap = async (
    params: InferSchemaInput<TSchema>,
    context: ToolContext,
  ): Promise<ToolCallReturn<TOutput>> => {
    const executeOptions =
      context.signal || context.timeout !== undefined || context.stream !== undefined
        ? {
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
          }
        : undefined;
    const result = await tool.execute(params, executeOptions);
    await effect(result, context);
    return result;
  };

  return createTool<
    TSchema,
    TOutput,
    DefaultToolEvents,
    readonly string[],
    TMetadata,
    ToolCallReturn<TOutput>
  >({
    name,
    description,
    input,
    async execute(params: InferSchemaInput<TSchema>, context: ToolContext) {
      return runTap(params, context);
    },
    ...(tags ? { tags } : {}),
    metadata,
  });
}
