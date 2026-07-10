import { isStandardSchema, type StandardSchemaV1 } from 'interoperability';
import { z, ZodType } from 'zod';

import { StandardSchemaValidationError } from '../errors';
import type { ResponseFormat } from './types';
import { zodToJsonSchema } from './zod-to-json-schema';

/**
 * Everything `RunOptions.responseSchema` accepts, in order of preference:
 *
 * | Kind                                    | Validation                        | Provider JSON Schema                          |
 * | ---------------------------------------- | ---------------------------------- | ---------------------------------------------- |
 * | Zod schema (documented default)          | `schema.parse()`                   | `zodToJsonSchema(schema)` (automatic)          |
 * | Raw JSON Schema object                   | `z.fromJSONSchema(schema).parse()` | the object itself                              |
 * | Non-Zod Standard Schema (Valibot, ArkType, ...) | `schema['~standard'].validate()` | `RunOptions.responseJsonSchema` if supplied, else `{ type: 'json' }` (no provider-native schema) |
 *
 * A Zod schema satisfies `isStandardSchema` too (Zod v4 implements the spec),
 * so it is always checked first via `instanceof ZodType`.
 */
export type ResponseSchemaInput = ZodType | StandardSchemaV1 | Record<string, unknown>;

export function isZodResponseSchema(schema: ResponseSchemaInput): schema is ZodType {
  return schema instanceof ZodType;
}

/** True for a non-Zod Standard Schema validator — a raw JSON Schema object has no `~standard`. */
export function isNonZodStandardResponseSchema(
  schema: ResponseSchemaInput,
): schema is StandardSchemaV1 {
  return !isZodResponseSchema(schema) && isStandardSchema(schema);
}

export type ResponseSchemaValidationResult =
  | { success: true; value: unknown }
  | { success: false; error: unknown };

/**
 * Validates `input` (the model's parsed structured output) against a
 * {@link ResponseSchemaInput} of any accepted kind. Always async — a
 * Standard Schema validator's `validate()` may itself be async — so callers
 * must `await` even for the (synchronous) Zod and raw-JSON-Schema paths.
 */
export async function validateResponseSchema(
  schema: ResponseSchemaInput,
  input: unknown,
): Promise<ResponseSchemaValidationResult> {
  if (isZodResponseSchema(schema)) {
    try {
      return { success: true, value: schema.parse(input) };
    } catch (error) {
      return { success: false, error };
    }
  }

  if (isNonZodStandardResponseSchema(schema)) {
    const result = await schema['~standard'].validate(input);
    if (result.issues) {
      const issues = result.issues.map((issue) => ({
        message: issue.message,
        path: issue.path?.map((segment) => (typeof segment === 'object' ? segment.key : segment)),
      }));
      return { success: false, error: new StandardSchemaValidationError(issues) };
    }
    return { success: true, value: result.value };
  }

  // Raw JSON Schema object (AB-95) — validated via Zod's own JSON Schema
  // importer, so the same ZodError shape and `schemaRetries` repair loop
  // apply as the native Zod path.
  try {
    const zodSchema = z.fromJSONSchema(schema);
    return { success: true, value: zodSchema.parse(input) };
  } catch (error) {
    return { success: false, error };
  }
}

/**
 * Derives the provider-facing `ResponseFormat` for a {@link ResponseSchemaInput},
 * per the matrix documented on that type. `responseJsonSchema` is the caller-
 * supplied JSON Schema for the "non-Zod Standard Schema" row.
 */
export function resolveResponseFormat(
  schema: ResponseSchemaInput | undefined,
  responseJsonSchema: Record<string, unknown> | undefined,
): ResponseFormat | undefined {
  if (!schema) return undefined;

  if (isZodResponseSchema(schema)) {
    return { type: 'json_schema', schema: zodToJsonSchema(schema), name: 'response' };
  }

  if (isNonZodStandardResponseSchema(schema)) {
    if (responseJsonSchema) {
      return { type: 'json_schema', schema: responseJsonSchema, name: 'response' };
    }
    // No JSON Schema available for an arbitrary Standard Schema validator —
    // fall back to a plain JSON response-format hint. `~standard.validate`
    // still enforces the schema locally via `validateResponseSchema`.
    return { type: 'json' };
  }

  // Raw JSON Schema object — pass it straight through to the provider.
  return { type: 'json_schema', schema, name: 'response' };
}
