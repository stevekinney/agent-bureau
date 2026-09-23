import type { z } from 'zod';

import type { DefaultToolEvents, Tool, ToolEventsMap, ToolMetadata } from './is-tool';
import type { ToolCallReturn } from './types';

/** Extract input type from a tool's schema */
export type InferToolInput<T> =
  T extends Tool<infer S, infer _E, infer _R, infer _M>
    ? z.infer<S> extends object
      ? z.infer<S>
      : Record<string, unknown>
    : Record<string, unknown>;

/** Extract output type from a tool */
export type InferToolOutput<T> = T extends Tool<infer _S, infer _E, infer R, infer _M> ? R : never;

/** The value exposed by a tool's parameter-based execute overload. */
export type InferToolExecutionOutput<T> =
  T extends Tool<infer _S, infer _E, infer R, infer _M> ? ToolCallReturn<R> : never;

/** Preserve the concrete input schema when composing tools. */
export type InferToolSchema<T> = T extends Tool<infer S, infer _E, infer _R, infer _M> ? S : never;

/** Extract the metadata type from a tool. */
export type InferToolMetadata<T> =
  T extends Tool<infer _S, infer _E, infer _R, infer M> ? M : ToolMetadata | undefined;

/** Any tool (for constraint purposes) */
export type AnyTool = Tool<z.ZodType, ToolEventsMap>;

/** Tool that accepts a specific input type */
export type ToolWithInput<I extends object> = Tool<z.ZodType<I>, ToolEventsMap> & {
  __toolInput?: I;
};

/** Step event detail for composed tools */
export interface StepStartDetail {
  stepIndex: number;
  stepName: string;
  input: unknown;
}

export interface StepCompleteDetail {
  stepIndex: number;
  stepName: string;
  output: unknown;
}

export interface StepErrorDetail {
  stepIndex: number;
  stepName: string;
  error: unknown;
}

/** Events emitted by composed tools (extends default events with index signature) */
export type ComposedToolEvents = DefaultToolEvents & {
  'step-start': StepStartDetail;
  'step-complete': StepCompleteDetail;
  'step-error': StepErrorDetail;
  [key: string]: unknown;
};

/**
 * Composed tool result type - uses DefaultToolEvents by default.
 *
 * `TMetadata` defaults to `ToolMetadata | undefined` rather than the
 * previously hardcoded `undefined`: `preprocess`/`postprocess`
 * (`src/utilities/preprocess.ts`, `src/utilities/postprocess.ts`) carry the
 * wrapped tool's `metadata` through onto the composed tool's configuration
 * at runtime, so a composed tool's `.metadata` is not always `undefined`.
 */
export type ComposedTool<
  TInput,
  TOutput,
  TMetadata extends ToolMetadata | undefined = ToolMetadata | undefined,
> = Tool<z.ZodType<TInput>, DefaultToolEvents, TOutput, TMetadata>;
