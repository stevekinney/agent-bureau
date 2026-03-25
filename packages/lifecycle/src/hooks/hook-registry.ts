import type { HookMap, HookRegistrationOptions, HookRegistryOptions } from './types';

interface RegisteredHandler<F> {
  handler: F;
  priority: number;
  options: HookRegistrationOptions;
}

export class HookRegistry<M extends HookMap> {
  private readonly handlers = new Map<string, RegisteredHandler<M[keyof M & string]>[]>();
  private readonly registryOptions: HookRegistryOptions;

  constructor(options?: HookRegistryOptions) {
    this.registryOptions = options ?? {};
  }

  on<K extends keyof M & string>(
    hookName: K,
    handler: M[K],
    options?: HookRegistrationOptions,
  ): () => void {
    const priority = options?.priority ?? 0;
    const entry: RegisteredHandler<M[K]> = { handler, priority, options: options ?? {} };

    let list = this.handlers.get(hookName);
    if (!list) {
      list = [];
      this.handlers.set(hookName, list);
    }
    list.push(entry as RegisteredHandler<M[keyof M & string]>);

    return () => {
      const current = this.handlers.get(hookName);
      if (!current) return;
      const index = current.indexOf(entry as RegisteredHandler<M[keyof M & string]>);
      if (index !== -1) {
        current.splice(index, 1);
      }
      if (current.length === 0) {
        this.handlers.delete(hookName);
      }
    };
  }

  async run<K extends keyof M & string>(
    hookName: K,
    ...args: Parameters<M[K]>
  ): Promise<ReturnType<M[K]> | undefined> {
    const list = this.handlers.get(hookName);
    if (!list || list.length === 0) {
      return undefined;
    }

    const sorted = [...list].sort((a, b) => b.priority - a.priority);

    const currentArgs = [...args] as unknown[];
    let hasReturnedValue = false;

    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i]!;
      try {
        const result = await (entry.handler as unknown as (...args: unknown[]) => unknown)(
          ...currentArgs,
        );
        if (result !== undefined) {
          currentArgs[0] = result;
          hasReturnedValue = true;
        }
      } catch (error: unknown) {
        const errorHandler = entry.options.onError ?? this.registryOptions.onError;
        if (!errorHandler) {
          throw error;
        }
        const decision = errorHandler(error, { hookName, handlerIndex: i });
        if (decision === 'abort') {
          throw error;
        }
        // 'continue' — skip to next handler
      }
    }

    return (hasReturnedValue ? currentArgs[0] : undefined) as ReturnType<M[K]>;
  }

  has<K extends keyof M & string>(hookName: K): boolean {
    const list = this.handlers.get(hookName);
    return list !== undefined && list.length > 0;
  }

  clear<K extends keyof M & string>(hookName?: K): void {
    if (hookName !== undefined) {
      this.handlers.delete(hookName);
    } else {
      this.handlers.clear();
    }
  }

  /**
   * Returns all registered handler entries for a given hook, sorted by priority (descending).
   * Used internally by mergeHookRegistries.
   */
  getHandlers<K extends keyof M & string>(
    hookName: K,
  ): ReadonlyArray<{ handler: M[K]; priority: number; options: HookRegistrationOptions }> {
    const list = this.handlers.get(hookName);
    if (!list) return [];
    return [...list].sort((a, b) => b.priority - a.priority) as Array<{
      handler: M[K];
      priority: number;
      options: HookRegistrationOptions;
    }>;
  }

  /**
   * Returns all hook names that have at least one registered handler.
   */
  getHookNames(): ReadonlyArray<keyof M & string> {
    return [...this.handlers.keys()] as Array<keyof M & string>;
  }
}
