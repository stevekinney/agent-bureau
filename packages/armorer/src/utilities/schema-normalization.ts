import { isStandardSchema } from 'interoperability';
import { z } from 'zod';

import {
  isWrappedStandardSchema,
  isZodObjectSchema,
  isZodSchema,
  wrapStandardSchema,
} from '../core/schema-utilities';
import type { ToolParametersSchema } from '../is-tool';

/**
 * Normalizes a schema input into a `z.ZodTypeAny`:
 * - `undefined` becomes `z.object({})`
 * - A schema already produced by {@link wrapStandardSchema} passes through
 *   unchanged (idempotent: re-registering a `Tool` through `createToolbox`
 *   re-normalizes `tool.configuration.input`, which for a Standard Schema
 *   tool is already the wrapped pipe)
 * - A ZodObject is passed through
 * - A plain object of Zod schemas is wrapped with `z.object()`
 * - A non-object Zod schema (e.g. `z.string()`) throws
 * - A non-Zod Standard Schema validator (Valibot, ArkType, ...) is wrapped via
 *   {@link wrapStandardSchema} so it flows through the same `z.ZodTypeAny`
 *   pipeline as every other tool schema
 * - Anything else throws
 */
export function normalizeSchema(schema: unknown): ToolParametersSchema {
  if (schema === undefined) {
    return z.object({});
  }
  if (isWrappedStandardSchema(schema)) {
    return schema as ToolParametersSchema;
  }
  if (isZodObjectSchema(schema)) {
    return schema;
  }
  if (isZodSchema(schema)) {
    throw new Error('Tool input must be a Zod object schema');
  }
  if (isStandardSchema(schema)) {
    return wrapStandardSchema(schema);
  }
  if (schema && typeof schema === 'object') {
    return z.object(schema as Record<string, z.ZodTypeAny>);
  }
  throw new Error('Tool input must be a Zod object schema or an object of Zod schemas');
}
