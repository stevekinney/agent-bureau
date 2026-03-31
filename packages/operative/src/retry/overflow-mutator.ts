import type { Message } from 'conversationalist';
import { Conversation } from 'conversationalist';

import type { GenerateContext } from '../types';
import type { RetryMutator } from './types';

/** Options for creating an overflow mutator. */
export interface OverflowMutatorOptions {
  /**
   * Summarizes older messages into a compact string.
   * Called with the messages that will be replaced by the summary.
   */
  summarize: (messages: ReadonlyArray<Message>) => Promise<string>;
  /**
   * Number of recent messages to retain verbatim after compaction.
   * Defaults to 4.
   */
  retainRecentMessages?: number;
  /**
   * Classifies an error as `'overflow'` or another category.
   * When omitted, a default classifier checks for common overflow
   * patterns in the error message.
   */
  classifyError?: (error: unknown) => string;
}

const OVERFLOW_PATTERNS = [
  'context_length_exceeded',
  'maximum context length',
  'too many tokens',
  'max_tokens',
  'context window',
  'token limit',
];

function defaultClassifyError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  for (const pattern of OVERFLOW_PATTERNS) {
    if (message.includes(pattern)) return 'overflow';
  }
  return 'unknown';
}

/**
 * Creates a retry mutator that compacts the conversation when an
 * overflow error is detected.
 *
 * Older messages are replaced with a system-level summary while
 * recent messages are retained verbatim, giving the model a shorter
 * context window for the retry attempt.
 */
export function createOverflowMutator(options: OverflowMutatorOptions): RetryMutator {
  const { summarize, retainRecentMessages = 4, classifyError = defaultClassifyError } = options;

  return async (context: GenerateContext, error: unknown, _attempt: number) => {
    const classification = classifyError(error);
    if (classification !== 'overflow') return;

    const messages = context.conversation.getMessages();
    if (messages.length <= retainRecentMessages) {
      // Not enough messages to compact — nothing useful we can do
      return;
    }

    const cutoff = messages.length - retainRecentMessages;
    const olderMessages = messages.slice(0, cutoff);
    const recentMessages = messages.slice(cutoff);

    const summary = await summarize(olderMessages);

    // Build a fresh conversation with the summary and retained messages
    const compacted = new Conversation();
    compacted.appendSystemMessage(`Previous conversation summary: ${summary}`);

    for (const message of recentMessages) {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('');

      switch (message.role) {
        case 'user':
          compacted.appendUserMessage(content, { ...message.metadata });
          break;
        case 'assistant':
          compacted.appendAssistantMessage(content, { ...message.metadata });
          break;
        case 'system':
          compacted.appendSystemMessage(content, { ...message.metadata });
          break;
        default:
          // tool-call, tool-result, etc. — re-append as user context
          compacted.appendUserMessage(content, { ...message.metadata });
          break;
      }
    }

    return {
      ...context,
      conversation: compacted,
    };
  };
}
