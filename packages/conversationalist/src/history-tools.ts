import type { ToolInteraction } from './conversation/index';
import {
  appendToolCall,
  appendToolCalls,
  appendToolResult,
  appendToolResultAsync,
  appendToolResults,
  appendToolResultsAsync,
  getPendingToolCalls,
  getToolInteractions,
  resolveToolResult,
  resolveToolResultAsync,
} from './conversation/index';
import type { ConversationEnvironment } from './environment';
import type { ConversationActionType } from './events';
import type { AppendableToolCallInput, AppendableToolResult, ConversationHistory } from './types';

type ToolHooks = {
  readonly current: () => ConversationHistory;
  readonly environment: ConversationEnvironment;
  readonly assertOpen: () => void;
  readonly commit: (
    next: ConversationHistory,
    action: ConversationActionType,
    events: readonly ConversationActionType[],
    context?: { messageIds?: string[]; toolCallIds?: string[] },
  ) => void;
  readonly runOwned: <T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly context: (
    previous: ConversationHistory,
    next: ConversationHistory,
    action: 'messages.appended' | 'messages.updated' | 'messages.removed',
  ) => { messageIds?: string[]; toolCallIds?: string[] };
};

export type ToolActions = {
  readonly appendToolCall: (
    toolCall: AppendableToolCallInput,
    options?: Parameters<typeof appendToolCall>[2],
  ) => void;
  readonly appendToolCalls: (toolCalls: ReadonlyArray<AppendableToolCallInput>) => void;
  readonly appendToolResult: (
    toolResult: AppendableToolResult,
    options?: Parameters<typeof appendToolResult>[2],
  ) => void;
  readonly resolveToolResult: (
    callId: string,
    result: AppendableToolResult,
    options?: Parameters<typeof resolveToolResult>[3],
  ) => void;
  readonly resolveToolResultAsync: (
    callId: string,
    result: AppendableToolResult,
    options?: Parameters<typeof resolveToolResultAsync>[3],
  ) => Promise<void>;
  readonly appendToolResults: (results: ReadonlyArray<AppendableToolResult>) => void;
  readonly appendToolResultAsync: (
    result: AppendableToolResult,
    options?: Parameters<typeof appendToolResultAsync>[2],
  ) => Promise<void>;
  readonly appendToolResultsAsync: (results: ReadonlyArray<AppendableToolResult>) => Promise<void>;
  readonly getPendingToolCalls: () => ReturnType<typeof getPendingToolCalls>;
  readonly getToolInteractions: () => ToolInteraction[];
};

export function createToolActions(hooks: ToolHooks): ToolActions {
  const commit = (next: ConversationHistory, action: ConversationActionType): void => {
    const previous = hooks.current();
    hooks.commit(
      next,
      action,
      ['push', action],
      hooks.context(
        previous,
        next,
        action === 'messages.appended' ||
          action === 'messages.updated' ||
          action === 'messages.removed'
          ? action
          : 'messages.appended',
      ),
    );
  };
  return {
    appendToolCall: (toolCall, options) => {
      hooks.assertOpen();
      commit(
        appendToolCall(hooks.current(), toolCall, options, hooks.environment),
        'tool-calls.appended',
      );
    },
    appendToolCalls: (toolCalls) => {
      hooks.assertOpen();
      const next = appendToolCalls(hooks.current(), toolCalls, hooks.environment);
      if (next !== hooks.current()) commit(next, 'tool-calls.appended');
    },
    appendToolResult: (result, options) => {
      hooks.assertOpen();
      commit(
        appendToolResult(hooks.current(), result, options, hooks.environment),
        'tool-results.appended',
      );
    },
    resolveToolResult: (callId, result, options) => {
      hooks.assertOpen();
      commit(
        resolveToolResult(hooks.current(), callId, result, options, hooks.environment),
        'messages.updated',
      );
    },
    resolveToolResultAsync: async (callId, result, options) => {
      const previous = hooks.current();
      const next = await hooks.runOwned('resolveToolResultAsync', (signal) =>
        resolveToolResultAsync(
          hooks.current(),
          callId,
          result,
          {
            ...options,
            signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
          },
          hooks.environment,
        ),
      );
      hooks.commit(
        next,
        'messages.updated',
        ['push', 'messages.updated'],
        hooks.context(previous, next, 'messages.updated'),
      );
    },
    appendToolResults: (results) => {
      hooks.assertOpen();
      const next = appendToolResults(hooks.current(), results, hooks.environment);
      if (next !== hooks.current()) commit(next, 'tool-results.appended');
    },
    appendToolResultAsync: async (result, options) => {
      const next = await hooks.runOwned('appendToolResultAsync', (signal) =>
        appendToolResultAsync(
          hooks.current(),
          result,
          {
            ...options,
            signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
          },
          hooks.environment,
        ),
      );
      commit(next, 'tool-results.appended');
    },
    appendToolResultsAsync: async (results) => {
      const next = await hooks.runOwned('appendToolResultsAsync', (signal) =>
        appendToolResultsAsync(hooks.current(), results, hooks.environment, signal),
      );
      if (next !== hooks.current()) commit(next, 'tool-results.appended');
    },
    getPendingToolCalls: () => getPendingToolCalls(hooks.current()),
    getToolInteractions: () => getToolInteractions(hooks.current()),
  };
}
