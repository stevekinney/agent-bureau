import { createManualRuntimeServices } from 'lifecycle';

import type { GenerateContext } from '../../types.ts';
import type { ModelRoute } from '../types.ts';

// AB-330: incidental message timestamp reads through a manual runtime instead
// of the real clock so this test helper's real-runtime read is deterministic.
const runtime = createManualRuntimeServices();

/**
 * Creates a minimal GenerateContext stub for routing strategy tests.
 *
 * Uses `as unknown as` casts because test fakes intentionally omit
 * most of the Conversation and Toolbox surface area — only the
 * properties actually read by routing strategies are provided.
 */
export function makeContext(overrides?: Partial<GenerateContext>): GenerateContext {
  return {
    conversation: {
      current: { ids: [], messages: {} },
    } as unknown as GenerateContext['conversation'],
    step: 0,
    toolbox: { tools: () => [] } as unknown as GenerateContext['toolbox'],
    ...overrides,
  };
}

/**
 * Creates a minimal GenerateContext with inline message data for routing
 * strategy tests that inspect conversation contents.
 */
export function makeContextWithMessages(
  messages: Array<{ role: string; content: string }>,
  overrides?: Partial<GenerateContext> & { step?: number },
): GenerateContext {
  const ids = messages.map((_, i) => `msg-${i}`);
  const messagesRecord: Record<string, unknown> = {};
  for (let i = 0; i < messages.length; i++) {
    messagesRecord[`msg-${i}`] = {
      id: `msg-${i}`,
      role: messages[i]!.role,
      content: messages[i]!.content,
      position: i,
      createdAt: runtime.clock.nowISO(),
      metadata: {},
      hidden: false,
    };
  }

  return {
    conversation: {
      current: { ids, messages: messagesRecord },
    } as unknown as GenerateContext['conversation'],
    step: overrides?.step ?? 0,
    toolbox: overrides?.toolbox ?? ({ tools: () => [] } as unknown as GenerateContext['toolbox']),
    ...overrides,
  };
}

/** Creates a basic set of model routes for testing. */
export function makeRoutes(names: string[] = ['fast', 'smart', 'frontier']): ModelRoute[] {
  return names.map((name) => ({
    name,
    generate: () => Promise.resolve({ content: '', toolCalls: [] }),
  }));
}

/**
 * Creates a minimal toolbox fake exposing only `tools()` — the one method the
 * routing strategies read. Entries carry just a name, so the cast documents
 * that the rest of the Toolbox surface is intentionally absent.
 */
export function makeToolbox(names: readonly string[]): GenerateContext['toolbox'] {
  const tools = names.map((name) => ({ name }));
  return { tools: () => tools } as unknown as GenerateContext['toolbox'];
}
