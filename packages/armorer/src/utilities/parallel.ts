import type {
  AnyTool,
  ComposedTool,
  InferToolInput,
  InferToolOutput,
  ToolWithInput,
} from '../compose-types';
import { createTool } from '../create-tool';
import type { DefaultToolEvents, ToolContext } from '../is-tool';

/** Parallelize 2 tools */
export function parallel<A extends AnyTool, B extends ToolWithInput<InferToolInput<A>>>(
  a: A,
  b: B,
): ComposedTool<InferToolInput<A>, [InferToolOutput<A>, InferToolOutput<B>]>;

/** Parallelize 3 tools */
export function parallel<
  A extends AnyTool,
  B extends ToolWithInput<InferToolInput<A>>,
  C extends ToolWithInput<InferToolInput<A>>,
>(
  a: A,
  b: B,
  c: C,
): ComposedTool<InferToolInput<A>, [InferToolOutput<A>, InferToolOutput<B>, InferToolOutput<C>]>;

/** Parallelize 4 tools */
export function parallel<
  A extends AnyTool,
  B extends ToolWithInput<InferToolInput<A>>,
  C extends ToolWithInput<InferToolInput<A>>,
  D extends ToolWithInput<InferToolInput<A>>,
>(
  a: A,
  b: B,
  c: C,
  d: D,
): ComposedTool<
  InferToolInput<A>,
  [InferToolOutput<A>, InferToolOutput<B>, InferToolOutput<C>, InferToolOutput<D>]
>;

/** Parallelize 5 tools */
export function parallel<
  A extends AnyTool,
  B extends ToolWithInput<InferToolInput<A>>,
  C extends ToolWithInput<InferToolInput<A>>,
  D extends ToolWithInput<InferToolInput<A>>,
  E extends ToolWithInput<InferToolInput<A>>,
>(
  a: A,
  b: B,
  c: C,
  d: D,
  e: E,
): ComposedTool<
  InferToolInput<A>,
  [
    InferToolOutput<A>,
    InferToolOutput<B>,
    InferToolOutput<C>,
    InferToolOutput<D>,
    InferToolOutput<E>,
  ]
>;

/** Parallelize 6 tools */
export function parallel<
  A extends AnyTool,
  B extends ToolWithInput<InferToolInput<A>>,
  C extends ToolWithInput<InferToolInput<A>>,
  D extends ToolWithInput<InferToolInput<A>>,
  E extends ToolWithInput<InferToolInput<A>>,
  F extends ToolWithInput<InferToolInput<A>>,
>(
  a: A,
  b: B,
  c: C,
  d: D,
  e: E,
  f: F,
): ComposedTool<
  InferToolInput<A>,
  [
    InferToolOutput<A>,
    InferToolOutput<B>,
    InferToolOutput<C>,
    InferToolOutput<D>,
    InferToolOutput<E>,
    InferToolOutput<F>,
  ]
>;

/** Parallelize 7 tools */
export function parallel<
  A extends AnyTool,
  B extends ToolWithInput<InferToolInput<A>>,
  C extends ToolWithInput<InferToolInput<A>>,
  D extends ToolWithInput<InferToolInput<A>>,
  E extends ToolWithInput<InferToolInput<A>>,
  F extends ToolWithInput<InferToolInput<A>>,
  G extends ToolWithInput<InferToolInput<A>>,
>(
  a: A,
  b: B,
  c: C,
  d: D,
  e: E,
  f: F,
  g: G,
): ComposedTool<
  InferToolInput<A>,
  [
    InferToolOutput<A>,
    InferToolOutput<B>,
    InferToolOutput<C>,
    InferToolOutput<D>,
    InferToolOutput<E>,
    InferToolOutput<F>,
    InferToolOutput<G>,
  ]
>;

/** Parallelize 8 tools */
export function parallel<
  A extends AnyTool,
  B extends ToolWithInput<InferToolInput<A>>,
  C extends ToolWithInput<InferToolInput<A>>,
  D extends ToolWithInput<InferToolInput<A>>,
  E extends ToolWithInput<InferToolInput<A>>,
  F extends ToolWithInput<InferToolInput<A>>,
  G extends ToolWithInput<InferToolInput<A>>,
  H extends ToolWithInput<InferToolInput<A>>,
>(
  a: A,
  b: B,
  c: C,
  d: D,
  e: E,
  f: F,
  g: G,
  h: H,
): ComposedTool<
  InferToolInput<A>,
  [
    InferToolOutput<A>,
    InferToolOutput<B>,
    InferToolOutput<C>,
    InferToolOutput<D>,
    InferToolOutput<E>,
    InferToolOutput<F>,
    InferToolOutput<G>,
    InferToolOutput<H>,
  ]
>;

/** Parallelize 9 tools */
export function parallel<
  A extends AnyTool,
  B extends ToolWithInput<InferToolInput<A>>,
  C extends ToolWithInput<InferToolInput<A>>,
  D extends ToolWithInput<InferToolInput<A>>,
  E extends ToolWithInput<InferToolInput<A>>,
  F extends ToolWithInput<InferToolInput<A>>,
  G extends ToolWithInput<InferToolInput<A>>,
  H extends ToolWithInput<InferToolInput<A>>,
  I extends ToolWithInput<InferToolInput<A>>,
>(
  a: A,
  b: B,
  c: C,
  d: D,
  e: E,
  f: F,
  g: G,
  h: H,
  i: I,
): ComposedTool<
  InferToolInput<A>,
  [
    InferToolOutput<A>,
    InferToolOutput<B>,
    InferToolOutput<C>,
    InferToolOutput<D>,
    InferToolOutput<E>,
    InferToolOutput<F>,
    InferToolOutput<G>,
    InferToolOutput<H>,
    InferToolOutput<I>,
  ]
>;

export function parallel(...tools: AnyTool[]): AnyTool {
  if (tools.length < 2) {
    throw new Error('parallel() requires at least 2 tools');
  }

  const first = tools[0]!;
  const toolNames = tools.map((t) => t.name);

  const emit = (
    dispatch: ToolContext<DefaultToolEvents>['dispatch'],
    type: string,
    detail: unknown,
  ) => {
    const event = new Event(type);
    if (detail && typeof detail === 'object') {
      Object.assign(event, detail);
    }
    return dispatch(event);
  };

  const runParallel = async (input: unknown, context: ToolContext<DefaultToolEvents>) => {
    const executeOptions =
      context.signal || context.timeout !== undefined || context.stream !== undefined
        ? {
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
          }
        : undefined;

    const results = await Promise.all(
      tools.map(async (tool, index) => {
        emit(context.dispatch, 'step-start', {
          stepIndex: index,
          stepName: tool.name,
          input,
        });

        try {
          const result = await tool.execute(input, executeOptions);
          emit(context.dispatch, 'step-complete', {
            stepIndex: index,
            stepName: tool.name,
            output: result,
          });
          return result;
        } catch (error) {
          emit(context.dispatch, 'step-error', {
            stepIndex: index,
            stepName: tool.name,
            error,
          });
          throw error;
        }
      }),
    );

    return results;
  };

  return createTool({
    name: `parallel(${toolNames.join(', ')})`,
    description: `Parallel tools: ${toolNames.join(' | ')}`,
    input: first.input,
    async execute(input: unknown, context: ToolContext<DefaultToolEvents>) {
      return runParallel(input, context);
    },
  }) as AnyTool;
}
