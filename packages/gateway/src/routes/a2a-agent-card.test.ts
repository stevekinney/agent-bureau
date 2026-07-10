import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTestGateway, requestJSON } from '../test';

describe('A2A Agent Card (GET /.well-known/agent-card.json)', () => {
  it('returns a card with generic defaults when no a2a options are configured', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/.well-known/agent-card.json');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.name).toBe('Agent Bureau');
    expect(typeof body.description).toBe('string');
    expect(body.version).toBe('0.0.0');
    expect(body.skills).toEqual([]);
    expect(body.provider).toBeUndefined();
    expect(body.iconUrl).toBeUndefined();
  });

  it('overrides name/description/version/provider/iconUrl from GatewayOptions.a2a', async () => {
    const gateway = await createTestGateway({
      a2a: {
        name: 'Recipe Agent',
        description: 'Helps with recipes.',
        version: '1.2.3',
        provider: { organization: 'Acme', url: 'https://acme.example.com' },
        iconUrl: 'https://acme.example.com/icon.png',
      },
    });

    const response = await requestJSON(gateway, '/.well-known/agent-card.json');
    const body = await response.json();

    expect(body.name).toBe('Recipe Agent');
    expect(body.description).toBe('Helps with recipes.');
    expect(body.version).toBe('1.2.3');
    expect(body.provider).toEqual({ organization: 'Acme', url: 'https://acme.example.com' });
    expect(body.iconUrl).toBe('https://acme.example.com/icon.png');
  });

  it('declares capabilities.streaming: false — streaming is a documented follow-up', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/.well-known/agent-card.json');
    const body = await response.json();

    expect(body.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    });
  });

  it('surfaces the bureau toolbox as A2A skills', async () => {
    const tool = createTool({
      name: 'search-recipes',
      description: 'Searches the recipe database',
      input: z.object({ query: z.string() }),
      execute: async ({ query }: { query: string }) => `results for ${query}`,
    });
    const gateway = await createTestGateway({ toolbox: createToolbox([tool]) });

    const response = await requestJSON(gateway, '/.well-known/agent-card.json');
    const body = await response.json();

    expect(body.skills).toEqual([
      {
        id: 'search-recipes',
        name: 'search-recipes',
        description: 'Searches the recipe database',
        tags: [],
      },
    ]);
  });

  it('the supportedInterfaces URL points at the POST /a2a JSON-RPC endpoint on the request origin', async () => {
    const gateway = await createTestGateway();
    const response = await requestJSON(gateway, '/.well-known/agent-card.json');
    const body = await response.json();

    expect(body.supportedInterfaces).toEqual([
      { url: 'http://localhost/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ]);
  });

  it('honors an explicit baseUrl override for reverse-proxied deployments', async () => {
    const gateway = await createTestGateway({
      a2a: { baseUrl: 'https://agents.example.com' },
    });
    const response = await requestJSON(gateway, '/.well-known/agent-card.json');
    const body = await response.json();

    expect(body.supportedInterfaces[0].url).toBe('https://agents.example.com/a2a');
  });
});
