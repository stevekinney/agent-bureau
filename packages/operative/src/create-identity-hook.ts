import type { Message } from 'conversationalist';

import type { PrepareStepHook } from './types';

/**
 * Options for creating an identity injection hook.
 */
export interface CreateIdentityHookOptions {
  /**
   * Pre-bound function that resolves the agent's identity into a system
   * prompt string. The consumer wires this with their provider and
   * resolveIdentity function — operative never imports from memory.
   */
  resolve: () => Promise<string>;

  /**
   * Optional logger for warnings. Defaults to `console.warn`.
   */
  warn?: (message: string) => void;
}

/**
 * Creates a PrepareStepHook that loads and injects the resolved identity
 * into the conversation at the start of a run.
 *
 * The hook fires on step 0 only. It checks the conversation's existing
 * messages for `_identityInjected` metadata to ensure idempotency across
 * multiple `run()` calls that reuse the same hook instance.
 *
 * If the resolve function throws (storage unavailable, network error),
 * the hook logs a warning and proceeds without identity injection.
 * The run should not fail because identity could not be loaded.
 */
export function createIdentityHook(options: CreateIdentityHookOptions): PrepareStepHook {
  const { resolve, warn = console.warn } = options;

  return async (context) => {
    // Only inject on step 0
    if (context.step !== 0) return;

    // Check if identity was already injected into this conversation
    // (handles reuse of the same hook across multiple run() calls)
    const messages = context.conversation.getMessages();
    const alreadyInjected = messages.some(
      (message: Message) => message.metadata && '_identityInjected' in message.metadata,
    );
    if (alreadyInjected) return;

    try {
      const identity = await resolve();

      if (identity && identity.length > 0) {
        context.conversation.appendSystemMessage(identity, {
          _identityInjected: true,
        });
      }
    } catch (error) {
      // Degrade gracefully — do not crash the agent loop.
      // The identity system is not essential for the run to proceed.
      warn(`Identity resolution failed, proceeding without identity: ${String(error)}`);
    }
  };
}
