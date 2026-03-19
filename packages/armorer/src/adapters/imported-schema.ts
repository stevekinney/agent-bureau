import { z } from 'zod';

type SchemaRecord = Record<string, unknown>;

export function importToolSchema(schema: unknown): z.ZodTypeAny {
  return convertSchema(schema);
}

function convertSchema(schema: unknown): z.ZodTypeAny {
  if (!isSchemaRecord(schema)) {
    return z.unknown();
  }

  let resolvedSchema: z.ZodTypeAny;

  if ('const' in schema) {
    resolvedSchema = z.literal(schema['const'] as string | number | bigint | boolean | null);
  } else if (Array.isArray(schema['enum']) && schema['enum'].length > 0) {
    resolvedSchema = buildUnion(
      schema['enum'].map((value) => z.literal(value as string | number | bigint | boolean | null)),
    );
  } else if (Array.isArray(schema['anyOf']) && schema['anyOf'].length > 0) {
    resolvedSchema = buildUnion(schema['anyOf'].map(convertSchema));
  } else if (Array.isArray(schema['oneOf']) && schema['oneOf'].length > 0) {
    resolvedSchema = buildUnion(schema['oneOf'].map(convertSchema));
  } else {
    const resolvedTypes = normalizeTypes(schema);

    if (resolvedTypes.length > 0) {
      resolvedSchema = buildUnion(resolvedTypes.map((type) => convertTypedSchema(type, schema)));
    } else {
      resolvedSchema = z.unknown();
    }
  }

  return applySchemaAnnotations(resolvedSchema, schema);
}

function convertTypedSchema(type: string, schema: SchemaRecord): z.ZodTypeAny {
  switch (type) {
    case 'array': {
      return z.array(convertSchema(schema['items']));
    }
    case 'boolean': {
      return z.boolean();
    }
    case 'integer': {
      return z.number().int();
    }
    case 'null': {
      return z.null();
    }
    case 'number': {
      return z.number();
    }
    case 'object': {
      return convertObjectSchema(schema);
    }
    case 'string': {
      return z.string();
    }
    default:
      return z.unknown();
  }
}

function convertObjectSchema(schema: SchemaRecord): z.ZodTypeAny {
  const properties = isSchemaRecord(schema['properties']) ? schema['properties'] : {};
  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((key): key is string => typeof key === 'string')
      : [],
  );

  const shape = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      const propertySchema = convertSchema(value);
      return [
        key,
        required.has(key) || hasDefaultValue(value) ? propertySchema : propertySchema.optional(),
      ];
    }),
  );

  let objectSchema = z.object(shape);

  if (schema['additionalProperties'] === false) {
    objectSchema = objectSchema.strict();
  } else if (schema['additionalProperties'] === true) {
    objectSchema = objectSchema.catchall(z.unknown());
  } else if (isSchemaRecord(schema['additionalProperties'])) {
    objectSchema = objectSchema.catchall(convertSchema(schema['additionalProperties']));
  }

  return objectSchema;
}

function normalizeTypes(schema: SchemaRecord): string[] {
  if (typeof schema['type'] === 'string') {
    return [schema['type']];
  }

  if (Array.isArray(schema['type'])) {
    return schema['type'].filter((type): type is string => typeof type === 'string');
  }

  if ('properties' in schema || 'additionalProperties' in schema) {
    return ['object'];
  }

  if ('items' in schema) {
    return ['array'];
  }

  return [];
}

function buildUnion(schemas: z.ZodTypeAny[]): z.ZodTypeAny {
  if (schemas.length === 1) {
    return schemas[0]!;
  }

  return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function applySchemaAnnotations(schema: z.ZodTypeAny, rawSchema: SchemaRecord): z.ZodTypeAny {
  let resolvedSchema = schema;

  if (typeof rawSchema['description'] === 'string' && rawSchema['description'].length > 0) {
    resolvedSchema = resolvedSchema.describe(rawSchema['description']);
  }

  if (rawSchema['nullable'] === true) {
    resolvedSchema = resolvedSchema.nullable();
  }

  if ('default' in rawSchema && rawSchema['default'] !== undefined) {
    resolvedSchema = resolvedSchema.default(rawSchema['default']);
  }

  return resolvedSchema;
}

function isSchemaRecord(value: unknown): value is SchemaRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasDefaultValue(value: unknown): boolean {
  return isSchemaRecord(value) && 'default' in value && value['default'] !== undefined;
}
