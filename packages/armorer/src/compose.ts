import { z } from 'zod';

import type {
  AnyTool,
  ComposedTool,
  InferToolInput,
  InferToolOutput,
  ToolWithInput,
} from './compose-types';
import { getSchemaShape } from './core/schema-utilities';
import { createTool, type CreateToolOptions } from './create-tool';
import type { DefaultToolEvents, ToolContext, ToolMetadata, ToolParametersSchema } from './is-tool';

/**
 * Error thrown when a pipeline step fails.
 * Contains context about which step failed and the original error.
 */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly context: {
      stepIndex: number;
      stepName: string;
      originalError: unknown;
    },
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

type OutputAsInput<TTool extends AnyTool> = InferToolOutput<TTool> & Record<string, unknown>;

// Overloads for 2-9 tools with type inference

/** Pipe 2 tools together */
export function pipe<A extends AnyTool, B extends ToolWithInput<OutputAsInput<A>>>(
  a: A,
  b: B,
): ComposedTool<InferToolInput<A>, InferToolOutput<B>>;

/** Pipe 3 tools together */
export function pipe<
  A extends AnyTool,
  B extends ToolWithInput<OutputAsInput<A>>,
  C extends ToolWithInput<OutputAsInput<B>>,
>(a: A, b: B, c: C): ComposedTool<InferToolInput<A>, InferToolOutput<C>>;

/** Pipe 4 tools together */
export function pipe<
  A extends AnyTool,
  B extends ToolWithInput<OutputAsInput<A>>,
  C extends ToolWithInput<OutputAsInput<B>>,
  D extends ToolWithInput<OutputAsInput<C>>,
>(a: A, b: B, c: C, d: D): ComposedTool<InferToolInput<A>, InferToolOutput<D>>;

/** Pipe 5 tools together */
export function pipe<
  A extends AnyTool,
  B extends ToolWithInput<OutputAsInput<A>>,
  C extends ToolWithInput<OutputAsInput<B>>,
  D extends ToolWithInput<OutputAsInput<C>>,
  E extends ToolWithInput<OutputAsInput<D>>,
>(a: A, b: B, c: C, d: D, e: E): ComposedTool<InferToolInput<A>, InferToolOutput<E>>;

/** Pipe 6 tools together */
export function pipe<
  A extends AnyTool,
  B extends ToolWithInput<OutputAsInput<A>>,
  C extends ToolWithInput<OutputAsInput<B>>,
  D extends ToolWithInput<OutputAsInput<C>>,
  E extends ToolWithInput<OutputAsInput<D>>,
  F extends ToolWithInput<OutputAsInput<E>>,
>(a: A, b: B, c: C, d: D, e: E, f: F): ComposedTool<InferToolInput<A>, InferToolOutput<F>>;

/** Pipe 7 tools together */
export function pipe<
  A extends AnyTool,
  B extends ToolWithInput<OutputAsInput<A>>,
  C extends ToolWithInput<OutputAsInput<B>>,
  D extends ToolWithInput<OutputAsInput<C>>,
  E extends ToolWithInput<OutputAsInput<D>>,
  F extends ToolWithInput<OutputAsInput<E>>,
  G extends ToolWithInput<OutputAsInput<F>>,
>(a: A, b: B, c: C, d: D, e: E, f: F, g: G): ComposedTool<InferToolInput<A>, InferToolOutput<G>>;

/** Pipe 8 tools together */
export function pipe<
  A extends AnyTool,
  B extends ToolWithInput<OutputAsInput<A>>,
  C extends ToolWithInput<OutputAsInput<B>>,
  D extends ToolWithInput<OutputAsInput<C>>,
  E extends ToolWithInput<OutputAsInput<D>>,
  F extends ToolWithInput<OutputAsInput<E>>,
  G extends ToolWithInput<OutputAsInput<F>>,
  H extends ToolWithInput<OutputAsInput<G>>,
>(
  a: A,
  b: B,
  c: C,
  d: D,
  e: E,
  f: F,
  g: G,
  h: H,
): ComposedTool<InferToolInput<A>, InferToolOutput<H>>;

/** Pipe 9 tools together */
export function pipe<
  A extends AnyTool,
  B extends ToolWithInput<OutputAsInput<A>>,
  C extends ToolWithInput<OutputAsInput<B>>,
  D extends ToolWithInput<OutputAsInput<C>>,
  E extends ToolWithInput<OutputAsInput<D>>,
  F extends ToolWithInput<OutputAsInput<E>>,
  G extends ToolWithInput<OutputAsInput<F>>,
  H extends ToolWithInput<OutputAsInput<G>>,
  I extends ToolWithInput<OutputAsInput<H>>,
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
): ComposedTool<InferToolInput<A>, InferToolOutput<I>>;

/**
 * Chains tools together, passing the output of each tool as input to the next.
 * Returns a new Tool that can be used like any other tool.
 *
 * @example
 * ```ts
 * const fetchUser = createTool<{ id: string }, User>({...});
 * const enrichProfile = createTool<User, EnrichedUser>({...});
 * const formatResponse = createTool<EnrichedUser, APIResponse>({...});
 *
 * // Types flow through: (id: string) => Promise<APIResponse>
 * const pipeline = pipe(fetchUser, enrichProfile, formatResponse);
 *
 * // Fully typed - result is APIResponse
 * const result = await pipeline({ id: 'user-123' });
 * ```
 */
export function pipe(...tools: AnyTool[]): AnyTool {
  if (tools.length < 2) {
    throw new Error('pipe() requires at least 2 tools');
  }

  const first = tools[0]!;
  const toolNames = tools.map((t) => t.identity.name);

  // Helper to emit events with proper typing (event-emission accepts partial events at runtime)
  const emit = (
    dispatch: ToolContext<DefaultToolEvents>['dispatch'],
    type: string,
    detail: unknown,
  ) => dispatch({ type, detail } as Parameters<typeof dispatch>[0]);

  const runPipeline = async (input: unknown, context: ToolContext<DefaultToolEvents>) => {
    let result: unknown = input;
    const executeOptions =
      context.signal || context.timeout !== undefined || context.stream !== undefined
        ? {
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
            ...(context.stream !== undefined ? { stream: context.stream } : {}),
          }
        : undefined;

    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i]!;
      if (context.signal?.aborted) {
        throw toError(context.signal.reason ?? new Error('Cancelled'));
      }

      // Emit step-start event
      emit(context.dispatch, 'step-start', {
        stepIndex: i,
        stepName: tool.identity.name,
        input: result,
      });

      try {
        // Execute step - tool validates its own input via its schema
        result = await tool.execute(result, executeOptions);

        // Emit step-complete event
        emit(context.dispatch, 'step-complete', {
          stepIndex: i,
          stepName: tool.identity.name,
          output: result,
        });
      } catch (error) {
        // Emit step-error event
        emit(context.dispatch, 'step-error', {
          stepIndex: i,
          stepName: tool.identity.name,
          error,
        });

        // Wrap error with step context
        throw new PipelineError(`Pipeline failed at step ${i} (${tool.identity.name})`, {
          stepIndex: i,
          stepName: tool.identity.name,
          originalError: error,
        });
      }
    }

    return result;
  };

  return createTool({
    name: `pipe(${toolNames.join(', ')})`,
    description: `Composed pipeline: ${toolNames.join(' → ')}`,
    input: first.input as z.ZodTypeAny,

    async execute(input: unknown, context: ToolContext<DefaultToolEvents>) {
      return runPipeline(input, context);
    },
  }) as AnyTool;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

type BindParams<TTool extends AnyTool> =
  InferToolInput<TTool> extends object ? Partial<InferToolInput<TTool>> : InferToolInput<TTool>;

type BindInput<TTool extends AnyTool, TBound extends BindParams<TTool>> =
  InferToolInput<TTool> extends object
    ? Omit<InferToolInput<TTool>, keyof TBound>
    : Record<string, never>;

type BindOptions = {
  name?: string;
  description?: string;
};

export function bind(tool: AnyTool, bound: unknown, options?: BindOptions): AnyTool;
export function bind<TTool extends AnyTool, TBound extends BindParams<TTool>>(
  tool: TTool,
  bound: TBound,
  options: BindOptions = {},
): AnyTool {
  const input = resolveBoundSchema(tool.input, bound);
  const name = options.name ?? `bind(${tool.identity.name})`;
  const description = options.description ?? `Bound tool: ${tool.display.description}`;
  const tags = tool.tags && tool.tags.length ? tool.tags : undefined;

  const toolOptions: Omit<
    CreateToolOptions<
      BindInput<TTool, TBound>,
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
    input: input as z.ZodType<BindInput<TTool, TBound>>,
    async execute(params, context) {
      const merged = mergeBoundParams(params, bound);
      const executeOptions =
        context.signal || context.timeout !== undefined || context.stream !== undefined
          ? {
              ...(context.signal ? { signal: context.signal } : {}),
              ...(context.timeout !== undefined ? { timeout: context.timeout } : {}),
              ...(context.stream !== undefined ? { stream: context.stream } : {}),
            }
          : undefined;
      const result = await tool.execute(merged as InferToolInput<TTool>, executeOptions);
      return result as InferToolOutput<TTool>;
    },
    ...(tags ? { tags } : {}),
    ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
  };
  return createTool<
    BindInput<TTool, TBound>,
    InferToolOutput<TTool>,
    DefaultToolEvents,
    readonly string[],
    ToolMetadata | undefined,
    ToolContext<DefaultToolEvents>,
    InferToolOutput<TTool>
  >(toolOptions) as ComposedTool<BindInput<TTool, TBound>, InferToolOutput<TTool>>;
}

function resolveBoundSchema(schema: ToolParametersSchema, bound: unknown): ToolParametersSchema {
  const shape = getSchemaShape(schema);
  if (!shape) {
    throw new TypeError('bind() expects a tool with an object schema');
  }
  if (!isPlainObject(bound)) {
    throw new TypeError('bind() expects an object when binding an object-schema tool');
  }
  const shapeKeys = new Set(Object.keys(shape));
  const boundKeys = Object.keys(bound);
  const unknownKeys = boundKeys.filter((key) => !shapeKeys.has(key));
  if (unknownKeys.length) {
    throw new Error(`bind() cannot bind unknown keys: ${unknownKeys.sort().join(', ')}`);
  }
  const mask = Object.fromEntries(boundKeys.map((key) => [key, true])) as Record<string, true>;
  const objectSchema = schema as unknown as {
    omit: (mask: Record<string, true>) => ToolParametersSchema;
  };
  if (typeof objectSchema.omit !== 'function') {
    throw new TypeError('bind() expects a Zod object schema');
  }
  return objectSchema.omit(mask);
}

function mergeBoundParams(params: unknown, bound: unknown): unknown {
  const input = isPlainObject(params) ? params : {};
  return { ...input, ...(bound as Record<string, unknown>) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
