import { z } from 'zod';

import { getSchemaKeys, getSchemaShape, type ToolSchema } from './schema-utilities';
import type { JsonObject } from './serialization/json';
import type { AnyToolDefinition as ToolDefinition } from './tool-definition';

/**
 * Detail level for registry inspection.
 * - `summary`: Names, descriptions, tags, and basic counts only
 * - `standard`: Adds schema keys and metadata flags (default)
 * - `full`: Includes complete schema shape details
 */
export type InspectorDetailLevel = 'summary' | 'standard' | 'full';

/**
 * Schema summary containing key names extracted from a tool's parameter schema.
 */
export const SchemaSummarySchema = z.object({
  keys: z.array(z.string()),
  shape: z.record(z.string(), z.unknown()).optional(),
});
export type SchemaSummary = z.infer<typeof SchemaSummarySchema>;

/**
 * Metadata flags extracted from a tool's metadata.
 * Only includes known flags like capabilities and effort.
 */
export const MetadataFlagsSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  effort: z.union([z.string(), z.number()]).optional(),
  hasCustomMetadata: z.boolean(),
});
export type MetadataFlags = z.infer<typeof MetadataFlagsSchema>;

/**
 * Inspection result for a single tool.
 * At 'summary' level, only name/description/tags are included.
 * At 'standard' and 'full' levels, input and metadata are also included.
 */
export const ToolInspectionSchema = z.object({
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  input: SchemaSummarySchema.optional(),
  metadata: MetadataFlagsSchema.optional(),
});
export type ToolInspection = z.infer<typeof ToolInspectionSchema>;

/**
 * Complete registry inspection result.
 */
export const RegistryInspectionSchema = z.object({
  detailLevel: z.enum(['summary', 'standard', 'full']),
  counts: z.object({
    total: z.number(),
    withTags: z.number(),
    withMetadata: z.number(),
  }),
  tools: z.array(ToolInspectionSchema),
});
export type RegistryInspection = z.infer<typeof RegistryInspectionSchema>;

/**
 * Extract a schema summary from a tool's parameter schema.
 * Side-effect free and cheap - only extracts key names and optionally shape.
 */
export function extractSchemaSummary(
  schema: ToolSchema,
  includeShape: boolean = false,
): SchemaSummary {
  const keys = getSchemaKeys(schema);
  const summary: SchemaSummary = { keys };

  if (includeShape) {
    const shape = getSchemaShape(schema);
    if (shape) {
      // Convert shape to a simplified representation (just type names)
      const simplifiedShape: Record<string, unknown> = {};
      for (const key of keys) {
        const fieldSchema = shape[key];
        simplifiedShape[key] = getSchemaTypeName(fieldSchema);
      }
      summary.shape = simplifiedShape;
    }
  }

  return summary;
}

/**
 * Extract a simplified type name from a Zod schema field.
 * Returns a human-readable type string without heavy serialization.
 */
type ZodSchemaLike = {
  type?: string;
  _def?: {
    innerType?: unknown;
  };
};

function getSchemaTypeName(schema: unknown): string {
  if (!schema || typeof schema !== 'object') {
    return 'unknown';
  }

  const candidate = schema as ZodSchemaLike;
  const typeName = typeof candidate.type === 'string' ? candidate.type : undefined;
  if (!typeName) {
    return 'unknown';
  }

  const innerType = candidate._def?.innerType;
  if (innerType) {
    const innerName = getSchemaTypeName(innerType);
    if (typeName === 'optional') return `${innerName}?`;
    if (typeName === 'nullable') return `${innerName} | null`;
    if (typeName === 'default') return innerName;
    return `${typeName}<${innerName}>`;
  }

  return typeName;
}

/**
 * Extract metadata flags from a tool's metadata.
 * Only extracts known flags without deep serialization.
 */
export function extractMetadataFlags(metadata: JsonObject | undefined): MetadataFlags {
  const hasCustomMetadata = metadata !== undefined && Object.keys(metadata).length > 0;

  const flags: MetadataFlags = {
    hasCustomMetadata,
  };

  if (metadata) {
    // Extract capabilities if present
    const capabilities = metadata['capabilities'];
    if (Array.isArray(capabilities)) {
      flags.capabilities = capabilities.filter((c): c is string => typeof c === 'string');
    }

    // Extract effort if present
    const effort = metadata['effort'];
    if (typeof effort === 'string' || typeof effort === 'number') {
      flags.effort = effort;
    }
  }

  return flags;
}

/**
 * Inspect a single tool and return its inspection result.
 * At 'summary' level, only name/description/tags are included.
 * At 'standard' and 'full' levels, input keys and metadata flags are included.
 * At 'full' level, input shape details are also included.
 */
export function inspectTool(
  tool: ToolDefinition,
  detailLevel: InspectorDetailLevel = 'standard',
): ToolInspection {
  const result: ToolInspection = {
    name: tool.identity.name,
    description: tool.display.description,
    tags: tool.tags ? [...tool.tags] : [],
  };

  // Only include input and metadata for standard and full levels
  if (detailLevel !== 'summary') {
    const includeShape = detailLevel === 'full';
    result.input = extractSchemaSummary(tool.input, includeShape);
    result.metadata = extractMetadataFlags(tool.metadata);
  }

  return result;
}

/**
 * Inspect a collection of tools and return a registry inspection result.
 */
export function inspectRegistry(
  tools: ToolDefinition[],
  detailLevel: InspectorDetailLevel = 'standard',
): RegistryInspection {
  const toolInspections = tools.map((tool) => inspectTool(tool, detailLevel));

  return {
    detailLevel,
    counts: {
      total: tools.length,
      withTags: tools.filter((t) => t.tags && t.tags.length > 0).length,
      withMetadata: tools.filter((t) => t.metadata && Object.keys(t.metadata).length > 0).length,
    },
    tools: toolInspections,
  };
}
