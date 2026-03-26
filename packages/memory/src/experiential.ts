import type { Memory } from './types';

// ---------------------------------------------------------------------------
// Minimal interfaces compatible with operative types, avoiding a hard
// dependency on the operative package. Same pattern as
// hooks/create-memory-hooks.ts.
// ---------------------------------------------------------------------------

interface ConversationLike {
  getMessages(options?: { includeHidden?: boolean }): ReadonlyArray<MessageLike>;
}

interface MessageLike {
  role: string;
  content: string | ReadonlyArray<unknown>;
}

/**
 * Minimal step result compatible with operative's `StepResult`.
 * Avoids importing operative directly so the memory package stays
 * dependency-free.
 */
export interface StepResultLike {
  step: number;
  conversation: ConversationLike;
  content: string;
  final: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Options for `createRunCaptureHook`.
 */
export interface RunCaptureHookOptions {
  /** Memory instance to store run summaries in. */
  memory: Memory;
  /** Namespace for stored entries. Default: `'experiential'`. */
  namespace?: string;
  /** Override the default `summarizeRun` function. */
  summarize?: (result: StepResultLike) => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFirstUserMessage(conversation: ConversationLike): string {
  const messages = conversation.getMessages();
  for (const message of messages) {
    if (message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '(unknown)';
}

function extractApproachSummary(conversation: ConversationLike): string {
  const messages = conversation.getMessages();
  const assistantMessages: string[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && typeof message.content === 'string') {
      const truncated =
        message.content.length > 120 ? `${message.content.slice(0, 120)}...` : message.content;
      assistantMessages.push(truncated);
      if (assistantMessages.length >= 3) break;
    }
  }

  return assistantMessages.length > 0 ? assistantMessages.join(' -> ') : '(direct)';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produces a structured text summary from a completed run's final step result.
 *
 * Extracts:
 * - The user's initial query (first user message)
 * - The approach taken (first 3 assistant messages, condensed)
 * - The outcome (final content snippet)
 * - Step count
 */
export function summarizeRun(result: StepResultLike): string {
  const initialQuery = extractFirstUserMessage(result.conversation);
  const approach = extractApproachSummary(result.conversation);
  const outcomeSnippet =
    result.content.length > 200 ? `${result.content.slice(0, 200)}...` : result.content;

  return [
    '## Run Summary',
    `- Initial query: ${initialQuery}`,
    `- Approach: ${approach}`,
    `- Outcome: ${outcomeSnippet}`,
    `- Steps: ${result.step + 1}`,
  ].join('\n');
}

/**
 * Creates an `onStep` hook that captures a compressed run summary as a memory
 * entry when a run completes. This is the foundation for agents that learn
 * from experience.
 *
 * The hook fires only on the final step (`result.final === true`).
 */
export function createRunCaptureHook(options: RunCaptureHookOptions): {
  onStep: (context: StepResultLike) => Promise<void>;
} {
  const { memory, namespace = 'experiential', summarize: customSummarize } = options;

  return {
    async onStep(context: StepResultLike): Promise<void> {
      if (!context.final) return;

      const summary = customSummarize ? customSummarize(context) : summarizeRun(context);

      const finishReason = context.metadata?.['finishReason'] as string | undefined;
      const agentId = context.metadata?.['agentId'] as string | undefined;

      await memory.remember(summary, {
        source: 'experiential',
        namespace,
        tags: ['case'],
        ...(finishReason ? { finishReason } : {}),
        ...(agentId ? { agentId } : {}),
      });
    },
  };
}
