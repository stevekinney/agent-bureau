import type { Memory, MemorySearchResult } from '../types';

/**
 * Minimal conversation interface compatible with operative's StepContext.
 * Avoids a direct dependency on the operative or conversationalist packages.
 */
interface ConversationLike {
  getMessages(options?: { includeHidden?: boolean }): ReadonlyArray<MessageLike>;
  appendSystemMessage(content: string, metadata?: Record<string, unknown>): void;
}

interface MessageLike {
  role: string;
  content: string | ReadonlyArray<unknown>;
}

/**
 * Minimal step context compatible with operative's StepContext.
 */
interface StepContextLike {
  conversation: ConversationLike;
  step: number;
  signal?: AbortSignal;
}

/**
 * Minimal tool execution result context compatible with operative's ToolExecutionResultContext.
 */
interface ToolExecutionResultContextLike {
  conversation: ConversationLike;
  step: number;
  results: ReadonlyArray<{ result?: unknown }>;
}

export interface MemoryHookOptions {
  memory: Memory;
  namespace?: string;
  autoRecall?: boolean;
  autoCapture?: boolean;
  recallLimit?: number;
}

const REMEMBER_TRIGGER_PATTERNS = [
  /\bremember\b/i,
  /\bdon'?t forget\b/i,
  /\bkeep in mind\b/i,
  /\bnote that\b/i,
  /\bsave this\b/i,
  /\bstore this\b/i,
  /\bfor future reference\b/i,
  /\bimportant:\s/i,
];

function formatMemories(results: MemorySearchResult[]): string {
  const lines = results.map((result) => `- ${result.content}`);
  return `Relevant memories:\n${lines.join('\n')}`;
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

function containsRememberTrigger(text: string): boolean {
  return REMEMBER_TRIGGER_PATTERNS.some((pattern) => pattern.test(text));
}

function extractRememberContent(text: string): string {
  // Remove the trigger phrase itself and return the meaningful content
  let content = text;
  for (const pattern of REMEMBER_TRIGGER_PATTERNS) {
    content = content.replace(pattern, '').trim();
  }
  // If stripping triggers left nothing useful, return the original text
  return content.length > 0 ? content : text;
}

/**
 * Creates memory-aware hooks for the operative agent loop.
 *
 * - `prepareStep` performs auto-recall: retrieves relevant memories before each step
 *   and injects them as a system message in the conversation.
 * - `afterToolExecution` performs auto-capture: detects trigger keywords in user
 *   messages that indicate content should be remembered, and stores it.
 */
export function createMemoryHooks(options: MemoryHookOptions): {
  prepareStep: (context: StepContextLike) => Promise<void>;
  afterToolExecution: (context: ToolExecutionResultContextLike) => Promise<void>;
} {
  const { memory, namespace, autoRecall = true, autoCapture = true, recallLimit = 5 } = options;

  const searchOptions = namespace ? { namespace, limit: recallLimit } : { limit: recallLimit };

  async function prepareStep(context: StepContextLike): Promise<void> {
    if (!autoRecall) return;

    const lastUserMessage = extractLastUserMessage(context.conversation);
    if (!lastUserMessage) return;

    const results = await memory.recall(lastUserMessage, searchOptions);
    if (results.length === 0) return;

    const memorySummary = formatMemories(results);
    context.conversation.appendSystemMessage(memorySummary, {
      _memoryInjected: true,
    });
  }

  async function afterToolExecution(context: ToolExecutionResultContextLike): Promise<void> {
    if (!autoCapture) return;

    const lastUserMessage = extractLastUserMessage(context.conversation);
    if (!lastUserMessage) return;

    if (!containsRememberTrigger(lastUserMessage)) return;

    const content = extractRememberContent(lastUserMessage);
    await memory.remember(content, {
      source: 'auto-capture',
      ...(namespace ? { namespace } : {}),
    });
  }

  return { prepareStep, afterToolExecution };
}
