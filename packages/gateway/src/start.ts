import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createBureau } from 'bureau';
import { z } from 'zod';

import { createGateway } from './create-gateway';
import type { BureauOptions, GatewayOptions } from './types';

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

function apiKeyFor(environment: StartEnvironment): string | undefined {
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
 * exist. A no-op for `memory` storage (no path) and a no-op if the
 * directory already exists.
 */
async function ensureStorageDirectoryExists(bureauOptions: BureauOptions): Promise<void> {
  const storage = bureauOptions.storage;
  if (!storage || storage.type === 'memory' || !('path' in storage) || !storage.path) return;
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

async function main(): Promise<void> {
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

  const { gateway, server } = await startGateway(environment);
  console.log(`[gateway] listening on port ${gateway.port}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] received ${signal}, shutting down`);
    server.stop();
    gateway.bureau.dispose();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.main) {
  await main();
}
