import { z } from 'zod';

import { importToolSchema } from '../../adapters/imported-schema';
import { createTool } from '../../create-tool';
import type { Tool, ToolMetadata } from '../../is-tool';

/** Parameter locations this generator understands. `cookie` parameters are ignored. */
export type OpenAPIParameterLocation = 'path' | 'query' | 'header' | 'cookie';

export type OpenAPIParameter = {
  name: string;
  in: OpenAPIParameterLocation;
  required?: boolean;
  description?: string;
  schema?: unknown;
};

export type OpenAPIRequestBody = {
  required?: boolean;
  description?: string;
  content?: Record<string, { schema?: unknown }>;
};

/** A local `$ref` pointer, e.g. `#/components/parameters/PetId`. */
export type OpenAPIRef = { $ref: string };

export type OpenAPIOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  /** May contain Reference Objects pointing at `#/components/parameters/...`. */
  parameters?: Array<OpenAPIParameter | OpenAPIRef>;
  /** May itself be a Reference Object pointing at `#/components/requestBodies/...`. */
  requestBody?: OpenAPIRequestBody | OpenAPIRef;
};

/** HTTP methods that can appear under an OpenAPI path item. */
export type OpenAPIHttpMethod =
  | 'get'
  | 'put'
  | 'post'
  | 'delete'
  | 'options'
  | 'head'
  | 'patch'
  | 'trace';

export type OpenAPIPathItem = Partial<Record<OpenAPIHttpMethod, OpenAPIOperation>> & {
  /** May contain Reference Objects pointing at `#/components/parameters/...`. */
  parameters?: Array<OpenAPIParameter | OpenAPIRef>;
};

/**
 * Minimal OpenAPI 3.x document surface this generator reads. Unrecognized fields
 * (`info`, `components.responses`, etc.) are ignored rather than rejected, so a real,
 * full spec can be passed in as-is.
 */
export type OpenAPISpec = {
  openapi?: string;
  servers?: Array<{ url: string }>;
  paths?: Record<string, OpenAPIPathItem>;
  components?: { schemas?: Record<string, unknown> };
};

export type OpenAPIBearerAuth = { type: 'bearer'; token: string };
export type OpenAPIApiKeyAuth = { type: 'api-key'; header: string; value: string };
export type OpenAPIAuth = OpenAPIBearerAuth | OpenAPIApiKeyAuth;

export type AllowOperationsPredicate = (operation: {
  operationId: string | undefined;
  method: OpenAPIHttpMethod;
  path: string;
}) => boolean;

export type CreateToolboxFromOpenAPIOptions = {
  /** Base URL requests are resolved against. Defaults to `spec.servers[0].url`. */
  baseUrl?: string;
  /** Injected into every generated request. */
  auth?: OpenAPIAuth;
  /**
   * Restricts the generated surface. Either a list of `operationId`s to include, or a
   * predicate evaluated per operation. Operations without an `operationId` are excluded
   * when a list is given (there is nothing to match against).
   */
  allowOperations?: readonly string[] | AllowOperationsPredicate;
  /** Fetch implementation, injectable for testing. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Prefix applied to every generated tool name, e.g. `'petstore-'`. */
  namePrefix?: string;
  /** Extra tags applied to every generated tool, in addition to `['openapi', <method>]`. */
  tags?: readonly string[];
};

const HTTP_METHODS: readonly OpenAPIHttpMethod[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

const READ_ONLY_METHODS = new Set<OpenAPIHttpMethod>(['get', 'head', 'options', 'trace']);

/**
 * Generates a schema-validated armorer tool for every operation in an OpenAPI 3.x
 * document. Parameter and request-body JSON Schemas become Zod input schemas (reusing
 * {@link importToolSchema}); local `$ref`s are resolved against `spec.components.schemas`
 * before conversion. Each tool's metadata marks `GET`/`HEAD`/`OPTIONS`/`TRACE` operations
 * `readOnly` and the rest `mutates` (with `DELETE` additionally flagged `dangerous`).
 *
 * @example
 * ```typescript
 * import { createToolboxFromOpenAPI } from 'armorer/openapi';
 * import { createToolbox } from 'armorer';
 *
 * const tools = createToolboxFromOpenAPI(spec, {
 *   auth: { type: 'bearer', token: process.env.API_TOKEN! },
 *   allowOperations: ['findPets', 'addPet'],
 * });
 * const toolbox = createToolbox(tools);
 * ```
 */
export function createToolboxFromOpenAPI(
  spec: OpenAPISpec,
  options: CreateToolboxFromOpenAPIOptions = {},
): Tool[] {
  const baseUrl = options.baseUrl ?? spec.servers?.[0]?.url;
  if (!baseUrl) {
    throw new Error(
      'createToolboxFromOpenAPI: no baseUrl was provided and the spec has no servers[0].url',
    );
  }

  const fetchImplementation = options.fetch ?? fetch;
  const paths = spec.paths ?? {};
  const tools: Tool[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      if (!isOperationAllowed(operation, method, path, options.allowOperations)) continue;

      tools.push(
        createOperationTool({
          spec,
          path,
          method,
          operation,
          pathParameters: pathItem.parameters ?? [],
          baseUrl,
          auth: options.auth,
          fetchImplementation,
          namePrefix: options.namePrefix,
          extraTags: options.tags ?? [],
        }),
      );
    }
  }

  return tools;
}

function isOperationAllowed(
  operation: OpenAPIOperation,
  method: OpenAPIHttpMethod,
  path: string,
  allow: CreateToolboxFromOpenAPIOptions['allowOperations'],
): boolean {
  if (!allow) return true;
  if (typeof allow === 'function') {
    return allow({ operationId: operation.operationId, method, path });
  }
  return operation.operationId !== undefined && allow.includes(operation.operationId);
}

type CreateOperationToolOptions = {
  spec: OpenAPISpec;
  path: string;
  method: OpenAPIHttpMethod;
  operation: OpenAPIOperation;
  pathParameters: Array<OpenAPIParameter | OpenAPIRef>;
  baseUrl: string;
  auth: OpenAPIAuth | undefined;
  fetchImplementation: typeof fetch;
  namePrefix: string | undefined;
  extraTags: readonly string[];
};

type OpenAPIToolResult = {
  status: number;
  data: unknown;
};

/** A resolved parameter's wire name (used on the URL/headers) paired with the input-shape
 * key used to read its value out of the tool call's arguments. These differ only when two
 * parameters in different locations share the same `name` (see {@link inputKeyFor}). */
type ParameterKey = { name: string; key: string };

function createOperationTool(options: CreateOperationToolOptions): Tool {
  const {
    spec,
    path,
    method,
    operation,
    pathParameters,
    baseUrl,
    auth,
    fetchImplementation,
    namePrefix,
    extraTags,
  } = options;

  const parameters = mergeParameters(pathParameters, operation.parameters ?? [], spec);
  const toParameterKeys = (location: OpenAPIParameterLocation): ParameterKey[] =>
    parameters
      .filter((p) => p.in === location)
      .map((p) => ({ name: p.name, key: inputKeyFor(p, parameters) }));
  const pathParameterKeys = toParameterKeys('path');
  const queryParameterKeys = toParameterKeys('query');
  const headerParameterKeys = toParameterKeys('header');

  const requestBody = dereferenceRequestBody(operation.requestBody, spec);
  const jsonMediaType = findJsonMediaType(requestBody);
  const jsonRequestBodySchema = jsonMediaType
    ? requestBody?.content?.[jsonMediaType]?.schema
    : undefined;
  const hasRequestBody = jsonRequestBodySchema !== undefined;
  const requestBodyRequired = requestBody?.required ?? false;

  const inputShape: Record<string, z.ZodTypeAny> = {};
  for (const parameter of parameters) {
    if (parameter.in === 'cookie') continue;
    const dereferenced = dereference(parameter.schema, spec);
    let fieldSchema = importToolSchema(dereferenced);
    if (parameter.description) {
      fieldSchema = fieldSchema.describe(parameter.description);
    }
    // Path parameters are always required per the OpenAPI spec (and required for URL
    // interpolation below), regardless of whether the document sets `required: true`.
    const isRequired = parameter.in === 'path' || parameter.required === true;
    const key = inputKeyFor(parameter, parameters);
    inputShape[key] = isRequired ? fieldSchema : fieldSchema.optional();
  }
  if (hasRequestBody) {
    const dereferenced = dereference(jsonRequestBodySchema, spec);
    let bodySchema = importToolSchema(dereferenced);
    if (requestBody?.description) {
      bodySchema = bodySchema.describe(requestBody.description);
    }
    inputShape['body'] = requestBodyRequired ? bodySchema : bodySchema.optional();
  }

  const name = toToolName(operation.operationId, method, path, namePrefix);
  const description =
    operation.description ?? operation.summary ?? `${method.toUpperCase()} ${path}`;

  const createOptions: Parameters<typeof createTool>[0] = {
    name,
    description,
    input: z.object(inputShape),
    tags: ['openapi', method, ...extraTags],
    metadata: metadataForMethod(method),
    async execute(params) {
      const record = isRecord(params) ? params : {};
      const url = buildRequestUrl(baseUrl, path, pathParameterKeys, record);
      for (const queryParameter of queryParameterKeys) {
        appendQueryParameter(url, queryParameter.name, record[queryParameter.key]);
      }

      const headers: Record<string, string> = {};
      for (const headerParameter of headerParameterKeys) {
        const value = record[headerParameter.key];
        if (value !== undefined) {
          headers[headerParameter.name] = toParameterString(value);
        }
      }
      applyAuth(headers, auth);

      let body: string | undefined;
      if (hasRequestBody && record['body'] !== undefined) {
        headers['content-type'] = jsonMediaType ?? 'application/json';
        body = JSON.stringify(record['body']);
      }

      const response = await fetchImplementation(url.toString(), {
        method: method.toUpperCase(),
        headers,
        ...(body !== undefined ? { body } : {}),
      });

      const result: OpenAPIToolResult = {
        status: response.status,
        data: await parseResponseBody(response),
      };

      if (!response.ok) {
        throw new Error(`OpenAPI operation "${name}" failed with status ${response.status}`);
      }

      return result;
    },
  };

  return createTool(createOptions) as Tool;
}

function mergeParameters(
  pathParameters: Array<OpenAPIParameter | OpenAPIRef>,
  operationParameters: Array<OpenAPIParameter | OpenAPIRef>,
  spec: OpenAPISpec,
): OpenAPIParameter[] {
  const merged = new Map<string, OpenAPIParameter>();
  for (const parameter of pathParameters) {
    const resolved = dereferenceParameter(parameter, spec);
    merged.set(`${resolved.in}:${resolved.name}`, resolved);
  }
  for (const parameter of operationParameters) {
    const resolved = dereferenceParameter(parameter, spec);
    merged.set(`${resolved.in}:${resolved.name}`, resolved);
  }
  return [...merged.values()];
}

/**
 * Resolves a Parameter Object that may itself be a `$ref` (e.g. `#/components/parameters/PetId`)
 * before its `.in`/`.name`/`.schema` fields are read. The result is trusted to be shaped like
 * {@link OpenAPIParameter} because that is the structural contract of a Parameter Object at the
 * pointed-to location in a spec-compliant document; {@link dereference} already resolves nested
 * `$ref`s (e.g. inside `.schema`) and fails fast on an unresolvable pointer.
 */
function dereferenceParameter(
  parameter: OpenAPIParameter | OpenAPIRef,
  spec: OpenAPISpec,
): OpenAPIParameter {
  return dereference(parameter, spec) as OpenAPIParameter;
}

/**
 * Resolves a Request Body Object that may itself be a `$ref` (e.g.
 * `#/components/requestBodies/Pet`). See {@link dereferenceParameter} for the trust rationale.
 */
function dereferenceRequestBody(
  requestBody: OpenAPIRequestBody | OpenAPIRef | undefined,
  spec: OpenAPISpec,
): OpenAPIRequestBody | undefined {
  if (requestBody === undefined) return undefined;
  return dereference(requestBody, spec) as OpenAPIRequestBody;
}

/**
 * Finds the first request-body media type that is JSON or JSON-compatible: the exact
 * `application/json` key, or any `+json` structured-syntax suffix (e.g.
 * `application/merge-patch+json`, `application/vnd.api+json`).
 */
function findJsonMediaType(requestBody: OpenAPIRequestBody | undefined): string | undefined {
  const content = requestBody?.content;
  if (!content) return undefined;
  return Object.keys(content).find((key) => key === 'application/json' || key.endsWith('+json'));
}

/**
 * Computes the input-shape key for a parameter. Parameters are keyed by their bare `name` in
 * the common case; when two parameters in different locations share the same `name` (legal per
 * OpenAPI, which scopes uniqueness to `(name, in)`), each is suffixed with its location so both
 * remain independently addressable, e.g. a `version` query parameter and a `version` header
 * parameter become `version` and `versionHeader`. The first-seen location keeps the bare name so
 * the common, non-colliding case is unaffected.
 */
function inputKeyFor(parameter: OpenAPIParameter, allParameters: OpenAPIParameter[]): string {
  const sameName = allParameters.filter((p) => p.in !== 'cookie' && p.name === parameter.name);
  if (sameName.length <= 1) return parameter.name;
  const firstLocation = sameName[0]?.in;
  if (parameter.in === firstLocation) return parameter.name;
  return `${parameter.name}${capitalize(parameter.in)}`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function metadataForMethod(method: OpenAPIHttpMethod): ToolMetadata {
  if (READ_ONLY_METHODS.has(method)) {
    return { readOnly: true, mutates: false, dangerous: false };
  }
  return { readOnly: false, mutates: true, dangerous: method === 'delete' };
}

function toToolName(
  operationId: string | undefined,
  method: OpenAPIHttpMethod,
  path: string,
  prefix: string | undefined,
): string {
  const base = operationId ? toKebabCase(operationId) : toKebabCase(`${method}-${path}`);
  return prefix ? `${prefix}${base}` : base;
}

function toKebabCase(input: string): string {
  return input
    .replace(/[{}]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function applyAuth(headers: Record<string, string>, auth: OpenAPIAuth | undefined): void {
  if (!auth) return;
  if (auth.type === 'bearer') {
    headers['authorization'] = `Bearer ${auth.token}`;
  } else {
    headers[auth.header] = auth.value;
  }
}

function buildRequestUrl(
  baseUrl: string,
  path: string,
  pathParameters: readonly ParameterKey[],
  params: Record<string, unknown>,
): URL {
  let interpolated = path;
  for (const { name, key } of pathParameters) {
    const value = params[key];
    interpolated = interpolated.replaceAll(
      `{${name}}`,
      encodeURIComponent(toParameterString(value)),
    );
  }
  return new URL(joinUrl(baseUrl, interpolated));
}

function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${normalizedPath}`;
}

function appendQueryParameter(url: URL, name: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      url.searchParams.append(name, toParameterString(item));
    }
    return;
  }
  url.searchParams.set(name, toParameterString(value));
}

/**
 * Stringifies a path/query/header parameter value for the wire. Primitives use their
 * natural string form; objects and arrays (uncommon for these positions, but not
 * disallowed by the schema) are JSON-encoded rather than falling through to
 * `Object`'s `[object Object]` default.
 */
function toParameterString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return JSON.parse(text) as unknown;
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recursively resolves local `$ref` pointers (e.g. `#/components/schemas/...`,
 * `#/components/parameters/...`, `#/components/requestBodies/...`) against `root`. Used both on
 * parameter/request-body *schemas* (returning a plain JSON Schema object suitable for
 * {@link importToolSchema}) and on whole Parameter/Request Body Objects that may themselves be
 * `$ref`s. Both directly drive generated tool input validation, so an unresolvable `$ref` throws
 * rather than silently degrading to an unvalidated `z.unknown()` field. A pointer that refers
 * back to a value already on the current resolution path (a recursive schema, e.g. a tree-shaped
 * `Node`) resolves to `{}` at the cycle point instead of recursing forever — recursive JSON
 * Schemas are legitimate and Zod has no direct equivalent.
 */
function dereference(value: unknown, root: OpenAPISpec, seen: Set<unknown> = new Set()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => dereference(item, root, seen));
  }
  if (isRecord(value)) {
    const ref = value['$ref'];
    if (typeof ref === 'string') {
      if (seen.has(value)) return {};
      const resolved = resolveRef(ref, root);
      const nextSeen = new Set(seen);
      nextSeen.add(value);
      return dereference(resolved, root, nextSeen);
    }
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = dereference(nested, root, seen);
    }
    return result;
  }
  return value;
}

function resolveRef(ref: string, root: OpenAPISpec): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`createToolboxFromOpenAPI: cannot resolve non-local $ref "${ref}"`);
  }
  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      throw new Error(`createToolboxFromOpenAPI: unresolved $ref "${ref}"`);
    }
    current = current[segment];
  }
  return current;
}
