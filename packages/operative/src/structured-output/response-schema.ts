import { isJSONValue } from 'interoperability';
import { z, ZodType } from 'zod';

import { NonJsonOutputError, OutputSchemaConversionError, OutputValidationError } from '../errors';
import type { ResponseFormat } from './types';

export type ResponseSchemaValidationResult =
  { success: true; value: unknown } | { success: false; error: unknown };

/**
 * Memoizes {@link toOutputJsonSchema} by schema identity. A `ZodType` is an
 * immutable value once constructed, so `z.toJSONSchema` is pure over it —
 * caching is purely an optimization, never a correctness concern. Load-
 * bearing for the common per-run path: `createAgent`'s synchronous guard,
 * `createActiveRun`'s synchronous guard, and `buildStepDeps` (called once
 * per run, including every retry) each independently derive the SAME
 * schema's JSON Schema; without this, a run pays the conversion cost up to
 * three times for one unchanging schema. A `WeakMap` lets a schema that's
 * no longer referenced elsewhere be collected along with its cached entry.
 */
const jsonSchemaCache = new WeakMap<ZodType<unknown>, Record<string, unknown>>();

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
 */
export function toOutputJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  const cached = jsonSchemaCache.get(schema);
  if (cached) return cached;

  try {
    const converted = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
    const { $schema: _schema, '~standard': _standard, ...rest } = converted;
    jsonSchemaCache.set(schema, rest);
    return rest;
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
export function resolveResponseFormat(
  schema: ZodType<unknown> | undefined,
): ResponseFormat | undefined {
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
 * see `interoperability`'s `assertJSONValue`) BEFORE handing the candidate
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
  schema: ZodType<unknown>,
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
  schema: ZodType<unknown>,
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
