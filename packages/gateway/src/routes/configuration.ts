import { Hono } from 'hono';
import type { Toolbox } from 'operative';

import type { ConfigurationResponse, ProviderConfiguration, ToolSummary } from '../types';

interface ConfigurationDependencies {
  provider: ProviderConfiguration | undefined;
  toolbox: Toolbox | undefined;
  maximumSteps: number;
  systemPrompt: string | undefined;
}

export function createConfigurationRoutes(dependencies: ConfigurationDependencies) {
  const app = new Hono();

  app.get('/', (context) => {
    const tools = getToolSummaries(dependencies.toolbox);
    const body: ConfigurationResponse = {
      provider: dependencies.provider,
      maximumSteps: dependencies.maximumSteps,
      systemPrompt: dependencies.systemPrompt,
      tools,
    };
    return context.json(body, 200);
  });

  app.get('/tools', (context) => {
    const tools = getToolSummaries(dependencies.toolbox);
    return context.json(tools, 200);
  });

  return app;
}

function getToolSummaries(toolbox: Toolbox | undefined): ToolSummary[] {
  if (!toolbox) return [];
  return toolbox.tools().map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
  }));
}
