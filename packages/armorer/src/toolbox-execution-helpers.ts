import { createToolCall } from './create-tool';
import type { ExecutionHandle } from './execution-lifecycle';
import { normalizeToolCallArguments } from './toolbox-normalization';
import { isAsyncIterable } from './type-guards';
import type { ToolCall, ToolCallInput, ToolExecutionResult } from './types';

export function normalizeToolCall(call: ToolCallInput): ToolCall {
  const args = Object.prototype.hasOwnProperty.call(call, 'arguments') ? call.arguments : {};
  const id = typeof call.id === 'string' && call.id.length ? call.id : undefined;
  return createToolCall(call.name, normalizeToolCallArguments(args), id);
}

export function resolveResultStream(
  result: ToolExecutionResult,
): AsyncIterable<unknown> | undefined {
  if (isAsyncIterable(result.stream)) return result.stream;
  if (isAsyncIterable(result.result)) return result.result;
  return undefined;
}

export function wrapAsyncIterable(
  stream: AsyncIterable<unknown>,
  onFinalize: () => void,
  executionHandle?: ExecutionHandle,
): AsyncIterable<unknown> {
  let finalized = false;
  const iterator = stream[Symbol.asyncIterator]();
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    executionHandle?.signal.removeEventListener('abort', onAbort);
    onFinalize();
  };
  const onAbort = () => {
    executionHandle?.cleanupPending('stream return requested');
    if (!iterator.return) {
      executionHandle?.unknownEffect('stream iterator has no return method');
      finalize();
      return;
    }
    void Promise.resolve(iterator.return()).then(
      () => finalize(),
      (error) => {
        executionHandle?.cleanup({ status: 'failed', error });
        finalize();
      },
    );
  };
  executionHandle?.signal.addEventListener('abort', onAbort, { once: true });
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) yield chunk;
      } finally {
        finalize();
      }
    },
  };
}
