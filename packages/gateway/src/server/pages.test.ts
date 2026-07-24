import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { afterEach, describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';

import { createApiKeyStore } from '../keys/create-api-key-store';
import { createTestGateway } from '../test';
import { extractRootMarkup } from './test-utilities';

const evaluationsFixturesDirectory = join(import.meta.dir, '__evaluations-fixtures__');

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

function expectPageHeading(html: string, title: string): void {
  const rootMarkup = extractRootMarkup(html);
  const pageHeadings = [...rootMarkup.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/gs)];
  expect(pageHeadings).toHaveLength(1);
  expect(pageHeadings[0]?.[1]).toBe(title.replaceAll('&', '&amp;'));
  expect(rootMarkup.match(/<h[1-4]\b/)?.[0]).toBe('<h1');
}

afterEach(() => {
  rmSync(evaluationsFixturesDirectory, { recursive: true, force: true });
});

describe('SSR pages', () => {
  it('renders one page-level h1 for every non-run production route', async () => {
    const gateway = await createTestGateway();
    const routes = [
      ['/dashboard', 'Dashboard'],
      ['/configuration', 'Configuration'],
      ['/usage', 'Usage & Cost'],
      ['/chat', 'Chat'],
      ['/evaluations', 'Evaluations'],
      ['/reviews', 'Review Queue'],
    ] as const;

    for (const [route, title] of routes) {
      const response = await gateway.app.request(route);
      expect(response.status).toBe(200);
      expectPageHeading(await response.text(), title);
    }
  });

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
    expect(html).toContain('Agent Bureau');
    expect((html.match(/<nav\b/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/<nav\b[\s\S]*<nav\b/);
    expect(html).toContain('aria-controls="agent-bureau-sidebar"');
    expect(html).toContain('role="status"');

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

  it('GET /usage returns 200 HTML with the real UsageResponse', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/usage');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const html = await response.text();
    expect(html).toContain('id="root"');

    const data = extractInitialData(html);
    expect(data).toHaveProperty('usage');
    const usage = (data as { usage: Record<string, unknown> }).usage;
    expect(usage).toHaveProperty('aggregate');
    expect(usage).toHaveProperty('analytics');
    expect(usage).toHaveProperty('runs');
    const analytics = usage['analytics'] as Record<string, unknown>;
    expect(analytics).toHaveProperty('byAgent');
    expect(analytics).toHaveProperty('byPrincipal');
    expect(analytics).toHaveProperty('byWindow');
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

  it('GET /evaluations returns 200 HTML with an empty evaluations payload when no directory is configured', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/evaluations');

    expect(response.status).toBe(200);
    const html = await response.text();
    const data = extractInitialData(html);
    expect(data).toEqual({ evaluations: { reports: [] } });
  });

  it('GET /evaluations returns report summaries from the configured directory', async () => {
    await Bun.write(
      join(evaluationsFixturesDirectory, 'report-1.json'),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        cases: [],
        summary: {
          total: 4,
          passed: 3,
          failed: 1,
          passRate: 0.75,
          averageScore: 0.75,
          averageSteps: 2,
          averageTokens: 300,
          averageDuration: 900,
        },
      }),
    );

    const gateway = await createTestGateway({
      evaluationReportsDirectory: evaluationsFixturesDirectory,
    });
    const response = await gateway.app.request('/evaluations');

    expect(response.status).toBe(200);
    const html = await response.text();
    const data = extractInitialData(html) as { evaluations: { reports: unknown[] } };
    expect(data.evaluations.reports).toHaveLength(1);
    expect(data.evaluations.reports[0]).toMatchObject({
      timestamp: '2026-01-01T00:00:00.000Z',
      total: 4,
      passed: 3,
      failed: 1,
      passRate: 0.75,
    });
    // The Svelte page actually rendered the report into the trend chart /
    // table server-side, not just the empty-state fallback.
    const rootMarkup = extractRootMarkup(html);
    expect(rootMarkup).toContain('2026-01-01T00:00:00.000Z');
    expect(rootMarkup).toContain('role="region"');
    expect(rootMarkup).toContain('aria-label="Evaluation reports table scroll area"');
    expect(rootMarkup).toContain('tabindex="0"');
    expect(rootMarkup).toMatch(/<caption[^>]*>Evaluation reports<\/caption>/);
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

  it('server-renders the Cinder Sidebar mobile query for a correct mobile first paint', async () => {
    const gateway = await createTestGateway();
    const response = await gateway.app.request('/dashboard');
    const html = await response.text();

    expect(html).toContain('data-gateway-mobile-layout');
    expect(html).toMatch(/@media \(max-width: [^)]+\)/);
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

  describe('GET /usage scope enforcement (AB-54)', () => {
    it('rejects a managed key without runs:read with 403, same as the JSON API', async () => {
      const kv = textValueStore(new MemoryStorage());
      const apiKeyStore = createApiKeyStore(kv);
      const { plaintext } = await apiKeyStore.create({
        name: 'no-usage',
        scopes: ['reviews:read'],
      });

      const bureau = await createBureau({ persistence: kv });
      const gateway = await createTestGateway(bureau);

      const response = await gateway.app.request('/usage', {
        headers: { authorization: `Bearer ${plaintext}` },
      });

      expect(response.status).toBe(403);
    });

    it('serves the usage page for a key that carries runs:read', async () => {
      const kv = textValueStore(new MemoryStorage());
      const apiKeyStore = createApiKeyStore(kv);
      const { plaintext } = await apiKeyStore.create({ name: 'has-runs', scopes: ['runs:read'] });

      const bureau = await createBureau({ persistence: kv });
      const gateway = await createTestGateway(bureau);

      const response = await gateway.app.request('/usage', {
        headers: { authorization: `Bearer ${plaintext}` },
      });

      expect(response.status).toBe(200);
      const html = await response.text();
      const data = extractInitialData(html);
      expect(data).toHaveProperty('usage');
    });
  });
});
