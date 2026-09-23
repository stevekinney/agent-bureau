import { buildTagsFromRisk, type ToolRisk } from '../core/risk';
import { assertKebabCaseTag, type NormalizeTagsOption, uniqTags } from '../core/tag-utilities';
import type { ToolMetadataInput } from '../create-tool';
import type { ToolMetadata } from '../is-tool';

export function normalizeTagsWithRisk(
  tags: NormalizeTagsOption<readonly string[]> | undefined,
  risk: ToolRisk | undefined,
  toolName: string,
): string[] {
  if (!Array.isArray(tags)) return buildTagsFromRisk([], risk);
  if (!isStringArray(tags)) throw new Error(`Tool "${toolName}": tag must be a string`);
  const baseTags = uniqTags(tags.map((tag) => assertKebabCaseTag(tag, `Tool "${toolName}"`)));
  return buildTagsFromRisk(baseTags, risk);
}

export function mergeRisk(
  metadata: ToolMetadata | undefined,
  risk: ToolRisk | undefined,
): ToolRisk | undefined {
  const derived: ToolRisk = {};
  if (metadata && typeof metadata === 'object') {
    if (typeof metadata.mutates === 'boolean') derived.mutates = metadata.mutates;
    if (typeof metadata.readOnly === 'boolean') derived.readOnly = metadata.readOnly;
    if (typeof metadata.dangerous === 'boolean') derived.dangerous = metadata.dangerous;
  }
  const merged: ToolRisk = { ...derived, ...risk };
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}

export function resolveMetadataInput<M extends ToolMetadata | undefined>(
  metadata: ToolMetadataInput<M> | undefined,
): M | Promise<M> | undefined {
  return typeof metadata === 'function' ? metadata() : metadata;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
