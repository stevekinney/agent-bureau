import { z } from 'zod';

type SchemaRecord = Record<string, unknown>;

/**
 * Converts a JSON Schema object to a Zod schema.
 *
 * Handles: `type`, `properties`, `required`, `items`, `enum`, `const`,
 * `anyOf`, `oneOf`, `allOf`, `additionalProperties`, `nullable`,
 * `description`, and `default`.
 *
 * Returns `undefined` if the input is not a valid schema record.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny | undefined {
  if (!isSchemaRecord(schema)) return undefined;
  const definition = schema;

  if (Array.isArray(definition['anyOf']) && definition['anyOf'].length > 0) {
    return applyAnnotations(
      applyNullable(unionSchemas(definition['anyOf'].map(jsonSchemaToZod)), definition),
      definition,
    );
  }

  if (Array.isArray(definition['oneOf']) && definition['oneOf'].length > 0) {
    return applyAnnotations(
      applyNullable(unionSchemas(definition['oneOf'].map(jsonSchemaToZod)), definition),
      definition,
    );
  }

  if (Array.isArray(definition['allOf']) && definition['allOf'].length > 0) {
    return applyAnnotations(
      applyNullable(intersectSchemas(definition['allOf'].map(jsonSchemaToZod)), definition),
      definition,
    );
  }

  if (Array.isArray(definition['enum']) && definition['enum'].length > 0) {
    return applyAnnotations(applyNullable(enumToZod(definition['enum']), definition), definition);
  }

  if (Object.prototype.hasOwnProperty.call(definition, 'const')) {
    return applyAnnotations(
      applyNullable(literalSchema(definition['const']), definition),
      definition,
    );
  }

  const schemaType = definition['type'];
  let base: z.ZodTypeAny | undefined;

  if (Array.isArray(schemaType)) {
    base = unionSchemas((schemaType as string[]).map((type) => schemaFromType(definition, type)));
  } else if (typeof schemaType === 'string') {
    base = schemaFromType(definition, schemaType);
  } else if (definition['properties'] || definition['additionalProperties'] !== undefined) {
    base = objectSchema(definition);
  } else if ('items' in definition) {
    base = arraySchema(definition);
  }

  return applyAnnotations(applyNullable(base, definition), definition);
}

/**
 * Converts a JSON Schema to a Zod schema, returning `z.unknown()` for unrecognized input.
 * Suitable for adapter use where a schema must always be returned.
 */
export function importToolSchema(schema: unknown): z.ZodTypeAny {
  if (!isSchemaRecord(schema)) {
    return z.unknown();
  }
  return jsonSchemaToZod(schema) ?? z.unknown();
}

function schemaFromType(definition: SchemaRecord, schemaType: string): z.ZodTypeAny | undefined {
  switch (schemaType) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return arraySchema(definition);
    case 'object':
      return objectSchema(definition);
    default:
      return undefined;
  }
}

function arraySchema(definition: SchemaRecord): z.ZodTypeAny {
  const items = definition['items'];
  if (Array.isArray(items)) {
    const itemSchema = unionSchemas(items.map(jsonSchemaToZod)) ?? z.any();
    return z.array(itemSchema);
  }
  const itemSchema = jsonSchemaToZod(items) ?? z.any();
  return z.array(itemSchema);
}

function objectSchema(definition: SchemaRecord): z.ZodTypeAny {
  const properties = isSchemaRecord(definition['properties']) ? definition['properties'] : {};
  const required = new Set(
    Array.isArray(definition['required'])
      ? (definition['required'] as unknown[]).filter(
          (key): key is string => typeof key === 'string',
        )
      : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    const schema = jsonSchemaToZod(value) ?? z.any();
    shape[key] = required.has(key) || hasDefaultValue(value) ? schema : schema.optional();
  }
  let obj = z.object(shape);
  const additional = definition['additionalProperties'];
  if (additional === false) {
    obj = obj.strict();
  } else if (isSchemaRecord(additional)) {
    const catchall = jsonSchemaToZod(additional) ?? z.any();
    obj = obj.catchall(catchall);
  } else if (additional === true) {
    obj = obj.catchall(z.unknown());
  } else {
    obj = obj.passthrough();
  }
  return obj;
}

function enumToZod(values: unknown[]): z.ZodTypeAny | undefined {
  if (!values.length) {
    return z.never();
  }
  if (values.every((value) => typeof value === 'string')) {
    return z.enum(values as [string, ...string[]]);
  }
  const literals = values.map(literalSchema).filter(Boolean) as z.ZodTypeAny[];
  return unionSchemas(literals);
}

function literalSchema(value: unknown): z.ZodTypeAny | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return z.literal(value);
  }
  return undefined;
}

function unionSchemas(schemas: Array<z.ZodTypeAny | undefined>): z.ZodTypeAny | undefined {
  const filtered = schemas.filter(Boolean) as z.ZodTypeAny[];
  if (!filtered.length) return undefined;
  if (filtered.length === 1) return filtered[0];
  return z.union(filtered as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function intersectSchemas(schemas: Array<z.ZodTypeAny | undefined>): z.ZodTypeAny | undefined {
  const filtered = schemas.filter(Boolean) as z.ZodTypeAny[];
  if (!filtered.length) return undefined;
  return filtered.reduce((acc, schema) => z.intersection(acc, schema));
}

function applyNullable(
  schema: z.ZodTypeAny | undefined,
  definition: SchemaRecord,
): z.ZodTypeAny | undefined {
  if (!schema) return undefined;
  if (definition['nullable'] === true) {
    return z.union([schema, z.null()]);
  }
  return schema;
}

/**
 * Apply `description` and `default` annotations from the raw JSON Schema.
 */
function applyAnnotations(
  schema: z.ZodTypeAny | undefined,
  definition: SchemaRecord,
): z.ZodTypeAny | undefined {
  if (!schema) return undefined;
  let result = schema;

  if (typeof definition['description'] === 'string' && definition['description'].length > 0) {
    result = result.describe(definition['description']);
  }

  if ('default' in definition && definition['default'] !== undefined) {
    result = result.default(definition['default']);
  }

  return result;
}

function isSchemaRecord(value: unknown): value is SchemaRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasDefaultValue(value: unknown): boolean {
  return isSchemaRecord(value) && 'default' in value && value['default'] !== undefined;
}

export const internalJsonSchemaTestUtilities = {
  enumToZod,
};
