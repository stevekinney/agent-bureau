import { z } from 'zod';

import type {
  AnyTool,
  ComposedTool,
  InferToolInput,
  InferToolOutput,
} from '../compose-types';
import { createTool, type CreateToolOptions } from '../create-tool';
import type { DefaultToolEvents, ToolContext, ToolMetadata } from '../is-tool';

type TapEffect<TOutput> = (
  output: TOutput,
  context: ToolContext<DefaultToolEvents>,
) => void | Promise<void>;

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
 * import { tap } from 'armorer/utilities';
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
export function tap<TTool extends AnyTool>(
  tool: TTool,
  effect: TapEffect<InferToolOutput<TTool>>,
): ComposedTool<InferToolInput<TTool>, InferToolOutput<TTool>> {
  const name = `tap(${tool.name})`;
  const description = `Tap tool: ${tool.description}`;
  const tags = tool.tags && tool.tags.length ? tool.tags : undefined;

  const runTap = async (
    params: unknown,
    context: ToolContext<DefaultToolEvents>,
  ): Promise<InferToolOutput<TTool>> => {
    const executeOptions =
      context.signal || context.timeout !== undefined || context.stream !== undefined
        ? {
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
          }
        : undefined;
    const result = (await tool.execute(
      params as InferToolInput<TTool>,
      executeOptions,
    )) as InferToolOutput<TTool>;
    await effect(result, context);
    return result;
  };

  const toolOptions: Omit<
    CreateToolOptions<
      InferToolInput<TTool>,
      InferToolOutput<TTool>,
      DefaultToolEvents,
      readonly string[],
      ToolMetadata | undefined,
      ToolContext<DefaultToolEvents>,
      InferToolOutput<TTool>
    >,
    'metadata'
  > & {
    metadata?: ToolMetadata | undefined;
  } = {
    name,
    description,
    input: tool.input as z.ZodType<InferToolInput<TTool>>,
    async execute(params, context) {
      return runTap(params, context);
    },
    ...(tags ? { tags } : {}),
    ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
  };
  return createTool<
    InferToolInput<TTool>,
    InferToolOutput<TTool>,
    DefaultToolEvents,
    readonly string[],
    ToolMetadata | undefined,
    ToolContext<DefaultToolEvents>,
    InferToolOutput<TTool>
  >(toolOptions) as ComposedTool<InferToolInput<TTool>, InferToolOutput<TTool>>;
}
