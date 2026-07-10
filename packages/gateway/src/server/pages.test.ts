import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';

import { createApiKeyStore } from '../keys/create-api-key-store';
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
    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('tabindex="-1"');

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

  describe('GET /reviews scope enforcement (AB-20)', () => {
    it('rejects a managed key without reviews:read with 403, same as the JSON API', async () => {
      const kv = textValueStore(new MemoryStorage());
      const apiKeyStore = createApiKeyStore(kv);
      // A key scoped for something else entirely — no `reviews:read` — must
      // not be able to read the SSR page's hydration payload even though
      // `GET /api/v1/reviews` already rejects it.
      const { plaintext } = await apiKeyStore.create({ name: 'no-reviews', scopes: ['runs:read'] });

      const bureau = await createBureau({ persistence: kv });
      const gateway = await createTestGateway(bureau);

      const response = await gateway.app.request('/reviews', {
        headers: { authorization: `Bearer ${plaintext}` },
      });

      expect(response.status).toBe(403);
    });

    it('serves the review queue page for a key that carries reviews:read', async () => {
      const kv = textValueStore(new MemoryStorage());
      const apiKeyStore = createApiKeyStore(kv);
      const { plaintext } = await apiKeyStore.create({
        name: 'has-reviews',
        scopes: ['reviews:read'],
      });

      const bureau = await createBureau({ persistence: kv });
      const gateway = await createTestGateway(bureau);

      const response = await gateway.app.request('/reviews', {
        headers: { authorization: `Bearer ${plaintext}` },
      });

      expect(response.status).toBe(200);
      const html = await response.text();
      const data = extractInitialData(html);
      expect(data).toHaveProperty('reviews');
    });

    it('serves the review queue page for an admin key (empty scopes)', async () => {
      const kv = textValueStore(new MemoryStorage());
      const apiKeyStore = createApiKeyStore(kv);
      const { plaintext } = await apiKeyStore.create({ name: 'admin' });

      const bureau = await createBureau({ persistence: kv });
      const gateway = await createTestGateway(bureau);

      const response = await gateway.app.request('/reviews', {
        headers: { authorization: `Bearer ${plaintext}` },
      });

      expect(response.status).toBe(200);
    });
  });
});
