// ---------------------------------------------------------------------------
// Structural interfaces — skills must not depend on the memory or operative
// packages. These are structurally compatible with their concrete counterparts.
// ---------------------------------------------------------------------------

/**
 * Structural interface compatible with Memory from the memory package.
 * Defined here to avoid skills depending on memory's concrete implementation.
 */
export interface MemoryLike {
  remember(content: string, metadata?: Record<string, unknown>): Promise<unknown>;
  recall(
    query: string,
    options?: { limit?: number; namespace?: string },
  ): Promise<ReadonlyArray<{ content: string; score: number }>>;
}

/**
 * Structural interface for a conversation, compatible with Conversation from
 * conversationalist without importing it.
 */
export interface ConversationLike {
  getMessages(options?: {
    includeHidden?: boolean;
  }): ReadonlyArray<{ role: string; content: string | ReadonlyArray<unknown> }>;
}

/**
 * Structural interface for the context passed to a prepareStep hook.
 */
export interface StepContextLike {
  conversation: ConversationLike;
  step: number;
}

/**
 * Structural interface for the result of a single agent loop step.
 */
export interface StepResultLike {
  step: number;
  conversation: ConversationLike;
  content: string;
  final: boolean;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Skill Memory
// ---------------------------------------------------------------------------

/**
 * Creates a skill-scoped memory wrapper that isolates all operations
 * to the `skill:{name}` namespace. Entries stored through this wrapper
 * don't appear in general memory queries, and vice versa.
 */
export function createSkillMemory(memory: MemoryLike, skillName: string): MemoryLike {
  const namespace = `skill:${skillName}`;

  return {
    async remember(content, metadata) {
      return memory.remember(content, { ...metadata, namespace });
    },
    async recall(query, options) {
      return memory.recall(query, { ...options, namespace });
    },
  };
}

// ---------------------------------------------------------------------------
// Skill Memory Hooks
// ---------------------------------------------------------------------------

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

/**
 * Creates hooks that integrate skill-scoped memory with the agent loop.
 *
 * - `prepareStep` fires on step 0 only. Recalls relevant skill-specific
 *   memories using either the last user message or a provided `recallQuery`.
 *   Returns a formatted string of recalled memories, or undefined if none.
 * - `onStep` fires on the final step only (`result.final === true`). Stores
 *   the assistant's response as a skill learning with `source: 'experiential'`
 *   and `tags: ['skill-learning']`.
 *
 * Both hooks degrade gracefully — memory failures do not crash the agent loop.
 */
export function createSkillMemoryHooks(options: CreateSkillMemoryHooksOptions): {
  prepareStep: (context: StepContextLike) => Promise<string | undefined>;
  onStep: (result: StepResultLike) => Promise<void>;
} {
  const { memory, recallQuery, recallLimit = 5 } = options;

  const prepareStep = async (context: StepContextLike): Promise<string | undefined> => {
    if (context.step !== 0) return undefined;

    try {
      let query: string | undefined;

      if (typeof recallQuery === 'function') {
        query = recallQuery(context.conversation);
      } else if (typeof recallQuery === 'string') {
        query = recallQuery;
      } else {
        query = extractLastUserMessage(context.conversation);
      }

      if (!query) return undefined;

      const entries = await memory.recall(query, { limit: recallLimit });
      if (entries.length === 0) return undefined;

      return entries.map((entry) => entry.content).join('\n\n');
    } catch {
      // Degrade gracefully — do not crash the agent loop.
      return undefined;
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
