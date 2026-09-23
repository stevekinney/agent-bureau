import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

import {
  isStandardSchema,
  isWrappedStandardSchema,
  isZodObjectSchema,
  isZodSchema,
  wrapStandardSchema,
} from '../core/schema-utilities';
import type { InferSchemaInput, SchemaInput } from '../create-tool/options';

/**
 * Normalizes a schema input into a `z.ZodType`:
 * - `undefined` becomes `z.object({})`
 * - A schema already produced by {@link wrapStandardSchema} passes through
 *   unchanged (idempotent: re-registering a `Tool` through `createToolbox`
 *   re-normalizes `tool.configuration.input`, which for a Standard Schema
 *   tool is already the wrapped pipe)
 * - A ZodObject is passed through
 * - A plain object of Zod schemas is wrapped with `z.object()`
 * - A non-object Zod schema (e.g. `z.string()`) throws
 * - A non-Zod Standard Schema validator (Valibot, ArkType, ...) is wrapped via
 *   {@link wrapStandardSchema} so it flows through the same `z.ZodType`
 *   pipeline as every other tool schema
 * - Anything else throws
 */
export function normalizeSchema<Output>(
  schema: z.ZodType<Output> | StandardSchemaV1<unknown, Output>,
): z.ZodType<Output>;
export function normalizeSchema<Shape extends z.ZodRawShape>(schema: Shape): z.ZodObject<Shape>;
export function normalizeSchema(schema: undefined): z.ZodObject<{}>;
export function normalizeSchema(schema: unknown): z.ZodType;
export function normalizeSchema(schema: unknown): z.ZodType {
  if (schema === undefined) {
    return z.object({});
  }
  if (isZodSchema(schema)) {
    if (isWrappedStandardSchema(schema) || isZodObjectSchema(schema)) return schema;
    throw new Error('Tool input must be a Zod object schema');
  }
  if (isStandardSchema(schema)) {
    return wrapStandardSchema(schema);
  }
  if (isZodRawShape(schema)) return z.object(schema);
  throw new Error('Tool input must be a Zod object schema or an object of Zod schemas');
}

/** Normalizes the factory's schema input while preserving its validated input type. */
export function normalizeToolSchema<TSchema extends SchemaInput | undefined>(
  schema: TSchema,
): z.ZodType<InferSchemaInput<TSchema>>;
export function normalizeToolSchema(schema: unknown): z.ZodType {
  return schema === undefined ? z.object({}) : normalizeSchema(schema);
}

function isZodRawShape(value: unknown): value is z.ZodRawShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((field) => field instanceof z.ZodType);
}
