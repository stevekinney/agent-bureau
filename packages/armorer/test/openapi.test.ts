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
    const bodyText =
      typeof response.body === 'string' && response.contentType !== 'application/json'
        ? response.body
        : response.body !== undefined
          ? JSON.stringify(response.body)
          : '';
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

  it('treats a path parameter as required even when the spec omits `required: true`', () => {
    const specWithLaxPathParameter: OpenAPISpec = {
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/widgets/{id}': {
          get: {
            operationId: 'getWidget',
            parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
          },
        },
      },
    };
    const tools = createToolboxFromOpenAPI(specWithLaxPathParameter);
    const getWidget = tools.find((tool) => tool.name === 'get-widget');

    expect(getWidget?.input.safeParse({}).success).toBe(false);
    expect(getWidget?.input.safeParse({ id: 'abc' }).success).toBe(true);
  });

  it('interpolates every occurrence of a path parameter that appears more than once', async () => {
    const specWithRepeatedPathParameter: OpenAPISpec = {
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/widgets/{id}/related/{id}': {
          get: {
            operationId: 'getRelatedWidget',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          },
        },
      },
    };
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: {} });
    const tools = createToolboxFromOpenAPI(specWithRepeatedPathParameter, { fetch: fakeFetch });
    const getRelatedWidget = tools.find((tool) => tool.name === 'get-related-widget');

    await getRelatedWidget?.execute({ id: '42' });

    expect(calls[0]?.url).toBe('https://example.test/widgets/42/related/42');
  });

  it('throws instead of silently degrading to an unvalidated schema when a $ref cannot be resolved', () => {
    const specWithBrokenRef: OpenAPISpec = {
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/widgets': {
          post: {
            operationId: 'createWidget',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DoesNotExist' },
                },
              },
            },
          },
        },
      },
    };

    let caught: unknown;
    try {
      createToolboxFromOpenAPI(specWithBrokenRef);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('rejects non-local $refs', () => {
    const specification = {
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/widgets': {
          post: {
            operationId: 'createWidget',
            requestBody: {
              content: {
                'application/json': { schema: { $ref: 'https://example.test/widget.json' } },
              },
            },
          },
        },
      },
    } as OpenAPISpec;

    expect(() => createToolboxFromOpenAPI(specification)).toThrow('cannot resolve non-local $ref');
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

  it('serializes null and object query parameters without implicit object coercion', async () => {
    const specification: OpenAPISpec = {
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/widgets': {
          get: {
            operationId: 'findWidgets',
            parameters: [
              { name: 'nullable', in: 'query', schema: {} },
              { name: 'filter', in: 'query', schema: {} },
            ],
          },
        },
      },
    };
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: [] });
    const [findWidgets] = createToolboxFromOpenAPI(specification, { fetch: fakeFetch });

    await findWidgets?.execute({ nullable: null, filter: { status: 'active' } });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('nullable')).toBe('');
    expect(url.searchParams.get('filter')).toBe('{"status":"active"}');
  });

  it('returns non-JSON response bodies as text', async () => {
    const { fetch: fakeFetch } = createFakeFetch({
      status: 200,
      body: 'plain response',
      contentType: 'text/plain',
    });
    const tools = createToolboxFromOpenAPI(spec, { fetch: fakeFetch });
    const findPets = tools.find((tool) => tool.name === 'find-pets');

    await expect(findPets?.execute({})).resolves.toEqual({ status: 200, data: 'plain response' });
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

  it('resolves a $ref parameter before reading its `in`/`name`/`schema` fields', async () => {
    const specWithRefParameter = {
      servers: [{ url: 'https://example.test' }],
      // `components.parameters` isn't part of the narrow `OpenAPISpec` type this generator
      // declares, but it's exactly what a real spec's `$ref` points at.
      components: {
        parameters: {
          WidgetId: { name: 'id', in: 'path', schema: { type: 'string' } },
        },
      },
      paths: {
        '/widgets/{id}': {
          parameters: [{ $ref: '#/components/parameters/WidgetId' }],
          get: { operationId: 'getWidget' },
        },
      },
    } as unknown as OpenAPISpec;

    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: {} });
    const tools = createToolboxFromOpenAPI(specWithRefParameter, { fetch: fakeFetch });
    const getWidget = tools.find((tool) => tool.name === 'get-widget');

    // The path parameter must be recognized as required (proves `.in`/`.name` were read from
    // the resolved parameter, not the unresolved `$ref` wrapper).
    expect(getWidget?.input.safeParse({}).success).toBe(false);
    expect(getWidget?.input.safeParse({ id: 'abc' }).success).toBe(true);

    await getWidget?.execute({ id: 'abc' });
    expect(calls[0]?.url).toBe('https://example.test/widgets/abc');
  });

  it('resolves a $ref request body before reading its content', async () => {
    const specWithRefBody = {
      servers: [{ url: 'https://example.test' }],
      components: {
        requestBodies: {
          Widget: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
      paths: {
        '/widgets': {
          post: {
            operationId: 'createWidget',
            requestBody: { $ref: '#/components/requestBodies/Widget' },
          },
        },
      },
    } as unknown as OpenAPISpec;

    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: {} });
    const tools = createToolboxFromOpenAPI(specWithRefBody, { fetch: fakeFetch });
    const createWidget = tools.find((tool) => tool.name === 'create-widget');

    expect(createWidget?.input.safeParse({}).success).toBe(false);

    await createWidget?.execute({ body: { name: 'gizmo' } });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: 'gizmo' }));
  });

  it('accepts a JSON-compatible request body media type other than application/json', async () => {
    const specWithMergePatch: OpenAPISpec = {
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/widgets/{id}': {
          patch: {
            operationId: 'patchWidget',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: {
              required: true,
              content: { 'application/merge-patch+json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    };
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: {} });
    const tools = createToolboxFromOpenAPI(specWithMergePatch, { fetch: fakeFetch });
    const patchWidget = tools.find((tool) => tool.name === 'patch-widget');

    expect(patchWidget?.input.safeParse({}).success).toBe(false);

    await patchWidget?.execute({ id: '1', body: { name: 'gizmo' } });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: 'gizmo' }));
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('content-type')).toBe('application/merge-patch+json');
  });

  it('disambiguates same-named parameters in different locations', async () => {
    const specWithCollidingNames: OpenAPISpec = {
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/widgets': {
          get: {
            operationId: 'listWidgets',
            parameters: [
              { name: 'version', in: 'query', schema: { type: 'string' } },
              { name: 'version', in: 'header', schema: { type: 'string' } },
            ],
          },
        },
      },
    };
    const { fetch: fakeFetch, calls } = createFakeFetch({ status: 200, body: [] });
    const tools = createToolboxFromOpenAPI(specWithCollidingNames, { fetch: fakeFetch });
    const listWidgets = tools.find((tool) => tool.name === 'list-widgets');

    await listWidgets?.execute({ version: 'v1', versionHeader: 'v2' });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('version')).toBe('v1');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('version')).toBe('v2');
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
