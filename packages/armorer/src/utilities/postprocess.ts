import { z } from 'zod';

import type {
  AnyTool,
  ComposedTool,
  InferToolInput,
  InferToolOutput,
} from '../compose-types';
import { createTool, type CreateToolOptions } from '../create-tool';
import type { DefaultToolEvents, ToolContext, ToolMetadata } from '../is-tool';

type PostprocessMapper<TOutput, TNewOutput> = (
  output: TOutput,
  context: ToolContext<DefaultToolEvents>,
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
export function postprocess<TTool extends AnyTool, TNewOutput>(
  tool: TTool,
  mapper: PostprocessMapper<InferToolOutput<TTool>, TNewOutput>,
): ComposedTool<InferToolInput<TTool>, TNewOutput> {
  const name = `postprocess(${tool.name})`;
  const description = `Postprocessed tool: ${tool.description}`;
  const tags = tool.tags && tool.tags.length ? tool.tags : undefined;

  const runPostprocess = async (
    params: unknown,
    context: ToolContext<DefaultToolEvents>,
  ) => {
    const executeOptions =
      context.signal || context.timeout !== undefined || context.stream !== undefined
        ? {
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
          }
        : undefined;
    const result = await tool.execute(params as InferToolInput<TTool>, executeOptions);
    return mapper(result as InferToolOutput<TTool>, context);
  };

  const toolOptions: Omit<
    CreateToolOptions<
      InferToolInput<TTool>,
      TNewOutput,
      DefaultToolEvents,
      readonly string[],
      ToolMetadata | undefined,
      ToolContext<DefaultToolEvents>,
      TNewOutput
    >,
    'metadata'
  > & {
    metadata?: ToolMetadata | undefined;
  } = {
    name,
    description,
    input: tool.input as z.ZodType<InferToolInput<TTool>>,
    async execute(params, context) {
      return runPostprocess(params, context);
    },
    ...(tags ? { tags } : {}),
    ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
  };
  return createTool<
    InferToolInput<TTool>,
    TNewOutput,
    DefaultToolEvents,
    readonly string[],
    ToolMetadata | undefined,
    ToolContext<DefaultToolEvents>,
    TNewOutput
  >(toolOptions) as ComposedTool<InferToolInput<TTool>, TNewOutput>;
}
