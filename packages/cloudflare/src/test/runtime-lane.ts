import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  BatchOperation,
  ConditionalBatchCondition,
  ScanOptions,
  Storage,
  StorageCapabilities,
} from '@lostgradient/weft/storage/interface';

import { CloudflareRuntimeLaneCancelledError, CloudflareUnsupportedApiError } from '../diagnostics';
import type { R2Bucket, R2ListOptions, R2ListResult } from '../r2';

/**
 * Injects the identifier this lane derives its Durable Object namespace and
 * temporary storage directory name from. Kept as a tiny structural interface
 * (rather than importing AB-92's not-yet-built `RuntimeServices.identifiers`)
 * so this test-only module has no dependency on unshipped code; any object
 * shaped like `{ next(): string }` — including a `RuntimeServices.identifiers`
 * facade once one exists — satisfies it.
 */
export interface CloudflareRuntimeLaneIdentifierSource {
  next(): string;
}

/** Options for {@link startCloudflareRuntime}. */
export interface StartCloudflareRuntimeOptions {
  /** Supplies the namespace/storage-directory identifier for this lane. */
  identifiers: CloudflareRuntimeLaneIdentifierSource;
  /**
   * Overrides the `packages/cloudflare` root `buildDurableObjectWorkerScript`
   * bundles `create-cloudflare-sqlite-storage.ts` from. Defaults to this
   * module's real package root; the only legitimate reason to override it is
   * to test the startup-failure cleanup path (`runtime-only.test.ts`) with a
   * root that cannot resolve the adapter, since a genuine bundling failure
   * isn't otherwise reproducible on demand.
   */
  packageRoot?: string;
}

/**
 * A booted real-runtime lane. `sqliteStorage` and `r2Bucket` are wired to the
 * production adapter contracts (`createCloudflareSqliteStorage`,
 * `createCloudflareR2TextValueStore`) so a caller can pass them to those
 * constructors unmodified. `vectorizeRemoteOnlyError` is the captured
 * `env.INDEX.query(...)` failure — Vectorize is asserted unsupported on this
 * lane per the AB-276 coordinator ruling (owningIssue `AB-276`, reason
 * `vectorize-remote-only`) rather than emulated.
 */
export interface CloudflareRuntimeLane {
  /** A Weft `Storage` proxy backed by real Durable Object SQLite. */
  readonly sqliteStorage: Storage;
  /** The real Miniflare-backed R2 bucket binding. */
  readonly r2Bucket: R2Bucket;
  /**
   * The typed diagnostic `env.INDEX.query(...)` produces on this lane. Per
   * the AB-276 coordinator ruling, Miniflare classifies `vectorize` as
   * remote-only with no local emulator; `.message` carries the raw probe
   * text, `.cause` (when present) the original probe error.
   */
  readonly vectorizeUnsupported: CloudflareUnsupportedApiError;
  /** The temporary directory this lane's Durable Object and R2 state live in. */
  readonly persistDirectory: string;
  /**
   * A `Storage` view over a Durable Object namespace under this lane. With no
   * argument, allocates a NEW namespace via `identifiers.next()` — for a
   * contract runner that needs a clean slate per case without paying to boot
   * a whole new lane. Passing an explicit `namespaceSuffix` instead returns a
   * SECOND, independent view over the SAME namespace as a prior call with
   * that same suffix — the "reopen after close/dispose" proof, since a real
   * Durable Object namespace has no notion of an owning view either.
   * Independent of {@link sqliteStorage}, which stays fixed to this lane's
   * original namespace.
   */
  createFreshSqliteStorage(namespaceSuffix?: string): Storage;
  /**
   * An `R2Bucket` view namespaced by a key prefix under this lane's one
   * underlying R2 bucket. With no argument, allocates a NEW prefix via
   * `identifiers.next()`. Passing an explicit `prefix` instead returns a
   * SECOND, independent view over the SAME prefix — the "reopen" proof, same
   * reasoning as {@link createFreshSqliteStorage}. Independent of
   * {@link r2Bucket}, which stays unprefixed.
   */
  createFreshR2Bucket(prefix?: string): R2Bucket;
  /**
   * Aborts every in-flight and future call through this lane's
   * `sqliteStorage`/`r2Bucket` (and any view from {@link createFreshSqliteStorage}/
   * {@link createFreshR2Bucket}) with a typed {@link CloudflareRuntimeLaneCancelledError}
   * — a cancellation outcome, not Miniflare's own generic "instance disposed"
   * failure. Does not dispose the underlying Miniflare instance or remove
   * {@link persistDirectory}; use {@link stop} or {@link shutdown} for that.
   */
  cancel(): void;
  /**
   * Disposes the underlying Miniflare instance WITHOUT removing
   * {@link persistDirectory} — the durable state a subsequent {@link restart}
   * rehydrates from. Use {@link shutdown} for final teardown that also
   * removes the directory.
   */
  stop(): Promise<void>;
  /**
   * Stops this lane (as {@link stop}) and boots a fresh Miniflare instance
   * over the SAME `persistDirectory` and the SAME Durable Object namespace /
   * R2 bucket name, returning a new lane whose `sqliteStorage`/`r2Bucket`
   * read the first lane's persisted state back. This lane object itself is
   * spent after calling `restart()` — only the returned lane is live.
   */
  restart(): Promise<CloudflareRuntimeLane>;
  /**
   * Disposes the underlying Miniflare instance and removes
   * {@link persistDirectory}. Awaits only the runtime's own readiness/disposal
   * promises — never a timer.
   */
  shutdown(): Promise<void>;
}

/**
 * Races `operation()` against `signal`'s `abort` event, rejecting with a
 * typed {@link CloudflareRuntimeLaneCancelledError} the instant the signal
 * fires — even while `operation()` is still pending — rather than waiting for
 * (or silently swallowing) whatever the underlying call eventually resolves
 * or rejects with. Exported so `runtime-only.test.ts` can exercise the
 * cancellation-while-in-flight path directly against a deterministic,
 * caller-controlled `operation`, without racing real Miniflare I/O (which
 * would be a flake, not a test, on a loaded box).
 */
export async function runCancellableLaneOperation<T>(
  signal: AbortSignal | undefined,
  method: string,
  namespace: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal === undefined) return operation();
  if (signal.aborted) {
    throw new CloudflareRuntimeLaneCancelledError(method, namespace);
  }

  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new CloudflareRuntimeLaneCancelledError(method, namespace));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  // Started unconditionally, and separately observed here: if `cancellation`
  // wins the race below, this promise's eventual settlement is never awaited
  // by the race itself, and an unobserved rejection would otherwise surface
  // as a process-level "unhandled rejection" long after the caller has moved
  // on with the typed cancellation. This handler exists ONLY to mark it
  // observed — the caller never sees its result once cancellation has won.
  const operationPromise = operation();
  operationPromise.catch(() => {
    // Intentionally empty.
  });

  try {
    return await Promise.race([operationPromise, cancellation]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The Durable Object dispatches every {@link Storage} method over `fetch` as
 * `{ method, args }`; bytes cross the wire as plain number arrays since
 * `structuredClone`-over-JSON has no `Uint8Array` support in every runtime
 * this glue script might run under.
 */
type StorageRpcMethod =
  | 'get'
  | 'put'
  | 'delete'
  | 'scan'
  | 'batch'
  | 'conditionalBatch'
  | 'has'
  | 'deletePrefix'
  | 'keys'
  | 'count'
  | 'capabilities';

interface StorageRpcResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * The minimal fetch-dispatcher shape `callStorageRpc` needs: something that
 * takes a URL and a JSON body and resolves to something with `.json()`. Kept
 * intentionally narrower than `miniflare.dispatchFetch`'s own real signature
 * (rather than spelling out `Request`/`Response`/`RequestInit` ourselves)
 * because this package's `tsconfig.json` loads both `bun` and
 * `@cloudflare/workers-types` globals for production code, and those two
 * declare incompatible global `Response`/`RequestInit` shapes — this
 * interface asks only for what it uses, so both `miniflare.dispatchFetch`
 * (real lane) and a plain fake `Response.json(...)` (tests) satisfy it.
 */
export interface StorageRpcTransport {
  (input: string, init?: { method?: string; body?: string }): Promise<{ json(): Promise<unknown> }>;
}

/** The dynamically-imported `miniflare` module's own type, used only for `Miniflare`'s instance type. */
type MiniflareModule = typeof import('miniflare');

/**
 * Builds the Durable Object worker script that runs `createCloudflareSqliteStorage`
 * INSIDE workerd. This is required, not a convenience: Durable Object
 * `SqlStorage.exec` (the production `Sql` binding) is synchronous and only
 * exists inside the Durable Object, so a Bun-side proxy cannot call it
 * directly — the adapter itself must execute where `ctx.storage.sql` lives,
 * with only the already-async `Storage` surface it produces crossing back to
 * Bun over `fetch`.
 */
function buildDurableObjectGlueSource(sqliteAdapterEntryPath: string): string {
  return `
import { createCloudflareSqliteStorage } from ${JSON.stringify(sqliteAdapterEntryPath)};

export class RuntimeLaneStore {
  constructor(ctx) {
    this.storage = createCloudflareSqliteStorage({ sql: ctx.storage.sql });
  }

  async fetch(request) {
    const { method, args } = await request.json();
    try {
      const result = await dispatch(this.storage, method, args ?? []);
      return Response.json({ ok: true, result });
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function toBytes(numbers) {
  return Uint8Array.from(numbers);
}

function toNumbers(bytes) {
  return Array.from(bytes);
}

function decodeOperation(operation) {
  return operation.type === 'put'
    ? { type: 'put', key: operation.key, value: toBytes(operation.value) }
    : { type: 'delete', key: operation.key };
}

function decodeCondition(condition) {
  return {
    key: condition.key,
    expectedValue: condition.expectedValue === null ? null : toBytes(condition.expectedValue),
  };
}

async function dispatch(storage, method, args) {
  switch (method) {
    case 'get': {
      const value = await storage.get(args[0]);
      return value === null ? null : toNumbers(value);
    }
    case 'put':
      await storage.put(args[0], toBytes(args[1]));
      return null;
    case 'delete':
      await storage.delete(args[0]);
      return null;
    case 'scan': {
      const rows = [];
      for await (const [key, value] of storage.scan(args[0], args[1] ?? undefined)) {
        rows.push([key, toNumbers(value)]);
      }
      return rows;
    }
    case 'batch':
      await storage.batch(args[0].map(decodeOperation));
      return null;
    case 'conditionalBatch':
      return storage.conditionalBatch(args[0].map(decodeCondition), args[1].map(decodeOperation));
    case 'has':
      return storage.has(args[0]);
    case 'deletePrefix':
      return storage.deletePrefix(args[0]);
    case 'keys': {
      const keys = [];
      for await (const key of storage.keys(args[0], args[1] ?? undefined)) keys.push(key);
      return keys;
    }
    case 'count':
      return storage.count(args[0]);
    case 'capabilities':
      return storage.capabilities();
    default:
      throw new Error('RuntimeLaneStore: unknown method ' + method);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/vectorize-probe') {
      try {
        await env.INDEX.query([0], { topK: 1, filter: {}, returnMetadata: true });
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const id = env.STORE.idFromName(url.searchParams.get('ns') ?? 'default');
    const stub = env.STORE.get(id);
    return stub.fetch(request);
  },
};
`;
}

/**
 * Bundles the Durable Object glue script (and the real adapter it imports) for workerd.
 *
 * The temporary entry file's name must be collision-safe across CONCURRENT PROCESSES,
 * not just concurrent calls within one process — this box runs concurrent agent
 * validation, and a caller's `options.identifiers.next()` is not guaranteed to be
 * process-unique (e.g. `test/cloudflare-backend-contract.test.ts`'s plain per-process
 * counter), so reusing an injected identifier here would let two processes' builds
 * write, read, and then race-delete the very same file. `crypto.randomUUID()` is used
 * directly and is listed in `scripts/determinism-manifest.json`'s `realRuntimeExemptions`
 * (owningIssue `AB-286`) rather than injected: this module ships as part of `src/` (its
 * `tsconfig.build.json` `rootDir` is `./src`), so it cannot import a default from outside
 * `src/test/` the way `runtime-only.test.ts` does (excluded from the build as `*.test.ts`),
 * and no caller can supply a process-unique value without becoming process-unique itself.
 */
async function buildDurableObjectWorkerScript(packageRoot: string): Promise<string> {
  // A relative specifier, not an absolute path: `packageRoot/node_modules`
  // is not guaranteed to exist (a workspace-linked package root need not
  // have its own), and an absolute path baked into the glue source is not
  // portable across platforms (Windows drive letters). The glue file lives
  // directly under `packageRoot` (which always exists), so a plain relative
  // import resolves the same way Bun would resolve it from any other file
  // in the package.
  const glueSource = buildDurableObjectGlueSource('./src/create-cloudflare-sqlite-storage.ts');

  // The entry file needs a real path so Bun.build can resolve the relative
  // import above; it never becomes part of `src/` and is removed immediately
  // after bundling, so it carries no coverage obligation of its own.
  const glueTempPath = path.join(packageRoot, `.runtime-lane-glue-${crypto.randomUUID()}.ts`);
  await Bun.write(glueTempPath, glueSource);
  try {
    const build = await Bun.build({
      entrypoints: [glueTempPath],
      target: 'browser',
      format: 'esm',
    });
    // `build.success` guarantees `outputs[0]` for a single-entrypoint build
    // per Bun's own contract; the non-null assertion documents that rather
    // than adding an `if (output === undefined)` branch no test can reach
    // (the glue source above is fully controlled by this function).
    return build.outputs[0]!.text();
  } finally {
    await rm(glueTempPath, { force: true });
  }
}

async function callStorageRpc(
  dispatchFetch: StorageRpcTransport,
  namespace: string,
  method: StorageRpcMethod,
  args: unknown[],
): Promise<unknown> {
  const response = await dispatchFetch(
    `http://cloudflare-runtime-lane/?ns=${encodeURIComponent(namespace)}`,
    {
      method: 'POST',
      body: JSON.stringify({ method, args }),
    },
  );
  const body = (await response.json()) as StorageRpcResponse;
  if (!body.ok) {
    throw new Error(
      body.error ?? `Cloudflare runtime lane storage RPC "${method}" failed with no message.`,
    );
  }
  return body.result;
}

/**
 * Builds the `Storage` proxy `startCloudflareRuntime` hands back as
 * `sqliteStorage`, over an injected `dispatchFetch`. Exported (rather than
 * kept module-private) so `runtime-only.test.ts` can exercise the RPC
 * failure path directly with a fake transport — a real bundled-worker
 * failure is not something a legitimate call through the public `Storage`
 * surface can trigger, the same "genuinely unobservable any other way"
 * bar every other runtime-only assertion has to clear.
 */
export function createSqliteStorageProxy(
  dispatchFetch: StorageRpcTransport,
  namespace: string,
  signal?: AbortSignal,
): Storage {
  // Wraps `callStorageRpc` with cancellation, tagging the typed cancellation
  // error with the ACTUAL RPC method being cancelled (`get`, `put`, `scan`,
  // ...) rather than a single constant label — a caller reading
  // `CloudflareRuntimeLaneCancelledError.method` can otherwise never tell
  // which operation was in flight.
  function call(method: StorageRpcMethod, args: unknown[]): Promise<unknown> {
    return runCancellableLaneOperation(signal, method, namespace, () =>
      callStorageRpc(dispatchFetch, namespace, method, args),
    );
  }

  return {
    capabilities(): StorageCapabilities {
      // Mirrors `createCloudflareSqliteStorage`'s own declared capabilities;
      // this proxy never calls the RPC synchronously, so it cannot ask the
      // worker for this value the way every other method does.
      return {
        persistence: 'local',
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        atomicBatch: true,
        conditionalBatch: true,
        boundedRangeDelete: true,
      };
    },

    async get(key: string): Promise<Uint8Array | null> {
      const result = await call('get', [key]);
      return result === null ? null : Uint8Array.from(result as number[]);
    },

    async put(key: string, value: Uint8Array): Promise<void> {
      await call('put', [key, Array.from(value)]);
    },

    async delete(key: string): Promise<void> {
      await call('delete', [key]);
    },

    async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
      const rows = (await call('scan', [prefix, options])) as [string, number[]][];
      for (const [key, bytes] of rows) yield [key, Uint8Array.from(bytes)];
    },

    async batch(operations: BatchOperation[]): Promise<void> {
      const encoded = operations.map((operation) =>
        operation.type === 'put'
          ? { type: 'put', key: operation.key, value: Array.from(operation.value) }
          : { type: 'delete', key: operation.key },
      );
      await call('batch', [encoded]);
    },

    async conditionalBatch(
      conditions: ConditionalBatchCondition[],
      operations: BatchOperation[],
    ): Promise<boolean> {
      const encodedConditions = conditions.map((condition) => ({
        key: condition.key,
        expectedValue:
          condition.expectedValue === null ? null : Array.from(condition.expectedValue),
      }));
      const encodedOperations = operations.map((operation) =>
        operation.type === 'put'
          ? { type: 'put', key: operation.key, value: Array.from(operation.value) }
          : { type: 'delete', key: operation.key },
      );
      return (await call('conditionalBatch', [encodedConditions, encodedOperations])) as boolean;
    },

    async count(prefix: string): Promise<number> {
      return (await call('count', [prefix])) as number;
    },

    async has(key: string): Promise<boolean> {
      return (await call('has', [key])) as boolean;
    },

    async deletePrefix(prefix: string): Promise<number> {
      return (await call('deletePrefix', [prefix])) as number;
    },

    async *keys(prefix: string, options?: ScanOptions): AsyncIterable<string> {
      const result = (await call('keys', [prefix, options])) as string[];
      for (const key of result) yield key;
    },

    [Symbol.dispose](): void {
      // No-op: this proxy does not own the lane's Miniflare instance;
      // `CloudflareRuntimeLane.shutdown()` disposes it.
    },
  };
}

/**
 * Interprets the `/vectorize-probe` worker route's response as a typed
 * {@link CloudflareUnsupportedApiError}. Extracted from {@link bootLaneCore} and
 * exported so `runtime-only.test.ts` can exercise both outcomes directly
 * against a synthetic {@link StorageRpcResponse} — the "probe unexpectedly
 * succeeds" branch is not reproducible on demand against a real Miniflare
 * instance (per the AB-276 coordinator ruling, it never does), so there is no
 * organic way to drive it through `startCloudflareRuntime` itself.
 */
export function interpretVectorizeProbe(
  probeBody: StorageRpcResponse,
): CloudflareUnsupportedApiError {
  if (probeBody.ok) {
    // The AB-276 coordinator ruling this lane relies on is that Miniflare
    // classifies `vectorize` as remote-only with no local emulator. A probe
    // that unexpectedly succeeds means that assumption no longer holds — a
    // real finding, not something to paper over as a typed "unsupported"
    // diagnostic (which would be actively misleading: the call worked).
    throw new Error(
      'Miniflare Vectorize binding unexpectedly succeeded without a remote proxy; ' +
        'the AB-276 vectorize-remote-only assumption this lane relies on no longer holds.',
    );
  }
  return new CloudflareUnsupportedApiError({
    api: 'vectorize.query',
    reason: 'vectorize-remote-only',
    owningIssue: 'AB-276',
    cause: new Error(probeBody.error ?? 'Miniflare Vectorize probe failed with no message.'),
  });
}

/** A booted Miniflare instance plus everything derived from it that a lane needs. */
interface BootedLaneCore {
  readonly miniflare: InstanceType<MiniflareModule['Miniflare']>;
  readonly namespace: string;
  readonly dispatchFetch: StorageRpcTransport;
  readonly rawR2Bucket: R2Bucket;
  readonly vectorizeUnsupported: CloudflareUnsupportedApiError;
}

/**
 * Boots one Miniflare instance over `persistDirectory` for the Durable Object
 * namespace and R2/Vectorize binding names derived from `identifier`.
 * Extracted from {@link startCloudflareRuntime} so {@link CloudflareRuntimeLane.restart}
 * can boot a second instance over the SAME `persistDirectory`/`identifier`
 * without duplicating the boot sequence.
 *
 * `onMiniflareConstructed` fires the moment `new Miniflare(...)` succeeds —
 * BEFORE `await miniflare.ready`, the Vectorize probe, or `getR2Bucket()`,
 * every one of which can still reject. Without this hook a caller only
 * learns about the instance from this function's RETURN value, so a failure
 * after construction but before return would leave a live, undisposed
 * Miniflare/workerd process with nothing left pointing at it. Callers use it
 * to track the instance for their own cleanup path regardless of how far
 * booting gets.
 */
async function bootLaneCore(
  packageRoot: string,
  identifier: string,
  persistDirectory: string,
  onMiniflareConstructed: (instance: InstanceType<MiniflareModule['Miniflare']>) => void,
): Promise<BootedLaneCore> {
  const { Miniflare } = await import('miniflare');

  const namespace = `lane-${identifier}`;
  const script = await buildDurableObjectWorkerScript(packageRoot);

  const miniflare = new Miniflare({
    modules: [{ type: 'ESModule', path: 'runtime-lane-worker.mjs', contents: script }],
    compatibilityDate: '2026-07-30',
    durableObjects: { STORE: { className: 'RuntimeLaneStore', useSQLite: true } },
    durableObjectsPersist: path.join(persistDirectory, 'durable-objects'),
    r2Buckets: { BUCKET: `cloudflare-runtime-lane-${identifier}` },
    r2Persist: path.join(persistDirectory, 'r2'),
    vectorize: { INDEX: { index_name: `cloudflare-runtime-lane-${identifier}` } },
  });
  onMiniflareConstructed(miniflare);

  await miniflare.ready;

  const dispatchFetch: StorageRpcTransport = miniflare.dispatchFetch.bind(miniflare);

  const probeResponse = await dispatchFetch('http://cloudflare-runtime-lane/vectorize-probe');
  const probeBody = (await probeResponse.json()) as StorageRpcResponse;
  const vectorizeUnsupported = interpretVectorizeProbe(probeBody);

  const rawR2Bucket: R2Bucket = await miniflare.getR2Bucket('BUCKET');

  return { miniflare, namespace, dispatchFetch, rawR2Bucket, vectorizeUnsupported };
}

/**
 * Assembles the public {@link CloudflareRuntimeLane} from a booted core plus
 * the identifier/persistDirectory it was booted with, so both
 * {@link startCloudflareRuntime} and a post-{@link CloudflareRuntimeLane.restart}
 * boot produce an identically-shaped lane. Each lane gets its own
 * `AbortController`: {@link CloudflareRuntimeLane.cancel} aborts only THIS
 * lane's in-flight/future calls, never a sibling lane's.
 */
function assembleLane(
  core: BootedLaneCore,
  options: StartCloudflareRuntimeOptions,
  packageRoot: string,
  identifier: string,
  persistDirectory: string,
): CloudflareRuntimeLane {
  const { miniflare, namespace, dispatchFetch, rawR2Bucket, vectorizeUnsupported } = core;
  const controller = new AbortController();
  const r2Bucket = withCancellableR2Bucket(rawR2Bucket, controller.signal);

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    controller.abort();
    await miniflare.dispose();
    // Marked stopped only AFTER disposal succeeds: if `dispose()` rejects,
    // `stopped` stays `false` so a later `stop()`/`shutdown()` call retries
    // disposal instead of silently treating the still-live instance as gone.
    stopped = true;
  }

  return {
    sqliteStorage: createSqliteStorageProxy(dispatchFetch, namespace, controller.signal),
    r2Bucket,
    vectorizeUnsupported,
    persistDirectory,
    createFreshSqliteStorage(namespaceSuffix?: string): Storage {
      return createSqliteStorageProxy(
        dispatchFetch,
        `${namespace}-${namespaceSuffix ?? options.identifiers.next()}`,
        controller.signal,
      );
    },
    createFreshR2Bucket(prefix?: string): R2Bucket {
      return createPrefixedR2Bucket(r2Bucket, `${prefix ?? options.identifiers.next()}/`);
    },
    cancel(): void {
      controller.abort();
    },
    stop,
    async restart(): Promise<CloudflareRuntimeLane> {
      await stop();
      // Tracks the restarted Miniflare instance from the moment
      // `bootLaneCore` constructs it (not just on full success), so a
      // failure partway through boot (readiness, the Vectorize probe,
      // `getR2Bucket`) still disposes the live instance instead of leaking
      // it — `persistDirectory` is deliberately NOT removed on this path,
      // since it is the durable state this restart exists to rehydrate.
      let restartedMiniflare: InstanceType<MiniflareModule['Miniflare']> | undefined;
      try {
        const restartedCore = await bootLaneCore(
          packageRoot,
          identifier,
          persistDirectory,
          (instance) => {
            restartedMiniflare = instance;
          },
        );
        return assembleLane(restartedCore, options, packageRoot, identifier, persistDirectory);
      } catch (error) {
        await disposeAfterRestartFailure(restartedMiniflare);
        throw error;
      }
    },
    // Reuses `cleanUpAfterStartupFailure`'s dispose-then-remove ordering:
    // `rm` must run even when `dispose()` rejects (workerd failing to
    // terminate cleanly must not leak `persistDirectory`, and must not
    // stop an `afterEach` loop from processing remaining lanes) — exactly
    // the same requirement a startup failure has, just with an
    // unconditionally-defined instance.
    async shutdown(): Promise<void> {
      controller.abort();
      await cleanUpAfterStartupFailure(stopped ? undefined : miniflare, persistDirectory);
      stopped = true;
    },
  };
}

/** Wraps a real `R2Bucket` binding so every call rejects with a typed cancellation once `signal` fires. */
export function withCancellableR2Bucket(bucket: R2Bucket, signal: AbortSignal): R2Bucket {
  return {
    head: (key: string) =>
      runCancellableLaneOperation(signal, 'r2.head', key, () => bucket.head(key)),
    get: (key: string) => runCancellableLaneOperation(signal, 'r2.get', key, () => bucket.get(key)),
    put: (key: string, value: string) =>
      runCancellableLaneOperation(signal, 'r2.put', key, () => bucket.put(key, value)),
    delete: (key: string) =>
      runCancellableLaneOperation(signal, 'r2.delete', key, () => bucket.delete(key)),
    list: (options?: R2ListOptions) =>
      runCancellableLaneOperation(signal, 'r2.list', options?.prefix ?? '', () =>
        bucket.list(options),
      ),
  };
}

/**
 * Boots a pinned local Miniflare runtime with a Durable Object SQLite
 * binding, an R2 binding, and a Vectorize binding, and returns a lane whose
 * `sqliteStorage`/`r2Bucket` satisfy the same production adapter contracts as
 * the fast Bun doubles. Vectorize is asserted unsupported on this lane (see
 * {@link CloudflareRuntimeLane.vectorizeUnsupported}) rather than wired up,
 * per the AB-276 coordinator ruling: Miniflare 4.20260730.0 classifies
 * `vectorize` as remote-only with no `remoteProxyConnectionString`, and this
 * lane never supplies one.
 *
 * Readiness is `await miniflare.ready`, never a delay. Each call derives a
 * fresh namespace and a fresh temporary directory from `options.identifiers`,
 * so concurrent or sequential lanes never share Durable Object or R2 state.
 */
export async function startCloudflareRuntime(
  options: StartCloudflareRuntimeOptions,
): Promise<CloudflareRuntimeLane> {
  const packageRoot = options.packageRoot ?? path.resolve(import.meta.dir, '..', '..');
  const identifier = options.identifiers.next();
  const persistDirectory = await mkdtemp(
    path.join(tmpdir(), `cloudflare-runtime-lane-${identifier}-`),
  );

  // Everything from here on can fail (bundling, `ready`, the Vectorize
  // probe, `getR2Bucket`). If it does, no lane is ever returned to the
  // caller, so nothing could call `shutdown()` — clean up here instead of
  // leaking `persistDirectory` or a live Miniflare/workerd instance.
  let miniflare: InstanceType<MiniflareModule['Miniflare']> | undefined;
  try {
    const core = await bootLaneCore(packageRoot, identifier, persistDirectory, (instance) => {
      miniflare = instance;
    });
    return assembleLane(core, options, packageRoot, identifier, persistDirectory);
  } catch (error) {
    try {
      await cleanUpAfterStartupFailure(miniflare, persistDirectory);
    } catch {
      // A cleanup failure (e.g. `dispose()` also rejecting) must not replace
      // the original startup error — cleanup is best-effort here.
    }
    throw error;
  }
}

/**
 * Cleans up after `startCloudflareRuntime` fails partway through: disposes
 * `miniflareInstance` when construction got far enough to produce one, then
 * always removes `persistDirectory`. Extracted so the "was a Miniflare
 * instance actually constructed before the failure" branch is directly
 * testable without needing to force a failure at each specific point inside
 * `startCloudflareRuntime` that could produce one.
 */
export async function cleanUpAfterStartupFailure(
  miniflareInstance: { dispose(): Promise<void> } | undefined,
  persistDirectory: string,
): Promise<void> {
  // `rm` runs even when `dispose()` itself rejects (a partially started
  // runtime can fail to shut down cleanly) — the directory removal must not
  // be skipped just because disposal was unclean.
  try {
    if (miniflareInstance !== undefined) await miniflareInstance.dispose();
  } finally {
    await rm(persistDirectory, { recursive: true, force: true });
  }
}

/**
 * Best-effort disposal of a Miniflare instance a failed {@link CloudflareRuntimeLane.restart}
 * managed to construct before boot failed. UNLIKE {@link cleanUpAfterStartupFailure},
 * this never removes `persistDirectory` — a restart failure must not destroy
 * the durable state the restart was trying to rehydrate from. Exported (same
 * reasoning as `cleanUpAfterStartupFailure`) so `runtime-only.test.ts` can
 * exercise this "an instance WAS constructed before boot failed" branch
 * directly with a disposable stub — a genuine late-stage restart-boot failure
 * (readiness/probe/`getR2Bucket` rejecting) is not reproducible on demand
 * against a real Miniflare instance.
 */
export async function disposeAfterRestartFailure(
  miniflareInstance: { dispose(): Promise<void> } | undefined,
): Promise<void> {
  if (miniflareInstance === undefined) return;
  try {
    await miniflareInstance.dispose();
  } catch {
    // Best-effort: must not replace the original boot error the caller
    // is already propagating.
  }
}

/**
 * Wraps a shared R2 bucket binding so every key is transparently namespaced
 * under `prefix`. Miniflare's R2 buckets are fixed at construction (one
 * `BUCKET` binding per lane), so per-contract-case isolation for R2 — unlike
 * the Durable Object SQLite proxy, which gets a genuinely fresh namespace per
 * case — is a key prefix rather than a fresh underlying bucket.
 */
function createPrefixedR2Bucket(bucket: R2Bucket, prefix: string): R2Bucket {
  return {
    head: (key: string) => bucket.head(`${prefix}${key}`),
    get: (key: string) => bucket.get(`${prefix}${key}`),
    put: (key: string, value: string) => bucket.put(`${prefix}${key}`, value),
    delete: (key: string) => bucket.delete(`${prefix}${key}`),
    async list(listOptions?: R2ListOptions): Promise<R2ListResult> {
      const result = await bucket.list({
        ...listOptions,
        prefix: `${prefix}${listOptions?.prefix ?? ''}`,
      });
      return {
        ...result,
        objects: result.objects.map((object) => ({
          ...object,
          key: object.key.slice(prefix.length),
        })),
      };
    },
  };
}
