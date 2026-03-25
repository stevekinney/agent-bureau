import type { Conversation } from 'conversationalist';

import type { Scratchpad } from './create-scratchpad';
import type { OnStepHook, PrepareStepHook, StepResult } from './types';

// ---------------------------------------------------------------------------
// Minimal memory interface — operative must not depend on the memory package.
// This is structurally compatible with memory's `Memory` interface.
// ---------------------------------------------------------------------------

/**
 * Minimal memory interface for the scratchpad bridge. Structurally compatible
 * with the `Memory` type from the memory package without importing it.
 */
export interface MemoryLike {
  remember(content: string, metadata?: Record<string, unknown>): Promise<unknown>;
  recall(
    query: string,
    options?: { limit?: number; namespace?: string },
  ): Promise<ReadonlyArray<{ content: string; score: number }>>;
}

/**
 * Options for `createMemoryBridge`.
 */
export interface CreateMemoryBridgeOptions {
  /** Memory instance to read from and write to. */
  memory: MemoryLike;
  /** Scratchpad to populate and persist. */
  scratchpad: Scratchpad;
  /** Namespace for memory operations. Default: `'scratchpad'`. */
  namespace?: string;
  /**
   * Which scratchpad keys to persist to long-term memory on the final step.
   * When omitted, all keys are persisted.
   */
  persistKeys?: string[];
  /**
   * Query used to recall memories at run start. Can be a static string or a
   * function that extracts the query from the conversation. When omitted,
   * the last user message is used.
   */
  recallQuery?: string | ((conversation: Conversation) => string);
  /** Maximum number of memories to recall. Default: `5`. */
  recallLimit?: number;
  /** Scratchpad key to write recalled memories under. Default: `'memories'`. */
  scratchpadKey?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLastUserMessage(conversation: Conversation): string | undefined {
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
 * Creates a bridge between a scratchpad and long-term memory.
 *
 * Returns two hooks:
 * - `prepareStep`: On step 0, recalls relevant memories and writes them to
 *   the scratchpad.
 * - `onStep`: On the final step, reads the scratchpad and persists entries
 *   to long-term memory.
 *
 * Both hooks degrade gracefully — memory failures do not crash the agent loop.
 */
export function createMemoryBridge(options: CreateMemoryBridgeOptions): {
  prepareStep: PrepareStepHook;
  onStep: OnStepHook;
} {
  const {
    memory,
    scratchpad,
    namespace = 'scratchpad',
    persistKeys,
    recallQuery,
    recallLimit = 5,
    scratchpadKey = 'memories',
  } = options;

  const prepareStep: PrepareStepHook = async (context) => {
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

      const results = await memory.recall(query, {
        limit: recallLimit,
        namespace,
      });

      if (results.length > 0) {
        scratchpad.set(
          scratchpadKey,
          results.map((result) => result.content),
        );
      }
    } catch {
      // Degrade gracefully — do not crash the agent loop.
    }
  };

  const onStep: OnStepHook = async (context: StepResult) => {
    if (!context.final) return;

    try {
      const entries = scratchpad.toJSON();
      const entriesToPersist = persistKeys
        ? Object.entries(entries).filter(([key]) => persistKeys.includes(key))
        : Object.entries(entries);

      for (const [key, value] of entriesToPersist) {
        // Skip the recalled memories key — no need to re-persist what was recalled.
        if (key === scratchpadKey) continue;

        try {
          let content: string;

          if (typeof value === 'string') {
            content = value;
          } else {
            try {
              const json = JSON.stringify(value);
              if (typeof json === 'string') {
                content = json;
              } else {
                // Fallback for cases where JSON.stringify returns undefined.
                content = String(value);
              }
            } catch {
              // Fallback for unserializable values (e.g., circular structures).
              content = String(value);
            }
          }

          await memory.remember(content, {
            source: 'auto-capture',
            namespace,
            _scratchpadKey: key,
          });
        } catch {
          // Degrade gracefully per entry — skip this entry and continue.
          continue;
        }
      }
    } catch {
      // Degrade gracefully — do not crash the agent loop.
    }
  };

  return { prepareStep, onStep };
}
