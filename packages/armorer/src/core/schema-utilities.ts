/**
 * Schema utilities for working with Zod schema internals.
 * These utilities intentionally work with untyped Zod internals (_def, shape, etc.)
 * which requires permissive type handling.
 */
import type { z } from 'zod';

export type ToolSchema = z.ZodTypeAny;

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

function resolveShape(
  value: ZodShape | (() => ZodShape) | undefined,
): ZodShape | undefined {
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
