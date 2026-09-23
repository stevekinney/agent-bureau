import type { ToolErrorCategory } from '../core/errors';
import type { ToolExecutionIdentity } from '../event-types';

type StreamIdentityInput = {
  baseDetail: ToolExecutionIdentity;
  inputDigest?: string | undefined;
};

export type StreamAccumulatorSummary = {
  index: number;
  completed: boolean;
};

export function streamStartDetail(mode: 'stream' | 'collect', input: StreamIdentityInput) {
  return { mode, ...executionIdentity(input) };
}

export function streamEndDetail(accumulator: StreamAccumulatorSummary, input: StreamIdentityInput) {
  return {
    chunks: accumulator.index,
    completed: accumulator.completed,
    ...executionIdentity(input),
  };
}

export function streamErrorDetail(
  error: unknown,
  accumulator: Pick<StreamAccumulatorSummary, 'index'>,
  input: StreamIdentityInput,
) {
  return { error, index: accumulator.index, ...executionIdentity(input) };
}

export function successTelemetry(
  result: unknown,
  outputDigest: string | undefined,
  input: StreamIdentityInput,
) {
  return {
    result,
    ...(input.inputDigest !== undefined ? { inputDigest: input.inputDigest } : {}),
    ...(outputDigest !== undefined ? { outputDigest } : {}),
  };
}

export function errorTelemetry(
  error: unknown,
  errorCategory: ToolErrorCategory,
  input: StreamIdentityInput,
) {
  return {
    error,
    errorCategory,
    ...(input.inputDigest !== undefined ? { inputDigest: input.inputDigest } : {}),
  };
}

function executionIdentity(input: StreamIdentityInput) {
  return {
    executionId: input.baseDetail.executionId,
    ownerId: input.baseDetail.ownerId,
  };
}
