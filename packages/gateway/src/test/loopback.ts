/**
 * The loopback Gateway conformance harness (AB-98's tst-07a / AB-272).
 *
 * `startLoopbackGateway` composes a real `Bureau` through
 * `createBureauTestHarness` (AB-261) over an injected `ManualRuntimeServices`
 * and an owned storage fixture, constructs a real `Gateway`, and binds a
 * real `Bun.serve` (or, when `serverRuntime: 'node'`, a real
 * `node:http.Server`) listener on an operating-system-assigned ephemeral
 * port. Every client method returned — `fetch`, `openEventStream`,
 * `openWebSocket` — is a REAL client against that real socket: no test in
 * `packages/gateway/src/conformance/` assigns to `globalThis.fetch`,
 * `globalThis.WebSocket`, or `globalThis.EventSource` (a grep asserting
 * that lives in `packages/gateway/src/conformance/transport.test.ts`).
 *
 * This is the real-runtime conformance tier (AB-92's test-tier matrix): it
 * proves the public contract holds over a real transport, never general
 * lifecycle correctness (that is the in-process composition tier, AB-94).
 *
 * Authentication is header/query-token only — this harness never drives a
 * cookie flow, since the gateway UI (AB-273's scope) has none.
 */
import type { Bureau, BureauShutdownReport } from 'bureau';
import type {
  BureauStorageFixture,
  BureauTestHarness,
  BureauTestHarnessOptions,
} from 'bureau/test';
import { createBureauTestHarness, createMemoryStorageFixture } from 'bureau/test';
import type { ManualRuntimeServices } from 'lifecycle';

import { createBunAdapter } from '../adapters/bun-adapter';
import { createNodeAdapter } from '../adapters/node-adapter';
import { createGateway } from '../create-gateway';
import type {
  A2AAgentCardOptions,
  ClientFrame,
  GatewayShutdownOptions,
  GatewayShutdownReport,
  ServerFrame,
} from '../types';

/**
 * Which server runtime backs this loopback gateway. Named `serverRuntime`
 * — not `runtime`, which this options bag already uses for the harness's
 * `ManualRuntimeServices` (AB-261) — because `GatewayOptions` itself now
 * has both names (AB-303): `serverRuntime?: 'bun' | 'node'` selects the
 * HTTP/WS adapter, and `runtime?: RuntimeServices` is the clock/timer/
 * identifier seam. This harness forwards its own `ManualRuntimeServices`
 * (`harness.runtime`) as `createGateway`'s `runtime` option, so the
 * gateway's connection watchdogs, request identifiers, and every other
 * server-side timer/identifier read share the same manual clock as the
 * Bureau underneath it.
 *
 * `'bun'` exercises the real Bun adapter (HTTP, SSE, and WebSocket).
 * `'node'` exercises the real Node adapter over a real `node:http.Server`
 * — HTTP and SSE only; WebSocket is unsupported on this runtime and
 * {@link LoopbackGateway.openWebSocket} rejects synchronously rather than
 * silently hanging.
 */
export type LoopbackServerRuntime = 'bun' | 'node';

export interface LoopbackGatewayOptions extends Omit<BureauTestHarnessOptions, 'storage'> {
  /** Defaults to a fresh, owned {@link createMemoryStorageFixture}. */
  storage?: BureauStorageFixture;
  /**
   * Static bearer token for header/query-token authentication. Defaults to
   * a fixed test token — this harness never drives a cookie flow.
   */
  authToken?: string;
  allowedOrigins?: string[];
  /** Defaults to `'bun'`. See {@link LoopbackServerRuntime}. */
  serverRuntime?: LoopbackServerRuntime;
  shutdown?: GatewayShutdownOptions;
  a2a?: A2AAgentCardOptions;
  evaluationReportsDirectory?: string;
}

/** A single parsed SSE `data:` frame read from a real response-body socket. */
export interface ServerEventStreamReader {
  /**
   * Awaits the next parsed `ServerFrame` from the stream, ignoring `:
   * heartbeat` comment lines. Resolves `undefined` if the stream ends
   * before another frame arrives. Never a delay — bounded only by
   * `signal`, when provided.
   */
  next(signal?: AbortSignal): Promise<ServerFrame | undefined>;
  /** Aborts the underlying fetch and releases the reader. */
  close(): Promise<void>;
}

/** A real WebSocket client against a loopback gateway's `/ws` endpoint. */
export interface LoopbackWebSocketClient {
  /** Sends a typed client frame, JSON-encoded, over the real socket. */
  send(frame: ClientFrame): void;
  /**
   * Awaits the next parsed `ServerFrame`. Never a delay — bounded only by
   * `signal`, when provided.
   */
  next(signal?: AbortSignal): Promise<ServerFrame>;
  /** The real `WebSocket.readyState`. */
  readonly readyState: number;
  /** Closes the socket. */
  close(): void;
  /** Awaits the socket's own `close` event. */
  waitForClose(signal?: AbortSignal): Promise<{ code: number; reason: string }>;
}

export interface LoopbackGateway {
  readonly url: string;
  readonly bureau: Bureau;
  readonly runtime: ManualRuntimeServices;
  /** The underlying `Bureau` test harness (AB-261) this gateway was built over. */
  readonly harness: BureauTestHarness;
  /** The static bearer token configured for this gateway. */
  readonly authToken: string;
  /** A real `fetch` against `${url}${path}`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Opens a real SSE connection (`fetch` + a streamed response body) against `${url}${path}`. */
  openEventStream(path: string, init?: { headers?: HeadersInit }): Promise<ServerEventStreamReader>;
  /**
   * Opens a real WebSocket against `${url.replace('http', 'ws')}${path}`.
   * Rejects synchronously (never hangs) when this gateway's
   * `serverRuntime` is `'node'`, which has no WebSocket support — callers
   * check {@link LoopbackGateway.supportsWebSocket} first.
   */
  openWebSocket(path: string): Promise<LoopbackWebSocketClient>;
  /** `false` when `serverRuntime: 'node'` — WebSocket is Bun-only. */
  readonly supportsWebSocket: boolean;
  /**
   * Stops the gateway's real listener, shuts the bureau down, and disposes
   * the storage fixture. Resolves only once every step has settled — never
   * a fire-and-forget teardown. Returns both teardown reports (AB-274):
   * `gateway` is the adapter's own `GatewayShutdownReport` (AB-235's bounded
   * drain/force-close outcome), and `bureau` is `Bureau.shutdown()`'s
   * `BureauShutdownReport` (AB-256's per-owner drain outcome) — so a caller
   * can assert on both AFTER `stop()` has actually resolved, rather than
   * reaching for a second, separately-timed `bureau.shutdown()` call (whose
   * own idempotent second call can return an empty `owners` list once
   * everything already settled on the first).
   */
  stop(): Promise<{ gateway: GatewayShutdownReport; bureau: BureauShutdownReport }>;
}

/** Fixed default so a caller who doesn't care about auth doesn't have to invent one. */
const DEFAULT_AUTH_TOKEN = 'loopback-gateway-test-token';

/**
 * Thrown by {@link LoopbackGateway.openWebSocket} when this gateway's
 * `serverRuntime` is `'node'` (AB-98's own verification step: an
 * unsupported transport is reported through a typed capability outcome,
 * never silently skipped or left to hang). Callers check
 * {@link LoopbackGateway.supportsWebSocket} to avoid it entirely, or catch
 * this specific class rather than a bare `Error` to distinguish "this
 * transport is unsupported here" from an actual connection failure.
 */
export class LoopbackTransportUnsupportedError extends Error {
  readonly transport = 'websocket' as const;
  readonly serverRuntime: LoopbackServerRuntime;

  constructor(serverRuntime: LoopbackServerRuntime) {
    super(
      `startLoopbackGateway: this loopback gateway was started with serverRuntime: "${serverRuntime}", ` +
        'which has no WebSocket support (AB-98). Check LoopbackGateway.supportsWebSocket before calling openWebSocket.',
    );
    this.name = 'LoopbackTransportUnsupportedError';
    this.serverRuntime = serverRuntime;
  }
}

/**
 * A tiny FIFO async queue: `push` never blocks, `next` resolves against a
 * pending push or waits for one — the same "await the next value from the
 * stream reader" shape the charter requires everywhere in this suite,
 * never a timed poll.
 */
class FrameQueue<T> {
  private readonly pending: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: T | undefined) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private endError: unknown;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    this.pending.push(value);
  }

  end(error?: unknown): void {
    this.ended = true;
    this.endError = error;
    const normalizedError =
      error instanceof Error ? error : error ? new Error('stream ended') : undefined;
    for (const waiter of this.waiters.splice(0)) {
      if (normalizedError) waiter.reject(normalizedError);
      else waiter.resolve(undefined);
    }
  }

  next(signal?: AbortSignal): Promise<T | undefined> {
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) {
      return this.endError
        ? Promise.reject(this.endError instanceof Error ? this.endError : new Error('stream ended'))
        : Promise.resolve(undefined);
    }

    return new Promise<T | undefined>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);

      if (!signal) return;
      if (signal.aborted) {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        return;
      }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // A waiter that resolves normally (a real frame arrives, or `end()`
      // settles it) must still remove this listener — otherwise every read
      // on a long-lived socket leaves its `abort` listener attached to the
      // signal for as long as the signal itself lives, accumulating one per
      // read (copilot review, PR #469).
      const detach = (): void => signal.removeEventListener('abort', onAbort);
      waiter.resolve = (value) => {
        detach();
        resolve(value);
      };
      waiter.reject = (error: Error) => {
        detach();
        reject(error);
      };
    });
  }
}

/**
 * Parses a real SSE `Response.body` stream into `ServerFrame`s, ignoring
 * `: heartbeat` comment lines. Mirrors `EventSource`'s own event framing
 * (blank-line-delimited, `data:`-prefixed) without depending on the
 * `EventSource` global — the whole point of this suite is a real client
 * over a real socket that is not a patched process global.
 */
function readEventStream(response: Response): ServerEventStreamReader {
  const body = response.body;
  if (!body) {
    throw new Error('startLoopbackGateway: SSE response carried no readable body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const queue = new FrameQueue<ServerFrame>();
  let buffer = '';
  let closed = false;

  function flushEventBlock(block: string): void {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''));
    if (dataLines.length === 0) return; // comment-only block (e.g. ": heartbeat")
    const payload = dataLines.join('\n');
    queue.push(JSON.parse(payload) as ServerFrame);
  }

  async function pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          flushEventBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      }
      queue.end();
    } catch (error) {
      if (!closed) queue.end(error);
    }
  }

  void pump();

  return {
    next: (signal) => queue.next(signal),
    async close() {
      closed = true;
      try {
        await reader.cancel();
      } catch {
        // Already closed/cancelled — nothing further to release.
      }
    },
  };
}

/** Wraps a real `WebSocket` into the queue-based {@link LoopbackWebSocketClient} contract. */
function wrapWebSocket(socket: WebSocket): LoopbackWebSocketClient {
  const queue = new FrameQueue<ServerFrame>();
  const closeQueue = new FrameQueue<{ code: number; reason: string }>();

  socket.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    queue.push(JSON.parse(raw) as ServerFrame);
  });
  socket.addEventListener('close', (event) => {
    queue.end();
    closeQueue.push({ code: event.code, reason: event.reason });
  });
  socket.addEventListener('error', () => {
    // The 'close' event still follows a WebSocket error in both Bun and
    // browsers, so teardown is handled there; this listener exists only
    // so an unhandled 'error' event does not itself throw.
  });

  return {
    send(frame) {
      socket.send(JSON.stringify(frame));
    },
    next: (signal) => queue.next(signal) as Promise<ServerFrame>,
    get readyState() {
      return socket.readyState;
    },
    close() {
      socket.close();
    },
    waitForClose: (signal) => closeQueue.next(signal) as Promise<{ code: number; reason: string }>,
  };
}

/**
 * Builds the real server adapter for `serverRuntime`. `'node'` goes through
 * {@link createNodeAdapter}'s own default `defaultLoadServe` — the real
 * `@hono/node-server` `serve()`, backed by a real `node:http.Server` — which
 * this package declares an `optionalDependencies` entry for (see
 * `packages/gateway/package.json`) precisely so this real-runtime
 * conformance lane has it available without promoting it to a hard runtime
 * dependency of the gateway itself.
 */
function buildServerAdapter(serverRuntime: LoopbackServerRuntime) {
  if (serverRuntime === 'bun') return createBunAdapter();
  return createNodeAdapter();
}

/**
 * Starts a real loopback Gateway (AB-98/AB-272): a real Bureau over an
 * injected `ManualRuntimeServices`, a real `Gateway`, and a real listener
 * bound to an operating-system-assigned ephemeral port.
 */
export async function startLoopbackGateway(
  options: LoopbackGatewayOptions,
): Promise<LoopbackGateway> {
  const {
    storage = createMemoryStorageFixture(),
    authToken = DEFAULT_AUTH_TOKEN,
    allowedOrigins,
    serverRuntime = 'bun',
    shutdown,
    a2a,
    evaluationReportsDirectory,
    ...harnessOptions
  } = options;

  const harness = await createBureauTestHarness({ ...harnessOptions, storage });

  const adapter = buildServerAdapter(serverRuntime);
  const gateway = await createGateway(
    harness.bureau,
    {
      port: 0,
      hostname: '127.0.0.1',
      authToken,
      allowedOrigins,
      shutdown,
      a2a,
      evaluationReportsDirectory,
      // AB-303: share the Bureau's own manual runtime with the gateway, so
      // the connection watchdogs, request identifiers, and every other
      // server-side timer/identifier read this harness drives advance only
      // when `harness.runtime.advance()` is called — never a real timer.
      runtime: harness.runtime,
    },
    { resolveAdapterFn: async () => adapter },
  );
  const running = await gateway.start();
  const url = `http://127.0.0.1:${running.port}`;
  const wsUrl = `ws://127.0.0.1:${running.port}`;
  const supportsWebSocket = serverRuntime === 'bun';

  function fetchLoopback(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${url}${path}`, init);
  }

  async function openEventStream(
    path: string,
    init?: { headers?: HeadersInit },
  ): Promise<ServerEventStreamReader> {
    // A plain object spread over `init?.headers` silently drops entries
    // when the caller passes a `Headers` instance or a header-tuple array
    // (spreading either yields only its own enumerable own-properties, not
    // its header entries) — which can drop an Authorization header and
    // turn into a confusing 401 rather than the auth failure a caller
    // actually intended to test (copilot review, PR #469). `Headers`
    // itself merges every input shape correctly.
    const headers = new Headers(init?.headers);
    headers.set('accept', 'text/event-stream');
    const response = await fetchLoopback(path, { headers });
    if (!response.ok) {
      throw new Error(
        `startLoopbackGateway: SSE request to "${path}" failed with status ${response.status}`,
      );
    }
    return readEventStream(response);
  }

  async function openWebSocket(path: string): Promise<LoopbackWebSocketClient> {
    if (!supportsWebSocket) {
      throw new LoopbackTransportUnsupportedError(serverRuntime);
    }
    const socket = new WebSocket(`${wsUrl}${path}`);
    await new Promise<void>((resolve, reject) => {
      const connectionFailed = (): void =>
        reject(new Error(`startLoopbackGateway: WebSocket connection to "${path}" failed`));
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', connectionFailed, { once: true });
      // A rejected upgrade (401/403 from the origin check or auth) fires
      // 'close' without ever firing 'error' on Bun's WebSocket — without
      // this, the promise above would hang forever rather than reject
      // (copilot review, PR #469).
      socket.addEventListener('close', connectionFailed, { once: true });
    });
    return wrapWebSocket(socket);
  }

  async function stop(): Promise<{
    gateway: GatewayShutdownReport;
    bureau: BureauShutdownReport;
  }> {
    // `storage.dispose()` must always run, even if `running.stop()` or
    // `bureau.shutdown()` throws — otherwise a failure partway through
    // teardown leaks the storage fixture and can make an unrelated,
    // later test flaky (copilot review, PR #497). `finally` re-throws the
    // original failure unchanged; it only guarantees disposal runs too.
    try {
      const gatewayReport = await running.stop();
      const bureauReport = await harness.bureau.shutdown();
      return { gateway: gatewayReport, bureau: bureauReport };
    } finally {
      await storage.dispose();
    }
  }

  return {
    url,
    bureau: harness.bureau,
    runtime: harness.runtime,
    harness,
    authToken,
    fetch: fetchLoopback,
    openEventStream,
    openWebSocket,
    supportsWebSocket,
    stop,
  };
}

export type { BureauShutdownReport };
