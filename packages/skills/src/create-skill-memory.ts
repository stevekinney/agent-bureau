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
// Public API
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
