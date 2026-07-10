/**
 * Schema utilities for working with Zod schema internals.
 * These utilities intentionally work with untyped Zod internals (_def, shape, etc.)
 * which requires permissive type handling.
 */
import type { StandardSchemaV1 } from 'interoperability';
import { z } from 'zod';

export type ToolSchema = z.ZodTypeAny;

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

/**
 * Wraps a non-Zod Standard Schema validator (Valibot, ArkType, ...) as a
 * `z.ZodTypeAny` so it flows through the rest of the tool pipeline —
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
export function wrapStandardSchema(schema: StandardSchemaV1): z.ZodTypeAny {
  const wrapped = z.any().transform(async (value, ctx) => {
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
    value &&
    typeof value === 'object' &&
    (value as Record<PropertyKey, unknown>)[WRAPPED_STANDARD_SCHEMA] === true,
  );
}

type ZodShape = Record<string, unknown>;

type ZodSchemaLike = {
  shape?: ZodShape | (() => ZodShape);
  _def?: {
    shape?: ZodShape | (() => ZodShape);
    innerType?: unknown;
    schema?: unknown;
  };
  def?: {
    out?: unknown;
  };
  safeParse?: (input: unknown) => unknown;
};

export function getSchemaKeys(schema: ToolSchema): string[] {
  const shape = getSchemaShape(schema);
  return shape ? Object.keys(shape) : [];
}

export function getSchemaShape(schema: ToolSchema): Record<string, unknown> | undefined {
  const candidate = unwrapSchema(schema);
  if (!candidate) return undefined;
  const directShape = resolveShape(candidate.shape);
  if (directShape) return directShape;
  return resolveShape(candidate._def?.shape);
}

export function unwrapSchema(schema: ToolSchema): ZodSchemaLike | undefined {
  let current: unknown = schema;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const candidate = asSchemaLike(current);
    if (!candidate) return undefined;
    if (candidate._def?.shape || candidate.shape) {
      return candidate;
    }
    if (candidate._def?.innerType) {
      current = candidate._def.innerType;
      continue;
    }
    if (candidate._def?.schema) {
      current = candidate._def.schema;
      continue;
    }
    if (candidate.def?.out) {
      current = candidate.def.out;
      continue;
    }
    return candidate;
  }
  return asSchemaLike(current);
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
  return Boolean(candidate && typeof candidate.safeParse === 'function');
}

export function isZodObjectSchema(value: unknown): value is ToolSchema {
  if (!isZodSchema(value)) return false;
  return getSchemaShape(value) !== undefined;
}

function asSchemaLike(value: unknown): ZodSchemaLike | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as ZodSchemaLike;
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
