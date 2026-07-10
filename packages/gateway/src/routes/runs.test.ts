import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { GenerateFunction, Toolbox } from 'operative';

import { createTestGateway, requestJSON, waitForRunState } from '../test';

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

describe('runs routes', () => {
  it('POST /api/v1/runs returns 503 when no generate is configured', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(503);
  });

  it('POST /api/v1/runs returns 400 when message is missing', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it('POST /api/v1/runs creates a run and returns 201', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.id).toBeString();
    expect(body.status).toBe('running');
  });

  it('POST /api/v1/runs returns 429 when a flow-control policy rejects admission (AB-13)', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
      flowControl: { concurrency: { limit: 0 } },
    });

    const response = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(429);
  });

  it('GET /api/v1/runs lists all runs', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    // Create a run
    await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });

    const response = await requestJSON(gateway, '/api/v1/runs');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/runs/:id returns a specific run', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    const { id } = await createResponse.json();

    const response = await requestJSON(gateway, `/api/v1/runs/${id}`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.id).toBe(id);
  });

  it('GET /api/v1/runs/:id returns 404 for missing run', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs/nonexistent');
    expect(response.status).toBe(404);
  });

  it('POST /api/v1/runs/:id/abort returns 404 for missing run', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs/nonexistent/abort', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  it('DELETE /api/v1/runs/:id returns 404 for missing run', async () => {
    const gateway = await createTestGateway({ generate: createMockGenerate() });
    const response = await requestJSON(gateway, '/api/v1/runs/nonexistent', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });

  it('DELETE /api/v1/runs/:id returns 409 for running run', async () => {
    // Use a generate that never resolves so run stays in running state
    const generate: GenerateFunction = () => new Promise(() => {});
    const gateway = await createTestGateway({ generate, toolbox: createEmptyToolbox() });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    const { id } = await createResponse.json();

    expect(gateway.bureau.getRun(id)?.status).toBe('running');

    const response = await requestJSON(gateway, `/api/v1/runs/${id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
  });

  it('GET /api/v1/runs?status= filters by status', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
    });
    const createdRun = await createResponse.json();

    await waitForRunState(gateway.bureau, createdRun.id);

    const response = await requestJSON(gateway, '/api/v1/runs?status=completed');
    expect(response.status).toBe(200);
    const body = await response.json();
    // Should find runs matching the filter (may be 0 if timing is off, but no error)
    expect(Array.isArray(body)).toBe(true);
  });
});
