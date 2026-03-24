import { describe, expect, it } from 'bun:test';
import type { GenerateFunction } from 'operative';

import { createTestGateway, requestJSON } from '../test';

describe('health routes', () => {
  it('GET /api/v1/health/live returns 200', async () => {
    const gateway = createTestGateway();
    const response = await requestJSON(gateway, '/api/v1/health/live');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  it('GET /api/v1/health/ready returns 503 when no generate is configured', async () => {
    const gateway = createTestGateway();
    const response = await requestJSON(gateway, '/api/v1/health/ready');
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('unavailable');
  });

  it('GET /api/v1/health/ready returns 200 when generate is configured', async () => {
    const generate: GenerateFunction = async () => ({ content: '', toolCalls: [] });
    const gateway = createTestGateway({ generate });
    const response = await requestJSON(gateway, '/api/v1/health/ready');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });
});
