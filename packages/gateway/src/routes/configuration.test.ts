import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTestGateway, requestJSON } from '../test';
import { DEFAULT_MAXIMUM_STEPS } from '../types';

describe('configuration routes', () => {
  it('GET /api/v1/configuration returns current config', async () => {
    const gateway = createTestGateway({
      provider: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      systemPrompt: 'You are helpful.',
    });

    const response = await requestJSON(gateway, '/api/v1/configuration');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.provider.provider).toBe('anthropic');
    expect(body.provider.model).toBe('claude-sonnet-4-20250514');
    expect(body.maximumSteps).toBe(DEFAULT_MAXIMUM_STEPS);
    expect(body.systemPrompt).toBe('You are helpful.');
    expect(body.tools).toEqual([]);
  });

  it('GET /api/v1/configuration/tools returns tool list', async () => {
    const tool = createTool({
      name: 'greet',
      description: 'Says hello',
      input: z.object({ name: z.string() }),
      execute: async ({ name }: { name: string }) => `Hello, ${name}!`,
    });
    const toolbox = createToolbox([tool]);

    const gateway = createTestGateway({ toolbox });
    const response = await requestJSON(gateway, '/api/v1/configuration/tools');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('greet');
    expect(body[0].description).toBe('Says hello');
  });

  it('GET /api/v1/configuration/tools returns empty when no toolbox', async () => {
    const gateway = createTestGateway();
    const response = await requestJSON(gateway, '/api/v1/configuration/tools');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([]);
  });
});
