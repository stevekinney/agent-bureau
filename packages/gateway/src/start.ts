import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createBureau } from 'bureau';
import { z } from 'zod';

import { createGateway } from './create-gateway';
import type { BureauOptions, GatewayOptions, GatewayShutdownReport } from './types';

/**
 * Process entrypoint for running the gateway as a standalone service (the
 * Dockerfile `CMD`, `bun run start`). `src/index.ts` is a library barrel —
 * importing it starts nothing. This file is the opposite: it reads
 * configuration from the environment, boots one bureau + gateway, and
 * listens until it receives a shutdown signal.
 *
 * `bun run start` runs the BUILT `dist/start.js`, not this source file
 * directly — `bun run dev` runs source (`bun --watch run src/start.ts`) for
 * a fast iteration loop. This matters beyond "build before you ship": this
 * package's build is part of this entrypoint's own dependency chain.
 * `server/render.ts` only serves the content-hashed client bundle
 * (`dist/public/entry-<hash>.js`) when it detects it is executing from
 * `dist/`; run from `src/` it degrades to an unhashed `/public/entry.js`
 * URL that the build never produces, and the browser UI fails to
 * hydrate. `scripts/build.ts` builds this file as one of its entrypoints
 * for exactly this reason — see its `external` list comment for why
 * `bureau` (but not `@lostgradient/weft`) needs to be listed there.
 *
 * See `documentation/deployment.md` for the full environment contract.
 */

/**
 * Treats a blank/whitespace-only string the same as "unset" so that
 * Docker Compose's `${VAR:-}` interpolation (which substitutes an empty
 * string, not an absent key, when `VAR` is unset) round-trips to `undefined`
 * rather than a present-but-empty value. Without this, an unset
 * `ANTHROPIC_API_KEY` would resolve to `apiKey: ''` instead of "no provider
 * configured", and an unset `STORAGE_PATH` would resolve to `path: ''`
 * instead of falling through to `DEFAULT_STORAGE_PATH`.
 */
function optionalString() {
  // Both `.optional()` calls are load-bearing, not redundant: the inner one
  // lets the preprocessed value (which may now be `undefined`) satisfy
  // `z.string()`; the outer one is what Zod's object-shape introspection
  // checks to allow the KEY to be absent entirely from the input object
  // (Bun.env with the variable unset) rather than merely present-with-a-
  // falsy-value. Dropping either one reintroduces a failure — verified via
  // parseStartEnvironment's own tests.
  return z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().optional(),
    )
    .optional();
}

const EnvironmentSchema = z.object({
  PORT: z.coerce.number().int().nonnegative().optional(),
  // Namespaced, not `HOSTNAME` — that variable is commonly already set in
  // shells and containers (often to the container/machine's own hostname)
  // for reasons unrelated to configuring a bind address. Reading the
  // ambient `HOSTNAME` here would silently override the documented
  // "listen on every interface" default the moment the process runs
  // somewhere that happens to have it set, which is most places.
  GATEWAY_HOST: optionalString(),
  AUTH_TOKEN: optionalString(),
  STORAGE_TYPE: z.enum(['sqlite', 'lmdb', 'memory']).default('sqlite'),
  STORAGE_PATH: optionalString(),
  // Directory of evaluation report JSON files for the read-only `/evaluations`
  // trend page — mirrors `GatewayOptions.evaluationReportsDirectory`. Unset
  // means the page renders empty; evaluation reporting is opt-in.
  EVALUATION_REPORTS_DIRECTORY: optionalString(),
  PROVIDER: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),
  MODEL: optionalString(),
  SYSTEM_PROMPT: optionalString(),
  ANTHROPIC_API_KEY: optionalString(),
  OPENAI_API_KEY: optionalString(),
  GEMINI_API_KEY: optionalString(),
});

export type StartEnvironment = z.infer<typeof EnvironmentSchema>;

const DEFAULT_MODEL: Record<StartEnvironment['PROVIDER'], string> = {
  anthropic: 'claude-opus-4-5',
  openai: 'gpt-5.4',
  gemini: 'gemini-2.5-pro',
};

const DEFAULT_STORAGE_PATH: Record<'sqlite' | 'lmdb', string> = {
  sqlite: './data/agent-bureau.sqlite',
  lmdb: './data/agent-bureau-lmdb',
};

/** Exported for direct unit tests of the PROVIDER → API key lookup. */
export function apiKeyFor(environment: StartEnvironment): string | undefined {
  switch (environment.PROVIDER) {
    case 'anthropic':
      return environment.ANTHROPIC_API_KEY;
    case 'openai':
      return environment.OPENAI_API_KEY;
    case 'gemini':
      return environment.GEMINI_API_KEY;
  }
}

/**
 * Parses `Bun.env`/`process.env` into the typed, defaulted shape the rest of
 * this module uses. Throws a readable error (not a raw Zod issue dump) on
 * invalid input — this only runs once at process start, so a thrown error is
 * the correct failure mode (crash loud, don't boot half-configured).
 */
export function parseStartEnvironment(env: Record<string, string | undefined>): StartEnvironment {
  const result = EnvironmentSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid gateway environment configuration:\n${issues.join('\n')}`);
  }
  return result.data;
}

/**
 * Resolves parsed environment into `createBureau`/`createGateway` options.
 * Pure and exported for unit testing — no I/O, no env reads.
 *
 * A provider is configured only when an API key for `PROVIDER` is present.
 * Without one, the bureau boots with `ready: false` (per `bureau`'s
 * documented no-provider posture) rather than throwing — `/api/v1/health/live`
 * still reports `ok` while `/api/v1/health/ready` reports `unavailable`,
 * which is the correct signal for a container orchestrator's liveness vs.
 * readiness probes.
 */
export function resolveStartOptions(environment: StartEnvironment): {
  bureau: BureauOptions;
  gateway: GatewayOptions;
} {
  const storagePath =
    environment.STORAGE_TYPE === 'memory'
      ? undefined
      : (environment.STORAGE_PATH ?? DEFAULT_STORAGE_PATH[environment.STORAGE_TYPE]);

  const apiKey = apiKeyFor(environment);

  return {
    bureau: {
      // AB-22: gateway dispatches exclusively through `createRun`'s
      // session-based, dynamic-agent-name surface, not the typed
      // `AgentDefinitions` catalog — there is no static agent map to
      // declare at boot. `{}` is the documented empty-catalog form.
      agents: {},
      storage:
        environment.STORAGE_TYPE === 'memory'
          ? { type: 'memory' }
          : environment.STORAGE_TYPE === 'sqlite'
            ? { type: 'sqlite', path: storagePath }
            : { type: 'lmdb', path: storagePath ?? DEFAULT_STORAGE_PATH.lmdb },
      ...(apiKey !== undefined
        ? {
            provider: {
              provider: environment.PROVIDER,
              model: environment.MODEL ?? DEFAULT_MODEL[environment.PROVIDER],
              apiKey,
            },
          }
        : {}),
      ...(environment.SYSTEM_PROMPT !== undefined
        ? { systemPrompt: environment.SYSTEM_PROMPT }
        : {}),
    },
    gateway: {
      ...(environment.PORT !== undefined ? { port: environment.PORT } : {}),
      ...(environment.GATEWAY_HOST !== undefined ? { hostname: environment.GATEWAY_HOST } : {}),
      ...(environment.AUTH_TOKEN !== undefined ? { authToken: environment.AUTH_TOKEN } : {}),
      ...(environment.EVALUATION_REPORTS_DIRECTORY !== undefined
        ? { evaluationReportsDirectory: environment.EVALUATION_REPORTS_DIRECTORY }
        : {}),
    },
  };
}

/**
 * Ensures the parent directory of a file-backed storage path exists.
 * `bun:sqlite` creates the database FILE but not its parent directory —
 * opening `./data/agent-bureau.sqlite` when `./data` doesn't exist yet
 * fails with `SQLITE_CANTOPEN` (the documented default path is exactly this
 * shape). LMDB's directory-as-storage similarly needs its own directory to
 * exist. A no-op for an injected storage adapter, `memory` storage (no
 * path), and a no-op if the directory already exists.
 */
async function ensureStorageDirectoryExists(bureauOptions: BureauOptions): Promise<void> {
  const storage = bureauOptions.storage;
  if (
    !storage ||
    !('type' in storage) ||
    storage.type === 'memory' ||
    !('path' in storage) ||
    !storage.path
  )
    return;
  await mkdir(dirname(storage.path), { recursive: true });
}

/**
 * Boots the gateway and resolves once it is listening. Exported for tests
 * that want a real (ephemeral) server without going through `main()`'s
 * signal handlers or process-env parsing.
 */
export async function startGateway(environment: StartEnvironment) {
  const options = resolveStartOptions(environment);
  await ensureStorageDirectoryExists(options.bureau);
  const bureau = await createBureau(options.bureau);
  const gateway = await createGateway(bureau, options.gateway);
  const server = await gateway.start();
  return { gateway, server, bureau };
}

/**
 * Runs the AB-235 shutdown sequence: awaits `server.stop()`'s bounded
 * drain-then-force-close report, logs it, then always runs
 * `gateway.bureau.dispose()` — even if `stop()` throws — so a failed drain
 * never leaves durable state un-flushed (AB-37: drain rather than abandon).
 *
 * Extracted from `main()`'s SIGTERM/SIGINT handler so the shutdown sequence
 * is directly unit-testable against injected `server`/`gateway.bureau`
 * fakes and an injected `logger`, without going through real process
 * signals or `process.exit`.
 */
export async function shutdownGateway(
  gateway: { bureau: { dispose(): Promise<void> } },
  server: { stop(): Promise<GatewayShutdownReport> },
  logger: Pick<Console, 'log'> = console,
): Promise<GatewayShutdownReport> {
  try {
    // AB-235: `server.stop()` drains open connections for a bounded
    // period, then force-closes whatever remains. Log the report so an
    // operator can see whether shutdown was clean or had to force-close
    // a lingering connection (e.g. an attached UI client).
    const report = await server.stop();
    if (report.drained) {
      logger.log('[gateway] drained cleanly');
    } else {
      logger.log(
        `[gateway] drain timed out — force-closed ${report.forcedConnections} live-stream connection(s)`,
      );
    }
    return report;
  } finally {
    // Always run cleanup, even if the drain itself threw, so a failed
    // stop() never leaves durable state un-flushed (AB-37: drain rather
    // than abandon).
    await gateway.bureau.dispose();
  }
}

/**
 * The process entrypoint's own composition: parses `Bun.env`, boots the
 * gateway, logs the listening port, and registers the SIGTERM/SIGINT
 * shutdown handler. Returns the booted `{ gateway, server, shutdown,
 * handleShutdownSignal }` — all discarded by the `if (import.meta.main)`
 * call below in real process usage, but exported so `start.test.ts` can call
 * `main()` directly, shut the real server back down afterward rather than
 * leaking a live listener across the test run, and call the returned
 * `handleShutdownSignal` directly to exercise the exact function object
 * registered as the SIGTERM/SIGINT listener — never through a real process
 * signal or `process.exit`, both of which would affect the whole shared test
 * process.
 */
export async function main(): Promise<
  Awaited<ReturnType<typeof startGateway>> & {
    shutdown: (signal: string) => Promise<void>;
    handleShutdownSignal: (signal: string) => void;
  }
> {
  const environment = parseStartEnvironment(Bun.env);
  if (environment.STORAGE_TYPE === 'memory') {
    console.warn(
      '[gateway] STORAGE_TYPE=memory — durable execution and sessions are OFF and will not ' +
        'survive a restart. Use sqlite or lmdb for anything beyond local experimentation.',
    );
  }
  if (apiKeyFor(environment) === undefined) {
    console.warn(
      `[gateway] No API key found for provider "${environment.PROVIDER}" — the bureau will ` +
        'boot with ready=false (/api/v1/health/ready reports unavailable) until one is configured.',
    );
  }

  const booted = await startGateway(environment);
  const { gateway, server } = booted;
  console.log(`[gateway] listening on port ${gateway.port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] received ${signal}, shutting down`);
    await shutdownGateway(gateway, server);
    process.exit(0);
  };
  // process.on wants a void-returning listener, not `shutdown` itself
  // (an async function) — `handleShutdownSignal` is the actual function
  // object registered for both signals, and the one `start.test.ts` calls
  // directly to exercise the real listener without a real OS signal.
  const handleShutdownSignal = (signal: string): void => void shutdown(signal);
  process.on('SIGTERM', handleShutdownSignal);
  process.on('SIGINT', handleShutdownSignal);
  return { ...booted, shutdown, handleShutdownSignal };
}

if (import.meta.main) {
  await main();
}
