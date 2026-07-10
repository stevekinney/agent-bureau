import { describe, expect, it } from 'bun:test';

import { createToolbox } from '../src/create-toolbox';
import { createToolboxFromOpenAPI, type OpenAPISpec } from '../src/integrations/openapi';
import petstoreSpec from './fixtures/petstore-expanded.json';

// The petstore-expanded fixture is a real-world OpenAPI 3.0 document (vendored from
// OAI/OpenAPI-Specification's own examples): 4 operations across 2 paths, query
// parameters, a path parameter, a `$ref`-based request body, and `allOf` composition.
const spec = petstoreSpec as OpenAPISpec;

function createFakeFetch(response: { status: number; body?: unknown; contentType?: string }): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const bodyText = response.body !== undefined ? JSON.stringify(response.body) : '';
    return new Response(bodyText, {
      status: response.status,
      headers: {
        'content-type': response.contentType ?? 'application/json',
      },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe('createToolboxFromOpenAPI', () => {
  it('generates one tool per operation in the spec', () => {
    const tools = createToolboxFromOpenAPI(spec);

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['add-pet', 'delete-pet', 'find-pet-by-id', 'find-pets'].sort(),
    );
  });

  it('marks GET operations read-only and non-mutating', () => {
    const tools = createToolboxFromOpenAPI(spec);
    const findPets = tools.find((tool) => tool.name === 'find-pets');

    expect(findPets?.metadata).toEqual({ readOnly: true, mutates: false, dangerous: false });
  });

  it('marks POST operations as mutating and not read-only', () => {
    const tools = createToolboxFromOpenAPI(spec);
    const addPet = tools.find((tool) => tool.name === 'add-pet');

    expect(addPet?.metadata).toEqual({ readOnly: false, mutates: true, dangerous: false });
  });

  it('marks DELETE operations as mutating and dangerous', () => {
    const tools = createToolboxFromOpenAPI(spec);
    const deletePet = tools.find((tool) => tool.name === 'delete-pet');

    expect(deletePet?.metadata).toEqual({ readOnly: false, mutates: true, dangerous: true });
  });

  it('kebab-cases an operationId containing spaces', () => {
    const tools = createToolboxFromOpenAPI(spec);

    expect(tools.some((tool) => tool.name === 'find-pet-by-id')).toBe(true);
  });

  it('builds a Zod input schema from query parameters', () => {
    const tools = createToolboxFromOpenAPI(spec);
    const findPets = tools.find((tool) => tool.name === 'find-pets');

    const parsed = findPets?.input.safeParse({ tags: ['dog', 'cat'], limit: 5 });
    expect(parsed?.success).toBe(true);
  });

  it('rejects input that violates the generated schema', () => {
    const tools = createToolboxFromOpenAPI(spec);
    const findPets = tools.find((tool) => tool.name === 'find-pets');

    // `limit` is an integer per the spec; a string should fail schema validation.
    const parsed = findPets?.input.safeParse({ limit: 'not-a-number' });
    expect(parsed?.success).toBe(false);
  });

  it('builds a Zod input schema from a $ref request body, requiring its required fields', () => {
    const tools = createToolboxFromOpenAPI(spec);
    const addPet = tools.find((tool) => tool.name === 'add-pet');

    const missingRequiredName = addPet?.input.safeParse({ body: { tag: 'friendly' } });
    expect(missingRequiredName?.success).toBe(false);

    const valid = addPet?.input.safeParse({ body: { name: 'Rex', tag: 'friendly' } });
    expect(valid?.success).toBe(true);
  });

  it('filters the generated surface via allowOperations as a list', () => {
    const tools = createToolboxFromOpenAPI(spec, { allowOperations: ['findPets', 'addPet'] });

    expect(tools.map((tool) => tool.name).sort()).toEqual(['add-pet', 'find-pets'].sort());
  });

  it('filters the generated surface via allowOperations as a predicate', () => {
    const tools = createToolboxFromOpenAPI(spec, {
      allowOperations: ({ method }) => method === 'get',
    });

    expect(tools.map((tool) => tool.name).sort()).toEqual(['find-pet-by-id', 'find-pets'].sort());
  });

  it('resolves the base URL from spec.servers[0].url by default', async () => {
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: [] });
    const tools = createToolboxFromOpenAPI(spec, { fetch: fakeFetch });
    const findPets = tools.find((tool) => tool.name === 'find-pets');

    await findPets?.execute({});

    expect(calls[0]?.url).toBe('https://petstore.swagger.io/v2/pets');
  });

  it('interpolates path parameters into the request URL', async () => {
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: { id: 1 } });
    const tools = createToolboxFromOpenAPI(spec, { fetch: fakeFetch });
    const findPetById = tools.find((tool) => tool.name === 'find-pet-by-id');

    await findPetById?.execute({ id: 42 });

    expect(calls[0]?.url).toBe('https://petstore.swagger.io/v2/pets/42');
  });

  it('appends query parameters, including arrays, to the request URL', async () => {
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: [] });
    const tools = createToolboxFromOpenAPI(spec, { fetch: fakeFetch });
    const findPets = tools.find((tool) => tool.name === 'find-pets');

    await findPets?.execute({ tags: ['dog', 'cat'], limit: 5 });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.getAll('tags')).toEqual(['dog', 'cat']);
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('sends the request body as JSON with a content-type header', async () => {
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: { id: 1 } });
    const tools = createToolboxFromOpenAPI(spec, { fetch: fakeFetch });
    const addPet = tools.find((tool) => tool.name === 'add-pet');

    await addPet?.execute({ body: { name: 'Rex' } });

    const headers = new Headers(calls[0]?.init?.headers);
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: 'Rex' }));
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('injects a bearer token as an Authorization header', async () => {
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: [] });
    const tools = createToolboxFromOpenAPI(spec, {
      fetch: fakeFetch,
      auth: { type: 'bearer', token: 'secret-token' },
    });
    const findPets = tools.find((tool) => tool.name === 'find-pets');

    await findPets?.execute({});

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-token');
  });

  it('injects an API key as a custom header', async () => {
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: [] });
    const tools = createToolboxFromOpenAPI(spec, {
      fetch: fakeFetch,
      auth: { type: 'api-key', header: 'x-api-key', value: 'my-key' },
    });
    const findPets = tools.find((tool) => tool.name === 'find-pets');

    await findPets?.execute({});

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('x-api-key')).toBe('my-key');
  });

  it('throws when a non-ok response is received', async () => {
    const { fetch: fakeFetch } = createFakeFetch({
      status: 500,
      body: { code: 500, message: 'boom' },
    });
    const tools = createToolboxFromOpenAPI(spec, { fetch: fakeFetch });
    const findPets = tools.find((tool) => tool.name === 'find-pets');

    let caught: unknown;
    try {
      await findPets?.execute({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('throws when a required baseUrl cannot be resolved', () => {
    let caught: unknown;
    try {
      createToolboxFromOpenAPI({ paths: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('composes into a regular armorer toolbox', async () => {
    const { fetch: fakeFetch } = createFakeFetch({ status: 200, body: [] });
    const tools = createToolboxFromOpenAPI(spec, { fetch: fakeFetch });
    const toolbox = createToolbox(tools);

    const result = await toolbox.execute({ id: 'call-1', name: 'find-pets', arguments: {} });
    expect(result.error).toBeUndefined();
    expect(result.toolName).toBe('find-pets');
  });
});
