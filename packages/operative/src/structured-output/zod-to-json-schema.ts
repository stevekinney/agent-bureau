import type { ZodType } from 'zod';

/**
 * Internal representation of a Zod schema's definition.
 *
 * Zod v4 stores type metadata on `_def` with a `type` discriminator.
 * This interface covers the subset needed for JSON Schema conversion.
 */
interface ZodDef {
  type: string;
  shape?: Record<string, ZodType>;
  element?: ZodType;
  entries?: Record<string, string>;
  values?: unknown[];
  options?: ZodType[];
  innerType?: ZodType;
}

/**
 * Extracts the internal definition from a Zod schema.
 */
function getDef(schema: ZodType): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

/**
 * Converts a Zod schema to a JSON Schema representation.
 *
 * Handles the most common Zod types: string, number, boolean, object,
 * array, enum, literal, union, and optional. Nested structures are
 * converted recursively. Unsupported types produce an empty object.
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const def = getDef(schema);

  switch (def.type) {
    case 'string':
      return { type: 'string' };

    case 'number':
      return { type: 'number' };

    case 'boolean':
      return { type: 'boolean' };

    case 'object': {
      const shape = def.shape ?? {};
      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        const fieldDef = getDef(value);
        if (fieldDef.type === 'optional') {
          properties[key] = zodToJsonSchema(fieldDef.innerType!);
        } else {
          properties[key] = zodToJsonSchema(value);
          required.push(key);
        }
      }

      const result: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) {
        result['required'] = required;
      }
      return result;
    }

    case 'array':
      return {
        type: 'array',
        items: zodToJsonSchema(def.element!),
      };

    case 'enum':
      return {
        type: 'string',
        enum: Object.values(def.entries!),
      };

    case 'literal': {
      const value = def.values?.[0];
      return { const: value };
    }

    case 'union':
      return {
        anyOf: (def.options ?? []).map((option) => zodToJsonSchema(option)),
      };

    case 'optional':
      return zodToJsonSchema(def.innerType!);

    default:
      return {};
  }
}
