import type { SessionPersistenceAdapter } from 'conversationalist';
import { Hono } from 'hono';
import type { GenerateFunction, StopCondition, Toolbox } from 'operative';
import type { Store } from 'sentinel';

import type { ProviderConfiguration } from '../types';
import { createConfigurationRoutes } from './configuration';
import { createConversationsRoutes } from './conversations';
import { createHealthRoutes } from './health';
import { createRunsRoutes } from './runs';

export interface RouteDependencies {
  store: Store;
  generate: GenerateFunction | undefined;
  toolbox: Toolbox | undefined;
  persistence: SessionPersistenceAdapter | undefined;
  provider: ProviderConfiguration | undefined;
  stopWhen: StopCondition | StopCondition[] | undefined;
  maximumSteps: number;
  systemPrompt: string | undefined;
}

export function createRoutes(dependencies: RouteDependencies) {
  const app = new Hono();

  app.route(
    '/api/v1/health',
    createHealthRoutes({
      store: dependencies.store,
      generate: dependencies.generate,
    }),
  );

  app.route(
    '/api/v1/runs',
    createRunsRoutes({
      store: dependencies.store,
      generate: dependencies.generate,
      toolbox: dependencies.toolbox,
      persistence: dependencies.persistence,
      stopWhen: dependencies.stopWhen,
      maximumSteps: dependencies.maximumSteps,
      systemPrompt: dependencies.systemPrompt,
    }),
  );

  app.route(
    '/api/v1/conversations',
    createConversationsRoutes({
      persistence: dependencies.persistence,
    }),
  );

  app.route(
    '/api/v1/configuration',
    createConfigurationRoutes({
      provider: dependencies.provider,
      toolbox: dependencies.toolbox,
      maximumSteps: dependencies.maximumSteps,
      systemPrompt: dependencies.systemPrompt,
    }),
  );

  return app;
}
