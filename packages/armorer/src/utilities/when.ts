import { z } from 'zod';

import type {
  AnyTool,
  ComposedTool,
  InferToolInput,
  InferToolOutput,
  ToolWithInput,
} from '../compose-types';
import { createTool } from '../create-tool';
import type { DefaultToolEvents, ToolContext } from '../is-tool';

type WhenPredicate<TInput = unknown> = (
  input: TInput,
  context: ToolContext<DefaultToolEvents>,
) => boolean | Promise<boolean>;

/**
 * Creates conditional tool execution based on a predicate function.
 *
 * Evaluates a predicate and executes different tools based on the result.
 * Useful for branching logic, validation gates, and dynamic routing.
 *
 * @param predicate - Function that determines which branch to execute
 * @param whenTrue - Tool to execute if predicate returns true
 * @param whenFalse - Optional tool to execute if predicate returns false (if omitted, returns input unchanged)
 * @returns A conditional tool that executes the appropriate branch
 *
 * @example Basic conditional
 * ```typescript
 * import { createTool } from 'armorer';
 * import { when } from 'armorer/utilities';
 * import { z } from 'zod';
 *
 * const expensiveProcess = createTool({
 *   name: 'expensive',
 *   input: z.object({ value: z.number() }),
 *   async execute({ value }) {
 *     return value * 2;
 *   },
 * });
 *
 * const cheapProcess = createTool({
 *   name: 'cheap',
 *   input: z.object({ value: z.number() }),
 *   async execute({ value }) {
 *     return value + 1;
 *   },
 * });
 *
 * const smartTool = when(
 *   ({ value }) => value > 100,
 *   expensiveProcess,
 *   cheapProcess,
 * );
 * ```
 */
export function when<
  TTool extends AnyTool,
  TElse extends ToolWithInput<InferToolInput<TTool>> | undefined = undefined,
>(
  predicate: WhenPredicate<InferToolInput<TTool>>,
  whenTrue: TTool,
  whenFalse?: TElse,
): ComposedTool<
  InferToolInput<TTool>,
  InferToolOutput<TTool> | (TElse extends AnyTool ? InferToolOutput<TElse> : InferToolInput<TTool>)
> {
  const name = whenFalse ? `when(${whenTrue.name}, ${whenFalse.name})` : `when(${whenTrue.name})`;
  const description = whenFalse
    ? `Conditional tool: ${whenTrue.name} or ${whenFalse.name}`
    : `Conditional tool: ${whenTrue.name}`;

  const runWhen = async (params: unknown, context: ToolContext<DefaultToolEvents>) => {
    const input = params as InferToolInput<TTool>;
    const executeOptions =
      context.signal || context.timeout !== undefined || context.stream !== undefined
        ? {
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
          }
        : undefined;
    const shouldRun = await predicate(input, context);
    if (shouldRun) {
      return whenTrue.execute(input, executeOptions);
    }
    if (whenFalse) {
      return whenFalse.execute(input, executeOptions);
    }
    return input;
  };

  return createTool({
    name,
    description,
    input: whenTrue.input as z.ZodTypeAny,
    async execute(params, context) {
      return runWhen(params, context);
    },
  }) as ComposedTool<
    InferToolInput<TTool>,
    | InferToolOutput<TTool>
    | (TElse extends AnyTool ? InferToolOutput<TElse> : InferToolInput<TTool>)
  >;
}
