/**
 * Schema utilities for working with Zod schema internals.
 * These utilities intentionally work with untyped Zod internals (_def, shape, etc.)
 * which requires permissive type handling.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export type ToolSchema = z.ZodType;

/**
 * Internal marker set on the schema returned by {@link wrapStandardSchema} so
 * `normalizeSchema` can recognize an already-wrapped Standard Schema and pass
 * it through unchanged instead of re-wrapping (which would produce a nested
 * `z.any().transform(...)` pipe) or rejecting it as "not a Zod object schema"
 * (it isn't one — it's a transform pipe, by design). This makes
 * `normalizeSchema` idempotent for wrapped Standard Schema tools, which
 * matters when a `Tool` built by `createTool` is re-registered through
 * `createToolbox([tool])` — `tool.configuration.input` is already the
 * wrapped pipe, and toolbox registration normalizes it again.
 */
const WRAPPED_STANDARD_SCHEMA = Symbol('armorer.wrappedStandardSchema');

/** Returns whether a value exposes a valid Standard Schema V1 contract. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== 'object' || value === null || !('~standard' in value)) return false;
  const properties: unknown = value['~standard'];
  return (
    typeof properties === 'object' &&
    properties !== null &&
    'version' in properties &&
    properties.version === 1 &&
    'vendor' in properties &&
    typeof properties.vendor === 'string' &&
    'validate' in properties &&
    typeof properties.validate === 'function'
  );
}

/**
 * Wraps a non-Zod Standard Schema validator (Valibot, ArkType, ...) as a
 * `z.ZodType` so it flows through the rest of the tool pipeline —
 * execution, error classification, diagnostics — unchanged. Implemented as a
 * `transform` (not a `refine`) so the validator's OUTPUT (post-coercion,
 * post-default) reaches `execute()`, not the raw input.
 *
 * Validation failures raise a real `z.ZodError` (via `ctx.addIssue`), so
 * `error instanceof z.ZodError` still holds for callers that branch on it.
 * Because the check is async, callers MUST use `parseAsync`/`safeParseAsync`
 * on the wrapped schema — `parse`/`safeParse` throw for async refinements.
 *
 * JSON Schema generation is NOT covered here: `z.toJSONSchema` cannot
 * represent an arbitrary external validator, so callers must supply a JSON
 * Schema alongside (see `CreateToolOptions.inputSchema`).
 */
export function wrapStandardSchema<Output>(
  schema: StandardSchemaV1<unknown, Output>,
): z.ZodType<Output> {
  const wrapped = z.unknown().transform(async (value, ctx) => {
    const result = await schema['~standard'].validate(value);
    if (result.issues) {
      for (const issue of result.issues) {
        ctx.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path?.map((segment) => (typeof segment === 'object' ? segment.key : segment)),
        });
      }
      return z.NEVER;
    }
    return result.value;
  });
  Object.defineProperty(wrapped, WRAPPED_STANDARD_SCHEMA, { value: true, enumerable: false });
  return wrapped;
}

/**
 * Whether `value` is a schema previously returned by {@link wrapStandardSchema}.
 * Used by `normalizeSchema` to avoid re-wrapping or rejecting an
 * already-wrapped Standard Schema tool re-registered through a toolbox.
 */
export function isWrappedStandardSchema(value: unknown): boolean {
  return Boolean(
    value && typeof value === 'object' && Reflect.get(value, WRAPPED_STANDARD_SCHEMA) === true,
  );
}

type ZodShape = Record<string, unknown>;

type ZodSchemaLike = object;

export function getSchemaKeys(schema: ToolSchema): string[] {
  const shape = getSchemaShape(schema);
  return shape ? Object.keys(shape) : [];
}

export function getSchemaShape(schema: ToolSchema): Record<string, unknown> | undefined {
  const candidate = unwrapSchema(schema);
  if (!candidate) return undefined;
  return resolveShape(getShapeProperty(candidate)) ?? resolveShape(getDefinitionShape(candidate));
}

export function unwrapSchema(schema: ToolSchema): ZodSchemaLike | undefined {
  let current: unknown = schema;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const candidate = asSchemaLike(current);
    if (!candidate) return undefined;
    if (hasShape(candidate)) return candidate;
    const next = getWrappedSchema(candidate);
    if (next === undefined) return candidate;
    current = next;
  }
  return asSchemaLike(current);
}

function hasShape(candidate: ZodSchemaLike): boolean {
  return getDefinitionShape(candidate) !== undefined || getShapeProperty(candidate) !== undefined;
}

function getWrappedSchema(candidate: ZodSchemaLike): unknown {
  return (
    getDefinitionProperty(candidate, 'innerType') ??
    getDefinitionProperty(candidate, 'schema') ??
    getNestedProperty(getProperty(candidate, 'def'), 'out')
  );
}

function getShapeProperty(candidate: ZodSchemaLike): ZodShape | (() => ZodShape) | undefined {
  return shapeValue(getProperty(candidate, 'shape'));
}

function getDefinitionShape(candidate: ZodSchemaLike): ZodShape | (() => ZodShape) | undefined {
  return shapeValue(getDefinitionProperty(candidate, 'shape'));
}

function getDefinitionProperty(candidate: ZodSchemaLike, key: string): unknown {
  return getNestedProperty(getProperty(candidate, '_def'), key);
}

function getNestedProperty(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

function getProperty(value: object, key: string | symbol): unknown {
  return Reflect.get(value, key);
}

function shapeValue(value: unknown): ZodShape | (() => ZodShape) | undefined {
  if (isRecord(value)) return value;
  return isShapeFunction(value) ? value : undefined;
}

function isShapeFunction(value: unknown): value is () => ZodShape {
  return typeof value === 'function';
}

export function schemasLooselyMatch(target: ToolSchema, incoming: ToolSchema): boolean {
  const targetShape = getSchemaShape(target);
  const checkShape = getSchemaShape(incoming);
  if (!targetShape || !checkShape) return false;
  const keys = Object.keys(checkShape);
  if (!keys.length) return true;
  return keys.every((key) => key in targetShape);
}

export function isZodSchema(value: unknown): value is ToolSchema {
  const candidate = asSchemaLike(value);
  return Boolean(candidate && typeof getProperty(candidate, 'safeParse') === 'function');
}

export function isZodObjectSchema(value: unknown): value is ToolSchema {
  if (!isZodSchema(value)) return false;
  return getSchemaShape(value) !== undefined;
}

function asSchemaLike(value: unknown): ZodSchemaLike | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value;
}

function resolveShape(value: ZodShape | (() => ZodShape) | undefined): ZodShape | undefined {
  if (!value) return undefined;
  if (typeof value === 'function') {
    try {
      const result = value();
      return isRecord(result) ? result : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
