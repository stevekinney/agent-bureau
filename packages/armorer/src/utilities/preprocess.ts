import { z } from 'zod';

import type { ComposedTool } from '../compose-types';
import { createTool } from '../create-tool';
import type { DefaultToolEvents, Tool, ToolContext, ToolEventsMap, ToolMetadata } from '../is-tool';
import type { ToolCallReturn } from '../types';

type PreprocessMapper<TInput, TTransformedInput> = (
  input: TInput,
  context: ToolContext,
) => TTransformedInput | Promise<TTransformedInput>;

/**
 * Maps/transforms inputs before they're passed to a tool.
 * Useful for normalizing, validating, or enriching input data.
 *
 * @example
 * ```ts
 * const addNumbers = createTool({
 *   name: 'add-numbers',
 *   input: z.object({ a: z.number(), b: z.number() }),
 *   execute: async ({ a, b }) => a + b,
 * });
 *
 * // Preprocess to convert string numbers to actual numbers
 * const addNumbersWithPreprocessing = preprocess(
 *   addNumbers,
 *   z.object({ a: z.string(), b: z.string() }),
 *   async (input: { a: string; b: string }) => ({
 *     a: Number(input.a),
 *     b: Number(input.b),
 *   }),
 * );
 *
 * // Now accepts string inputs
 * const result = await addNumbersWithPreprocessing({ a: '5', b: '3' });
 * ```
 */
export function preprocess<
  TSchema extends z.ZodType,
  TEvents extends ToolEventsMap,
  TOutput,
  TMetadata extends ToolMetadata | undefined,
  TNewInput,
>(
  tool: Tool<TSchema, TEvents, TOutput, TMetadata>,
  schema: z.ZodType<TNewInput>,
  mapper: PreprocessMapper<TNewInput, z.infer<TSchema>>,
): ComposedTool<TNewInput, ToolCallReturn<TOutput>, TMetadata> {
  const name = `preprocess(${tool.name})`;
  const description = `Preprocessed tool: ${tool.description}`;
  const tags = tool.tags && tool.tags.length ? tool.tags : undefined;

  const runPreprocess = async (
    params: TNewInput,
    context: ToolContext,
  ): Promise<ToolCallReturn<TOutput>> => {
    const transformed = await mapper(params, context);
    const executeOptions =
      context.signal || context.timeout !== undefined || context.stream !== undefined
        ? {
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
          }
        : undefined;
    return tool.execute(transformed, executeOptions);
  };

  return createTool<
    z.ZodType<TNewInput>,
    TOutput,
    DefaultToolEvents,
    readonly string[],
    TMetadata,
    ToolCallReturn<TOutput>
  >({
    name,
    description,
    input: schema,
    async execute(params: TNewInput, context: ToolContext) {
      return runPreprocess(params, context);
    },
    ...(tags ? { tags } : {}),
    metadata: tool.metadata,
  });
}
