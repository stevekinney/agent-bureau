import { createIncrementalHash } from '@lostgradient/cryptography';

import type { ToolErrorCategory } from '../core/errors';
import type { ToolExecutionIdentity } from '../event-types';
import type {
  ToolCallWithArguments,
  ToolExecuteOptions,
  ToolPolicyAfterContext,
  ToolPolicyContext,
} from '../is-tool';
import { isAsyncIterable } from '../type-guards';
import type { ToolExecutionValue, TypedToolExecutionResult } from '../types';
import { toolExecutionValue } from '../types';
import { stableStringify } from './content';
import { classifyErrorCategory } from './errors';
import type { BaseDetail, Emit, ExecutionDetail } from './execution-contracts';
import {
  errorTelemetry,
  streamEndDetail,
  streamErrorDetail,
  streamStartDetail,
  successTelemetry,
} from './streaming-details';

type StreamingInput<TReturn> = {
  value: TReturn;
  options: ToolExecuteOptions & {
    executionHandle?: {
      activity: () => void;
      cleanup: (report?: { status: 'failed'; error: unknown }) => void;
      cleanupPending: (reason: unknown) => void;
      settle: (result: unknown) => void;
      signal: AbortSignal;
      unknownEffect: (result?: unknown) => void;
      streaming: () => void;
      whenSettled: () => Promise<unknown>;
    };
  };
  now: () => number;
  digestOptions: ReturnType<typeof normalizeDigestShape>;
  baseDetail: BaseDetail;
  parsedDetail: ExecutionDetail;
  policyContext: ToolPolicyContext;
  typedToolCall: ToolCallWithArguments;
  name: string;
  inputDigest?: string | undefined;
  executedArgumentsEdited: boolean;
  emit: Emit;
  runPolicyAfter: (
    context: ToolPolicyAfterContext,
    signal: ToolExecuteOptions['signal'],
    identity?: ToolExecutionIdentity,
  ) => Promise<void>;
  finishTelemetry: (
    status: 'success' | 'error',
    details?: {
      result?: unknown;
      error?: unknown;
      errorCategory?: ToolErrorCategory;
      inputDigest?: string;
      outputDigest?: string;
    },
  ) => void;
  createAbortRejection: (reason?: unknown) => Error;
};

export type StreamingOutcome<TReturn> =
  | {
      kind: 'value';
      value: TReturn | unknown[];
      outputDigest: string | undefined;
      executionValue: ToolExecutionValue<TReturn>;
    }
  | { kind: 'result'; result: TypedToolExecutionResult<TReturn> };

function normalizeDigestShape(input: { output: boolean; algorithm: 'sha256' }) {
  return input;
}

export async function handleStreamingExecution<TReturn>(
  input: StreamingInput<TReturn>,
): Promise<StreamingOutcome<TReturn>> {
  if (!isAsyncIterable(input.value)) {
    return {
      kind: 'value',
      value: input.value,
      outputDigest: undefined,
      executionValue: { kind: 'callback', value: input.value },
    };
  }
  const streamValue = input.value;
  if (input.options.stream === true) return createLiveStreamResult<TReturn>(input, streamValue);
  return collectStreamResult<TReturn, unknown>(input, streamValue);
}

function createAccumulator(input: Pick<StreamingInput<unknown>, 'digestOptions'>) {
  return {
    chunks: [] as unknown[],
    index: 0,
    completed: false,
    digest: input.digestOptions.output
      ? createIncrementalHash(input.digestOptions.algorithm)
      : undefined,
  };
}

function finalizeAccumulator(accumulator: ReturnType<typeof createAccumulator>) {
  const finalizedDigest = accumulator.digest?.digest();
  return {
    collected: accumulator.chunks,
    ...(finalizedDigest !== undefined ? { outputDigest: finalizedDigest } : {}),
  };
}

function assertStreamingWindow<TReturn>(
  input: StreamingInput<TReturn>,
  deadline: number | undefined,
): void {
  if (input.options.signal?.aborted) throw input.createAbortRejection(input.options.signal.reason);
  if (deadline !== undefined && input.now() > deadline) throw new Error('TIMEOUT');
}

function processChunk(
  chunk: unknown,
  accumulator: {
    chunks: unknown[];
    index: number;
    digest?: { update(value: string): void } | undefined;
  },
  input: Pick<StreamingInput<unknown>, 'baseDetail' | 'emit'>,
): void {
  const streamIdentity = {
    executionId: input.baseDetail.executionId,
    ownerId: input.baseDetail.ownerId,
  };
  input.emit('stream-chunk', { ...streamIdentity, chunk, index: accumulator.index });
  input.emit('output-chunk', { ...streamIdentity, chunk });
  accumulator.chunks.push(chunk);
  accumulator.digest?.update(stableStringify(chunk) ?? '');
  accumulator.index += 1;
}

async function collectStreamResult<TReturn, TChunk>(
  input: StreamingInput<TReturn>,
  streamValue: TReturn & AsyncIterable<TChunk>,
): Promise<StreamingOutcome<TReturn>> {
  input.emit('stream-start', streamStartDetail('collect', input));
  const accumulator = createAccumulator(input);
  const deadline = streamDeadline(input);
  try {
    for await (const chunk of streamValue) {
      assertStreamingWindow(input, deadline);
      processChunk(chunk, accumulator, input);
    }
    accumulator.completed = true;
    input.emit('stream-end', streamEndDetail(accumulator, input));
  } catch (error) {
    input.emit('stream-error', streamErrorDetail(error, accumulator, input));
    throw error;
  }
  const finalized = finalizeAccumulator(accumulator);
  return {
    kind: 'value',
    value: finalized.collected,
    outputDigest: finalized.outputDigest,
    executionValue: { kind: 'collected-stream', value: finalized.collected },
  };
}

function createLiveStreamResult<TReturn>(
  input: StreamingInput<TReturn>,
  streamValue: TReturn & AsyncIterable<unknown>,
): StreamingOutcome<TReturn> {
  input.emit('stream-start', streamStartDetail('stream', input));
  const streamIterator = streamValue[Symbol.asyncIterator]();
  const accumulator = createAccumulator(input);
  const deadline = streamDeadline(input);
  input.options.executionHandle?.streaming();
  const onExecutionAbort = () => handleLiveStreamAbort(streamIterator, input);
  input.options.executionHandle?.signal.addEventListener('abort', onExecutionAbort, { once: true });
  const stream = liveStreamIterator(streamIterator, accumulator, deadline, input, onExecutionAbort);
  const callId = input.typedToolCall.id;
  const result: TypedToolExecutionResult<TReturn> = {
    callId,
    outcome: 'success',
    content: '[stream]',
    toolCallId: callId,
    toolName: input.name,
    result: stream,
    stream,
    executedArgumentsEdited: input.executedArgumentsEdited,
    inputDigest: input.inputDigest,
  };
  result[toolExecutionValue] = { kind: 'live-stream', value: streamValue };
  return { kind: 'result', result };
}

function handleLiveStreamAbort(
  streamIterator: AsyncIterator<unknown>,
  input: StreamingInput<unknown>,
): void {
  const executionHandle = input.options.executionHandle;
  if (!executionHandle) return;
  executionHandle.cleanupPending('stream return requested');
  if (!streamIterator.return) {
    executionHandle.unknownEffect('stream iterator has no return method');
    return;
  }
  void Promise.resolve(streamIterator.return()).then(
    () => executionHandle.cleanup(),
    (error) => executionHandle.cleanup({ status: 'failed', error }),
  );
}

async function* liveStreamIterator(
  streamIterator: AsyncIterator<unknown>,
  accumulator: ReturnType<typeof createAccumulator>,
  deadline: number | undefined,
  input: StreamingInput<unknown>,
  onExecutionAbort: () => void,
): AsyncIterableIterator<unknown> {
  let streamError: unknown;
  try {
    yield* consumeLiveStream(streamIterator, accumulator, deadline, input);
  } catch (error) {
    streamError = error;
    input.emit('stream-error', streamErrorDetail(error, accumulator, input));
    throw error;
  } finally {
    input.options.executionHandle?.signal.removeEventListener('abort', onExecutionAbort);
    await finalizeLiveStream(streamError, accumulator, input);
  }
}

async function* consumeLiveStream(
  streamIterator: AsyncIterator<unknown>,
  accumulator: ReturnType<typeof createAccumulator>,
  deadline: number | undefined,
  input: StreamingInput<unknown>,
): AsyncIterableIterator<unknown> {
  for await (const chunk of { [Symbol.asyncIterator]: () => streamIterator }) {
    assertStreamingWindow(input, deadline);
    processChunk(chunk, accumulator, input);
    input.options.executionHandle?.activity();
    yield chunk;
    assertStreamingWindow(input, deadline);
  }
  accumulator.completed = true;
}

async function finalizeLiveStream(
  streamError: unknown,
  accumulator: ReturnType<typeof createAccumulator>,
  input: StreamingInput<unknown>,
): Promise<void> {
  const finalized = finalizeAccumulator(accumulator);
  input.emit('stream-end', streamEndDetail(accumulator, input));
  if (streamError === undefined) {
    await finalizeLiveStreamSuccess(finalized, input);
    return;
  }
  await finalizeLiveStreamError(streamError, input);
}

async function finalizeLiveStreamSuccess(
  finalized: { collected: unknown[]; outputDigest?: string },
  input: StreamingInput<unknown>,
): Promise<void> {
  input.emit('execute-success', { ...input.parsedDetail, result: finalized.collected });
  input.emit('settled', {
    ...input.parsedDetail,
    result: finalized.collected,
    callbackCompletion: input.options.executionHandle?.whenSettled(),
  });
  const policyAfter: ToolPolicyAfterContext = {
    ...input.policyContext,
    outcome: 'success',
    result: finalized.collected,
  };
  if (finalized.outputDigest !== undefined) policyAfter.outputDigest = finalized.outputDigest;
  await input.runPolicyAfter(policyAfter, input.options.signal, input.parsedDetail);
  input.finishTelemetry(
    'success',
    successTelemetry(finalized.collected, finalized.outputDigest, input),
  );
  input.options.executionHandle?.settle(finalized.collected);
}

async function finalizeLiveStreamError(
  streamError: unknown,
  input: StreamingInput<unknown>,
): Promise<void> {
  input.emit('execute-error', { ...input.parsedDetail, error: streamError });
  input.emit('settled', {
    ...input.parsedDetail,
    error: streamError,
    callbackCompletion: input.options.executionHandle?.whenSettled(),
  });
  const streamErrorCategory = classifyErrorCategory(streamError);
  await input.runPolicyAfter(
    {
      ...input.policyContext,
      outcome: 'error',
      errorCategory: streamErrorCategory,
      error: streamError,
    },
    input.options.signal,
    input.parsedDetail,
  );
  input.finishTelemetry('error', errorTelemetry(streamError, streamErrorCategory, input));
  input.options.executionHandle?.settle(streamError);
}

function streamDeadline(input: StreamingInput<unknown>): number | undefined {
  return typeof input.options.timeout === 'number'
    ? input.now() + input.options.timeout
    : undefined;
}
