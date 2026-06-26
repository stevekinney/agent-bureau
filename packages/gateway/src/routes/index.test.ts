import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';

import { LiveFrameBroker } from '../live-events';
import { createRoutes } from './index';

function createMockGenerate() {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

describe('route scope guards', () => {
  it('requires runs:read for scheduler reads when API key scopes are present', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      scheduler: { enabled: true, idleDelay: 1 },
      toolbox: createToolbox([]),
    });
    const app = createRoutes({ bureau, broker: new LiveFrameBroker() });

    const response = await app.request('/api/v1/scheduler', {
      headers: { 'x-api-key-scopes': 'runs:write' },
    });

    expect(response.status).toBe(403);
    bureau.dispose();
  });

  it('requires runs:write for scheduler mutations when API key scopes are present', async () => {
    const bureau = await createBureau({
      generate: createMockGenerate(),
      scheduler: { enabled: true, idleDelay: 1 },
      toolbox: createToolbox([]),
    });
    const app = createRoutes({ bureau, broker: new LiveFrameBroker() });

    const createResponse = await app.request('/api/v1/scheduler/tasks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key-scopes': 'runs:read',
      },
      body: JSON.stringify({ message: 'Denied write' }),
    });
    expect(createResponse.status).toBe(403);

    const deleteResponse = await app.request('/api/v1/scheduler/tasks/example', {
      method: 'DELETE',
      headers: {
        'x-api-key-scopes': 'runs:read',
      },
    });
    expect(deleteResponse.status).toBe(403);

    bureau.dispose();
  });
});
