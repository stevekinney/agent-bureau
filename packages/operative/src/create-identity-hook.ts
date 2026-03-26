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
}

/**
 * Creates a PrepareStepHook that loads and injects the resolved identity
 * into the conversation at the start of a run.
 *
 * The hook fires on step 0 only. The resolved identity is cached for
 * the duration of the run — it is not reloaded on every step.
 *
 * If the resolve function throws (storage unavailable, network error),
 * the hook logs a warning and proceeds without identity injection.
 * The run should not fail because identity could not be loaded.
 */
export function createIdentityHook(options: CreateIdentityHookOptions): PrepareStepHook {
  const { resolve } = options;

  let cachedIdentity: string | undefined;
  let injected = false;

  return async (context) => {
    // Only inject on step 0
    if (context.step !== 0) return;
    if (injected) return;

    try {
      if (cachedIdentity === undefined) {
        cachedIdentity = await resolve();
      }

      if (cachedIdentity && cachedIdentity.length > 0) {
        context.conversation.appendSystemMessage(cachedIdentity, {
          _identityInjected: true,
        });
      }

      injected = true;
    } catch {
      // Degrade gracefully — do not crash the agent loop.
      // The identity system is not essential for the run to proceed.
    }
  };
}
