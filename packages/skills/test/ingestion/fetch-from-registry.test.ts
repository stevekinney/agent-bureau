import { describe, expect, it } from 'bun:test';

import { fetchFromRegistry } from '../../src/ingestion/fetch-from-registry';
import { createMockSkillProvider } from '../../src/test/index';

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill from the registry
---

## Instructions

Do something useful.
`;

function makeSkillMarkdown(name: string, description = `Description for ${name}`): string {
  return `---
name: ${name}
description: ${description}
---

## Instructions for ${name}

Do something useful.
`;
}

function createMockFetch(
  responses: Record<string, { status: number; body: string } | 'network-error'>,
): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    const response = responses[url];

    if (response === 'network-error') {
      throw new Error('Network error: connection refused');
    }

    if (response) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.status === 200 ? 'OK' : 'Not Found',
      });
    }

    return new Response('Not Found', { status: 404, statusText: 'Not Found' });
  };
}

describe('fetchFromRegistry', () => {
  const baseUrl = 'https://registry.example.com/skills';

  it('fetches a skill and writes it to the provider', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
    });

    expect(result.loaded).toEqual(['test-skill']);
    expect(result.errors).toHaveLength(0);

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.args[0]).toBe('test-skill');
  });

  it('handles network errors gracefully', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/broken-skill/SKILL.md`]: 'network-error',
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['broken-skill'],
      provider,
      fetchFunction,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('broken-skill');
    expect(result.errors[0]?.error).toContain('Network error');
  });

  it('returns a clear error for 404 responses', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/missing-skill/SKILL.md`]: { status: 404, body: 'Not Found' },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['missing-skill'],
      provider,
      fetchFunction,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('missing-skill');
    expect(result.errors[0]?.error).toContain('404');
  });

  it('fetches multiple skills in one call', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/alpha/SKILL.md`]: { status: 200, body: makeSkillMarkdown('alpha') },
      [`${baseUrl}/beta/SKILL.md`]: { status: 200, body: makeSkillMarkdown('beta') },
      [`${baseUrl}/gamma/SKILL.md`]: { status: 200, body: makeSkillMarkdown('gamma') },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['alpha', 'beta', 'gamma'],
      provider,
      fetchFunction,
    });

    expect(result.loaded.sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.errors).toHaveLength(0);

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(3);
  });

  it('handles partial failure with both loaded and errors', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/good-skill/SKILL.md`]: { status: 200, body: makeSkillMarkdown('good-skill') },
      [`${baseUrl}/bad-skill/SKILL.md`]: { status: 404, body: 'Not Found' },
      [`${baseUrl}/error-skill/SKILL.md`]: 'network-error',
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['good-skill', 'bad-skill', 'error-skill'],
      provider,
      fetchFunction,
    });

    expect(result.loaded).toEqual(['good-skill']);
    expect(result.errors).toHaveLength(2);

    const errorNames = result.errors.map((error) => error.name).sort();
    expect(errorNames).toEqual(['bad-skill', 'error-skill']);
  });

  it('adds malformed response to errors', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/malformed/SKILL.md`]: {
        status: 200,
        body: '---\nnot-valid: true\n---\n\nNo name or description.',
      },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['malformed'],
      provider,
      fetchFunction,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('malformed');
    expect(result.errors[0]?.error).toBeTruthy();
  });
});
