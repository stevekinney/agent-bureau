import { describe, expect, it } from 'bun:test';

import { createTestGateway } from '../test';

describe('SSR pages', () => {
  it('GET / redirects to /dashboard', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard');
  });

  it('GET /dashboard returns 200 with HTML content-type', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/dashboard');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const html = await response.text();
    expect(html).toContain('<h1>Dashboard</h1>');
    expect(html).toContain('__INITIAL_DATA__');
  });

  it('GET /runs/:id returns 404 for missing run', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/runs/nonexistent');

    expect(response.status).toBe(404);
  });

  it('GET /configuration returns 200 with HTML content-type', async () => {
    const gateway = await createTestGateway({
      provider: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      maximumSteps: 5,
      systemPrompt: 'Be helpful.',
    });
    const response = await gateway.app.request('/configuration');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const html = await response.text();
    expect(html).toContain('<h1>Configuration</h1>');
    expect(html).toContain('__INITIAL_DATA__');
  });

  it('GET /chat returns 200 with HTML content-type', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/chat');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const html = await response.text();
    expect(html).toContain('<h1>Chat</h1>');
    expect(html).toContain('<form');
  });
});
