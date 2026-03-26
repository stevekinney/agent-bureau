import type {
  ConversationLike,
  MemoryLike,
  StepContextLike,
  StepResultLike,
} from './create-skill-memory';

/**
 * Options for `createSkillMemoryHooks`.
 */
export interface CreateSkillMemoryHooksOptions {
  /** The skill-scoped memory instance. */
  memory: MemoryLike;
  /** Query to use for recalling skill-specific memories. */
  recallQuery?: string | ((conversation: ConversationLike) => string);
  /** Maximum entries to recall. Default: 5. */
  recallLimit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLastUserMessage(conversation: ConversationLike): string | undefined {
  const messages = conversation.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates hooks that integrate skill-scoped memory with the agent loop.
 *
 * - `prepareStep` fires on step 0 only. Recalls relevant skill-specific
 *   memories using either the last user message or a provided `recallQuery`.
 * - `onStep` fires on the final step only (`result.final === true`). Stores
 *   the assistant's response as a skill learning with `source: 'experiential'`
 *   and `tags: ['skill-learning']`.
 *
 * Both hooks degrade gracefully — memory failures do not crash the agent loop.
 */
export function createSkillMemoryHooks(options: CreateSkillMemoryHooksOptions): {
  prepareStep: (context: StepContextLike) => Promise<void>;
  onStep: (result: StepResultLike) => Promise<void>;
} {
  const { memory, recallQuery, recallLimit = 5 } = options;

  const prepareStep = async (context: StepContextLike): Promise<void> => {
    if (context.step !== 0) return;

    try {
      let query: string | undefined;

      if (typeof recallQuery === 'function') {
        query = recallQuery(context.conversation);
      } else if (typeof recallQuery === 'string') {
        query = recallQuery;
      } else {
        query = extractLastUserMessage(context.conversation);
      }

      if (!query) return;

      await memory.recall(query, { limit: recallLimit });
    } catch {
      // Degrade gracefully — do not crash the agent loop.
    }
  };

  const onStep = async (result: StepResultLike): Promise<void> => {
    if (!result.final) return;

    try {
      if (!result.content) return;

      await memory.remember(result.content, {
        source: 'experiential',
        tags: ['skill-learning'],
      });
    } catch {
      // Degrade gracefully — do not crash the agent loop.
    }
  };

  return { prepareStep, onStep };
}
