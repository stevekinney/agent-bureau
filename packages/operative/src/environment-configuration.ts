import { environmentalist, secret } from '@lostgradient/environmentalist';
import type { Source, SourceResult } from '@lostgradient/environmentalist/types';
import { z } from 'zod';

const environmentSchema = z.object({
  googleApiKey: secret(z.string().optional()).meta({ env: 'GOOGLE_API_KEY' }),
  openaiBaseUrl: z.string().optional().meta({ env: 'OPENAI_BASE_URL' }),
});

const environmentVariables = {
  googleApiKey: 'GOOGLE_API_KEY',
  openaiBaseUrl: 'OPENAI_BASE_URL',
} as const;

function runtimeEnvironment(): Record<string, string | undefined> {
  const runtimeBun = Reflect.get(globalThis, 'Bun');
  if (typeof runtimeBun === 'object' && runtimeBun !== null) {
    const bunEnvironment = Reflect.get(runtimeBun, 'env');
    if (typeof bunEnvironment === 'object' && bunEnvironment !== null) {
      return Object.fromEntries(
        Object.values(environmentVariables).map((name) => [
          name,
          Reflect.get(bunEnvironment, name),
        ]),
      );
    }
  }

  const runtimeProcess = Reflect.get(globalThis, 'process');
  if (typeof runtimeProcess === 'object' && runtimeProcess !== null) {
    const processEnvironment = Reflect.get(runtimeProcess, 'env');
    if (typeof processEnvironment === 'object' && processEnvironment !== null) {
      return Object.fromEntries(
        Object.values(environmentVariables).map((name) => [
          name,
          Reflect.get(processEnvironment, name),
        ]),
      );
    }
  }
  return {};
}

function loadEnvironment(): SourceResult | undefined {
  const environment = runtimeEnvironment();
  const values = Object.fromEntries(
    Object.entries(environmentVariables)
      .map(([canonicalKey, variableName]) => [canonicalKey, environment[variableName]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return Object.keys(values).length === 0 ? undefined : { values, location: 'runtime environment' };
}

const runtimeEnvironmentSource: Source = {
  id: 'operative-runtime-environment',
  kind: 'string',
  load: loadEnvironment,
  loadSync: loadEnvironment,
};

/** Resolve provider configuration without assuming Bun or Node globals exist. */
export function readEnvironmentConfiguration() {
  return environmentalist.sync({
    name: 'corvidae-operative',
    schema: environmentSchema,
    argv: [],
    coerce: false,
    sources: [runtimeEnvironmentSource, 'defaults'],
  });
}

export type EnvironmentConfiguration = ReturnType<typeof readEnvironmentConfiguration>;
