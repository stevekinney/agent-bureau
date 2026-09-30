import { isJSONValue } from '@lostgradient/tool-protocol';
import { z, ZodType } from 'zod';

import { NonJsonOutputError, OutputSchemaConversionError, OutputValidationError } from '../errors';
import type { ResponseFormat } from './types';

export type ResponseSchemaValidationResult =
  { success: true; value: unknown } | { success: false; error: unknown };

/**
 * Memoizes {@link toOutputJsonSchema} by schema identity. A `ZodType` is an
 * immutable value once constructed, so `z.toJSONSchema` is pure over it —
 * caching is purely an optimization, never a correctness concern (callers
 * receive a deep copy of the cached value, so mutating it is safe). Load-
 * bearing for the common per-run path: `createAgent`'s synchronous guard,
 * `createActiveRun`'s synchronous guard, and `buildStepDeps` (called once
 * per run, including every retry) each independently derive the SAME
 * schema's JSON Schema; without this, a run pays the conversion cost up to
 * three times for one unchanging schema. A `WeakMap` lets a schema that's
 * no longer referenced elsewhere be collected along with its cached entry.
 */
const jsonSchemaCache = new WeakMap<ZodType, Record<string, unknown>>();

/**
 * Converts a run's `output` Zod schema to the JSON Schema shape providers
 * expect, via Zod v4's built-in `toJSONSchema`. `io: 'input'` — the schema
 * describes what the MODEL must produce (the schema's input side), not what
 * a caller gets back after any `.transform()`s run.
 *
 * Synchronous, and throws {@link OutputSchemaConversionError} for an
 * unrepresentable schema (AB-18) — there is no generic-object fallback. A
 * schema that can't become a JSON Schema is an authoring error to fix, not
 * something to silently degrade.
 *
 * Strict-mode note: Zod's `io: 'input'` output for `z.object()` omits
 * `additionalProperties: false`, so ordinary schemas do NOT satisfy
 * {@link isStrictCompatible}, and `toOpenAIResponseFormat` sends
 * `strict: false` for them. That is the expected steady state, not a defect:
 * OpenAI's non-strict `json_schema` mode still constrains the output, and only
 * a schema meeting OpenAI's strict contract gets `strict: true`.
 */
export function toOutputJsonSchema(schema: ZodType): Record<string, unknown> {
  // The cache holds a private master copy; every caller receives a fresh deep
  // copy so mutating a returned schema (at any depth) can never corrupt the
  // cache or another caller's schema.
  const cached = jsonSchemaCache.get(schema);
  if (cached) return structuredClone(cached);

  try {
    const converted = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
    const { $schema: _schema, '~standard': _standard, ...rest } = converted;
    // Zod emits primitive unions as a JSON Schema `type` array. Providers and
    // callers consume the more explicit `anyOf` form consistently with
    // unions containing object schemas.
    if (Array.isArray(rest['type'])) {
      const { type: types, ...withoutType } = rest;
      const normalized = { ...withoutType, anyOf: types.map((type) => ({ type })) };
      jsonSchemaCache.set(schema, normalized);
      return structuredClone(normalized);
    }
    jsonSchemaCache.set(schema, rest);
    return structuredClone(rest);
  } catch (error) {
    throw new OutputSchemaConversionError(error);
  }
}

/**
 * Derives the provider-facing `ResponseFormat` for a run's `output` Zod
 * schema. `undefined` when the run has no `output` schema — the run then
 * gets no `ResponseFormat` hint and providers fall back to their default
 * (free-form text).
 */
export function resolveResponseFormat(schema: ZodType | undefined): ResponseFormat | undefined {
  if (!schema) return undefined;
  return { type: 'json_schema', schema: toOutputJsonSchema(schema), name: 'response' };
}

/**
 * Validates an already-parsed candidate against a run's `output` Zod schema
 * (AB-18) — the entry point for a caller that HOLDS a decoded value rather
 * than raw text (a durable checkpoint's persisted `output: JSONValue`, or a
 * provider whose native structured-output mode returns a decoded object
 * instead of a JSON string). Enforces the recursive {@link isJSONValue}
 * contract (finite numbers, dense arrays, no cycles, no exotic objects —
 * see `@lostgradient/tool-protocol`'s `assertJSONValue`) BEFORE handing the candidate
 * to the schema: a candidate that fails it is a {@link NonJsonOutputError},
 * since it did not describe a value JSON can even represent. A candidate
 * that passes but fails the schema is an {@link OutputValidationError}.
 *
 * {@link validateOutput} (the `text: string` entry point) delegates here
 * for its JSON-parsed branch — `JSON.parse`'s own output always satisfies
 * `isJSONValue` by construction (the JSON grammar has no token for a
 * `Date`, `Map`, `Set`, `bigint`, `undefined`, a sparse hole, or a
 * back-reference), so that call site never actually fails this check; it
 * is callers reaching this function directly with a value that did NOT
 * come from `JSON.parse` where the check is load-bearing.
 */
export async function validateOutputValue(
  schema: ZodType,
  candidate: unknown,
): Promise<ResponseSchemaValidationResult> {
  if (!isJSONValue(candidate)) {
    return {
      success: false,
      error: new NonJsonOutputError(safeDescribe(candidate)),
    };
  }

  try {
    const value = await schema.parseAsync(candidate);
    return { success: true, value };
  } catch (error) {
    return { success: false, error: new OutputValidationError(error) };
  }
}

function safeDescribe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Validates a run's final text against its `output` Zod schema (AB-18).
 *
 * When `text` is valid JSON, the parsed value is delegated to
 * {@link validateOutputValue} — a schema mismatch there is an
 * {@link OutputValidationError}. When `text` is NOT valid JSON, the raw
 * string itself is validated against the schema directly (so a schema of
 * exactly `z.string()` can still succeed) — a mismatch there is a
 * {@link NonJsonOutputError}, since the underlying cause is that the model
 * didn't return JSON at all.
 *
 * Each candidate is parsed with `schema.parseAsync` exactly once; a retry
 * (driven by the caller re-invoking this on new text) validates the NEW
 * candidate again, never the same one twice.
 */
export async function validateOutput(
  schema: ZodType,
  text: string,
): Promise<ResponseSchemaValidationResult> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    try {
      const value = await schema.parseAsync(text);
      return { success: true, value };
    } catch (error) {
      return { success: false, error: new NonJsonOutputError(text, error) };
    }
  }

  return validateOutputValue(schema, candidate);
}

const STRICT_FORBIDDEN_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'allOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'patternProperties',
  'prefixItems',
  'contains',
  'propertyNames',
  'additionalItems',
  'unevaluatedItems',
  'unevaluatedProperties',
  'dependencies',
  '$dynamicRef',
  '$recursiveRef',
]);

/**
 * Keywords the strict walker understands or that carry inert data (their values
 * are never schemas). Any other keyword holding an object or an array of
 * objects may hide a subschema the walker does not visit, so it fails closed.
 */
const STRICT_KNOWN_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  '$defs',
  'definitions',
  'enum',
  'const',
  'default',
  'examples',
  'example',
  'description',
  'title',
  'nullable',
  '$schema',
  '$id',
  '$comment',
]);

/** Keywords whose value is a map of name to subschema. */
const SUBSCHEMA_MAP_KEYWORDS = ['properties', '$defs', 'definitions'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrictNode(node: unknown): boolean {
  if (!isPlainRecord(node)) return false;
  for (const keyword of Object.keys(node)) {
    if (STRICT_FORBIDDEN_KEYWORDS.has(keyword)) return false;
  }

  for (const [keyword, value] of Object.entries(node)) {
    if (STRICT_KNOWN_KEYWORDS.has(keyword)) continue;
    if (isPlainRecord(value)) return false;
    if (Array.isArray(value) && value.some(isPlainRecord)) return false;
  }

  if (
    node['type'] === undefined &&
    node['anyOf'] === undefined &&
    node['enum'] === undefined &&
    node['const'] === undefined
  ) {
    return false;
  }

  if (node['additionalProperties'] !== undefined && node['additionalProperties'] !== false) {
    return false;
  }

  const type = node['type'];
  const isObjectType = type === 'object' || (Array.isArray(type) && type.includes('object'));
  const properties = node['properties'];
  if (isObjectType || properties !== undefined) {
    if (node['additionalProperties'] !== false) return false;
    const required = node['required'];
    const requiredNames = Array.isArray(required) ? required : [];
    if (isPlainRecord(properties)) {
      for (const name of Object.keys(properties)) {
        if (!requiredNames.includes(name)) return false;
      }
    }
  }

  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const map = node[keyword];
    if (map === undefined) continue;
    if (!isPlainRecord(map)) return false;
    for (const child of Object.values(map)) {
      if (!isStrictNode(child)) return false;
    }
  }

  const items = node['items'];
  if (items !== undefined && !isStrictNode(items)) return false;

  const anyOf = node['anyOf'];
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf)) return false;
    for (const child of anyOf) {
      if (!isStrictNode(child)) return false;
    }
  }
  return true;
}

/**
 * Whether a JSON Schema satisfies OpenAI's structured-outputs strict-mode
 * contract, so `strict: true` can be requested without the API rejecting the
 * schema: every object sets `additionalProperties: false` and lists every
 * property in `required`; the root is an object; no per-type validation keywords; only `anyOf`
 * composition; and no `$ref` (reference resolution is deliberately not
 * attempted, so a schema containing one is reported incompatible).
 *
 * Property NAMES that collide with keywords (a property called `pattern`) are
 * not violations: only schema positions are inspected.
 */
export function isStrictCompatible(schema: Record<string, unknown>): boolean {
  if (!isPlainRecord(schema)) return false;
  const type = schema['type'];
  const rootIsObject = type === 'object' || (Array.isArray(type) && type.includes('object'));
  if (!rootIsObject) return false;
  return isStrictNode(schema);
}
