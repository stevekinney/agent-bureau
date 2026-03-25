export type HookMap = Record<string, (...args: never[]) => unknown>;

export type HookErrorHandler = (
  error: unknown,
  context: { hookName: string; handlerIndex: number },
) => 'continue' | 'abort';

export interface HookRegistrationOptions {
  priority?: number;
  onError?: HookErrorHandler;
}

export interface HookRegistryOptions {
  onError?: HookErrorHandler;
}
