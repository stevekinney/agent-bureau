import { describe, expect, it } from 'bun:test';

import { createTestGateway } from '../test';

/**
 * Extracts the serialized `window.__INITIAL_DATA__` payload from an SSR HTML
 * document so tests can assert on the hydration data without coupling to the
 * app's rendered markup (owned by other migration units).
 */
function extractInitialData(html: string): unknown {
  const match = html.match(/window\.__INITIAL_DATA__ = (.*?);<\/script>/s);
  if (!match?.[1]) {
    throw new Error('window.__INITIAL_DATA__ not found in SSR output');
  }
  return JSON.parse(match[1]);
}

/**
 * Extracts the markup the Svelte app server-rendered into `<div id="root">`,
 * i.e. everything between the root open tag and the inline data `<script>`.
 * Lets tests assert the app actually rendered (non-empty body) rather than
 * merely emitting the shell, without coupling to a specific page's markup.
 */
function extractRootMarkup(html: string): string {
  const match = html.match(/<div id="root">(.*?)<\/div>\s*<script>window\.__INITIAL_DATA__/s);
  if (!match) {
    throw new Error('#root mount not found in SSR output');
  }
  return match[1] ?? '';
}

describe('SSR pages', () => {
  it('GET / redirects to /dashboard', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard');
  });

  it('GET /dashboard returns 200 HTML with a #root mount and runs initial data', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/dashboard');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const html = await response.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('window.__INITIAL_DATA__');

    // The Svelte app actually rendered into #root server-side, not just the
    // empty shell.
    expect(extractRootMarkup(html).trim().length).toBeGreaterThan(0);

    const data = extractInitialData(html);
    expect(data).toHaveProperty('runs');
    expect(Array.isArray((data as { runs: unknown }).runs)).toBe(true);
  });

  it('GET /runs/:id returns 404 for a missing run', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/runs/nonexistent');

    expect(response.status).toBe(404);
  });

  it('GET /configuration returns 200 HTML with the real ConfigurationResponse', async () => {
    const gateway = await createTestGateway({
      provider: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      maximumSteps: 5,
      systemPrompt: 'Be helpful.',
    });
    const response = await gateway.app.request('/configuration');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const html = await response.text();
    expect(html).toContain('id="root"');

    // The configuration seam is fixed: the page receives the full
    // ConfigurationResponse under `config` (provider/maximumSteps/systemPrompt),
    // not the legacy top-level shape the client never read.
    const data = extractInitialData(html);
    expect(data).toHaveProperty('config');
    const config = (data as { config: Record<string, unknown> }).config;
    expect(config['maximumSteps']).toBe(5);
    expect(config['systemPrompt']).toBe('Be helpful.');
    expect(config['provider']).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
    expect(config).toHaveProperty('providers');
    expect(config).toHaveProperty('tools');
  });

  it('GET /chat returns 200 HTML with an empty initial-data payload', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/chat');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const html = await response.text();
    expect(html).toContain('id="root"');

    const data = extractInitialData(html);
    expect(data).toEqual({});
  });

  it('links the cinder stylesheet and the hydration module script on every page', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/dashboard');
    const html = await response.text();

    expect(html).toContain('rel="stylesheet"');
    expect(html).toContain('/public/styles.css');
    expect(html).toContain('type="module"');
    expect(html).toContain('/public/entry.js');
  });
});
