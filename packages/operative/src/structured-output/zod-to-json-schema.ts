import type { ZodType } from 'zod';
import { toJSONSchema } from 'zod';

/**
 * Converts a Zod schema to a JSON Schema representation using Zod v4's
 * built-in `toJSONSchema()`.
 *
 * Strips the `$schema` and `~standard` metadata fields that Zod includes
 * but LLM providers do not expect.
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _, '~standard': __, ...rest } = toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
