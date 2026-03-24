import { z } from 'zod';

import { isZodObjectSchema, isZodSchema } from '../core/schema-utilities';
import type { ToolParametersSchema } from '../is-tool';

/**
 * Normalizes a schema input into a `z.ZodTypeAny`:
 * - `undefined` becomes `z.object({})`
 * - A ZodObject is passed through
 * - A plain object of Zod schemas is wrapped with `z.object()`
 * - A non-object Zod schema (e.g. `z.string()`) throws
 * - Anything else throws
 */
export function normalizeSchema(schema: unknown): ToolParametersSchema {
  if (schema === undefined) {
    return z.object({});
  }
  if (isZodObjectSchema(schema)) {
    return schema;
  }
  if (isZodSchema(schema)) {
    throw new Error('Tool input must be a Zod object schema');
  }
  if (schema && typeof schema === 'object') {
    return z.object(schema as Record<string, z.ZodTypeAny>);
  }
  throw new Error('Tool input must be a Zod object schema or an object of Zod schemas');
}
