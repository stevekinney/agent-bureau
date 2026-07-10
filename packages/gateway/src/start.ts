import { createBureau } from 'bureau';
import { z } from 'zod';

import { createGateway } from './create-gateway';
import type { BureauOptions, GatewayOptions } from './types';

/**
 * Process entrypoint for running the gateway as a standalone service (the
 * Dockerfile `CMD`, `bun run start`, `bun run src/start.ts`). `src/index.ts`
 * is a library barrel — importing it starts nothing. This file is the
 * opposite: it reads configuration from the environment, boots one bureau +
 * gateway, and listens until it receives a shutdown signal.
 *
 * See `documentation/deployment.md` for the full environment contract.
 */

const EnvironmentSchema = z.object({
  PORT: z.coerce.number().int().positive().optional(),
  HOSTNAME: z.string().optional(),
  AUTH_TOKEN: z.string().min(1).optional(),
  STORAGE_TYPE: z.enum(['sqlite', 'lmdb', 'memory']).default('sqlite'),
  STORAGE_PATH: z.string().optional(),
  PROVIDER: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),
  MODEL: z.string().optional(),
  SYSTEM_PROMPT: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
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
      ...(environment.HOSTNAME !== undefined ? { hostname: environment.HOSTNAME } : {}),
      ...(environment.AUTH_TOKEN !== undefined ? { authToken: environment.AUTH_TOKEN } : {}),
    },
  };
}

/**
 * Boots the gateway and resolves once it is listening. Exported for tests
 * that want a real (ephemeral) server without going through `main()`'s
 * signal handlers or process-env parsing.
 */
export async function startGateway(environment: StartEnvironment) {
  const options = resolveStartOptions(environment);
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

  const { gateway } = await startGateway(environment);
  console.log(`[gateway] listening on port ${gateway.port}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] received ${signal}, shutting down`);
    gateway.bureau.dispose();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.main) {
  await main();
}
