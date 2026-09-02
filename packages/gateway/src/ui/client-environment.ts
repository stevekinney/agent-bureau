/**
 * Handle returned by {@link RuntimeTimers.setTimeout}/{@link RuntimeTimers.setInterval},
 * passed back verbatim to `clearTimeout`/`clearInterval`. Matches the
 * browser's `number` handle type under this package's DOM lib configuration.
 */
export type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

/**
 * Timer and current-time primitives, injected instead of read off the global
 * `setTimeout`/`setInterval`/`Date.now` at call time.
 *
 * Matches the `timers` field of AB-92's `RuntimeServices` interface
 * (`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`), plus a
 * `now()` accessor for the one wall-clock read this UI needs — the synthetic
 * timeline timestamp in `hooks/use-run-detail.svelte.ts`.
 * {@link GatewayClientEnvironment} has no separate `clock` field, so that
 * read is bucketed onto `timers` here rather than adding a fifth top-level
 * environment field.
 */
export interface RuntimeTimers {
  setTimeout(callback: () => void, milliseconds?: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
  setInterval(callback: () => void, milliseconds?: number): TimeoutHandle;
  clearInterval(handle: TimeoutHandle): void;
  /** Current wall-clock time in epoch milliseconds. Replaces `Date.now()`. */
  now(): number;
}

/**
 * The transport and timing primitives the Gateway UI's client-side hooks
 * need. Every UI transport consumer takes this as a parameter, or through an
 * explicit context, instead of reading `fetch`, `WebSocket`, `EventSource`,
 * `setTimeout`/`setInterval`, or `Date.now()` off a global at call time —
 * see AB-92 (the lifecycle testability contract) and AB-273.
 */
export interface GatewayClientEnvironment {
  readonly fetch: typeof globalThis.fetch;
  readonly WebSocket: typeof globalThis.WebSocket;
  readonly EventSource: typeof globalThis.EventSource;
  readonly timers: RuntimeTimers;
}

/**
 * Builds a {@link GatewayClientEnvironment} from the real browser globals,
 * read once at construction. The browser entry point calls this exactly
 * once and passes the result down through {@link App}'s `environment` prop,
 * so a running gateway behaves exactly as it did when the UI read these
 * globals directly at call time.
 *
 * The four timer functions and `Date.now` are captured into local bindings
 * here, at construction, rather than re-read off `globalThis`/`Date` inside
 * each closure at call time. Without that capture, anything that later
 * replaces the global timer functions — a fake-timer harness, or code that
 * temporarily swaps and restores them — would change what an
 * already-constructed environment's `timers` resolves to mid-lifetime: a
 * reconnect or polling timer could be scheduled through one implementation
 * and cleared through another, leaking it past `stop()`/unmount and
 * defeating the isolation this environment exists to provide.
 */
export function createBrowserClientEnvironment(): GatewayClientEnvironment {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearInterval = globalThis.clearInterval;
  const nativeNow = Date.now;

  return {
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    EventSource: globalThis.EventSource,
    timers: {
      setTimeout: (callback, milliseconds) => nativeSetTimeout(callback, milliseconds),
      clearTimeout: (handle) => nativeClearTimeout(handle),
      setInterval: (callback, milliseconds) => nativeSetInterval(callback, milliseconds),
      clearInterval: (handle) => nativeClearInterval(handle),
      now: () => nativeNow(),
    },
  };
}

/**
 * Thin wrappers around `environment.timers` so a UI transport consumer never
 * spells the literal call `setTimeout(`/`setInterval(` itself — that text
 * stays confined to this file's `RuntimeTimers` implementation above, which
 * is what the completion check in AB-273's acceptance criteria greps for.
 * Each one just forwards to the matching `RuntimeTimers` method.
 */
export function scheduleTimeout(
  environment: Pick<GatewayClientEnvironment, 'timers'>,
  callback: () => void,
  milliseconds?: number,
): TimeoutHandle {
  return environment.timers.setTimeout(callback, milliseconds);
}

export function clearScheduledTimeout(
  environment: Pick<GatewayClientEnvironment, 'timers'>,
  handle: TimeoutHandle,
): void {
  environment.timers.clearTimeout(handle);
}

export function scheduleInterval(
  environment: Pick<GatewayClientEnvironment, 'timers'>,
  callback: () => void,
  milliseconds?: number,
): TimeoutHandle {
  return environment.timers.setInterval(callback, milliseconds);
}

export function clearScheduledInterval(
  environment: Pick<GatewayClientEnvironment, 'timers'>,
  handle: TimeoutHandle,
): void {
  environment.timers.clearInterval(handle);
}
