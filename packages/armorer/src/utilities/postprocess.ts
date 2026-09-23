import { z } from 'zod';

import type { ComposedTool } from '../compose-types';
import { createTool, type InferSchemaInput } from '../create-tool';
import type { DefaultToolEvents, Tool, ToolContext, ToolEventsMap, ToolMetadata } from '../is-tool';
import type { ToolCallReturn } from '../types';

type PostprocessMapper<TOutput, TNewOutput> = (
  output: TOutput,
  context: ToolContext,
) => TNewOutput | Promise<TNewOutput>;

/**
 * Maps/transforms outputs after a tool executes.
 * Useful for formatting, enriching, or normalizing output data.
 *
 * @example
 * ```ts
 * const fetchUser = createTool({
 *   name: 'fetch-user',
 *   input: z.object({ id: z.string() }),
 *   execute: async ({ id }) => ({ userId: id, name: 'John' }),
 * });
 *
 * // Postprocess to format the output
 * const fetchUserFormatted = postprocess(
 *   fetchUser,
 *   async (output) => ({
 *     ...output,
 *     displayName: `${output.name} (${output.userId})`,
 *   }),
 * );
 *
 * // Returns enriched output
 * const result = await fetchUserFormatted({ id: '123' });
 * // { userId: '123', name: 'John', displayName: 'John (123)' }
 * ```
 */
export function postprocess<
  TSchema extends z.ZodType,
  TEvents extends ToolEventsMap,
  TOutput,
  TMetadata extends ToolMetadata | undefined,
  TNewOutput,
>(
  tool: Tool<TSchema, TEvents, TOutput, TMetadata>,
  mapper: PostprocessMapper<ToolCallReturn<TOutput>, TNewOutput>,
): ComposedTool<InferSchemaInput<TSchema>, TNewOutput, TMetadata> {
  const name = `postprocess(${tool.name})`;
  const description = `Postprocessed tool: ${tool.description}`;
  const tags = tool.tags && tool.tags.length ? tool.tags : undefined;
  const input = tool.input;
  const metadata = tool.metadata;

  const runPostprocess = async (params: InferSchemaInput<TSchema>, context: ToolContext) => {
    const executeOptions =
      context.signal || context.timeout !== undefined || context.stream !== undefined
        ? {
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
          }
        : undefined;
    const result = await tool.execute(params, executeOptions);
    return mapper(result, context);
  };

  return createTool<
    TSchema,
    TNewOutput,
    DefaultToolEvents,
    readonly string[],
    TMetadata,
    TNewOutput
  >({
    name,
    description,
    input,
    async execute(params: InferSchemaInput<TSchema>, context: ToolContext) {
      return runPostprocess(params, context);
    },
    ...(tags ? { tags } : {}),
    metadata,
  });
}
