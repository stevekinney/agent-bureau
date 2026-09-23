export function getDiagnosticsSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const definition = Reflect.get(schema, '_def');
  if (!definition || typeof definition !== 'object') return schema;
  return Reflect.get(definition, 'out') ?? Reflect.get(definition, 'schema') ?? schema;
}
