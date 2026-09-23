import { z } from 'zod';

import { getSchemaKeys, type ToolSchema } from './schema-utilities';
import type { JsonObject } from './serialization/json';
import { normalizeText, tokenize } from './text-scoring';
import type { ToolDefinition } from './tool-definition';

export type TextQueryMode = 'contains' | 'exact' | 'fuzzy';

export type TextQueryField = 'name' | 'description' | 'tags' | 'schemaKeys' | 'metadataKeys';

export type TextQueryWeights = Partial<Record<TextQueryField, number>>;

export type TextQuery =
  | string
  | {
      query: string;
      mode?: TextQueryMode;
      fields?: readonly TextQueryField[];
      threshold?: number;
      weights?: TextQueryWeights;
    };

export type NormalizedTextQuery = {
  raw: string;
  query: string;
  mode: TextQueryMode;
  fields: TextQueryField[];
  threshold: number;
  tokens: string[];
  weights: Record<TextQueryField, number>;
};

export type TextSearchIndex = {
  name: string;
  description: string;
  nameTokens?: string[];
  descriptionTokens?: string[];
  tags: TextToken[];
  schemaKeys: TextToken[];
  metadataKeys: TextToken[];
};

export type TextMatchScore = {
  score: number;
  fields: TextQueryField[];
  tagMatches: string[];
  schemaMatches: string[];
  metadataMatches: string[];
  reasons: string[];
};

export type TextToken = {
  raw: string;
  normalized: string;
};

const DEFAULT_TEXT_FIELDS: TextQueryField[] = [
  'name',
  'description',
  'tags',
  'schemaKeys',
  'metadataKeys',
];

export function normalizeTextQuery(input: TextQuery): NormalizedTextQuery | null {
  const raw = typeof input === 'string' ? input : input.query;
  const rawTrimmed = raw.trim();
  const query = normalizeText(rawTrimmed).trim();
  if (!query) return null;
  const tokens = tokenize(raw);
  if (!tokens.length) return null;
  return {
    raw: rawTrimmed,
    query,
    mode: typeof input === 'string' ? 'contains' : (input.mode ?? 'contains'),
    fields: typeof input === 'string' ? [...DEFAULT_TEXT_FIELDS] : normalizeFields(input.fields),
    threshold: clampThreshold(typeof input === 'string' ? undefined : input.threshold),
    tokens,
    weights: normalizeTextWeights(typeof input === 'string' ? undefined : input.weights),
  };
}

export function buildTextSearchIndex(tool: ToolDefinition): TextSearchIndex {
  const name = tool.identity?.name ?? stringProperty(tool, 'name') ?? '';
  const description = stringProperty(tool, 'description') ?? tool.display?.description ?? '';
  return {
    name: normalizeText(name),
    description: normalizeText(description),
    nameTokens: tokenize(name),
    descriptionTokens: tokenize(description),
    tags: (tool.tags ?? []).map(toToken),
    schemaKeys: getSchemaKeys(getToolSchema(tool)).map(toToken),
    metadataKeys: extractMetadataKeys(tool.metadata).map(toToken),
  };
}

export function getToolSchema(tool: ToolDefinition): ToolSchema {
  return tool.input ?? z.object({});
}

function stringProperty(value: object, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  const entry = Reflect.get(value, key);
  return typeof entry === 'string' ? entry : undefined;
}

function normalizeFields(fields: readonly TextQueryField[] | undefined): TextQueryField[] {
  if (!fields?.length) return [...DEFAULT_TEXT_FIELDS];
  const normalized = fields.filter((field): field is TextQueryField => Boolean(field));
  return normalized.length ? normalized : [...DEFAULT_TEXT_FIELDS];
}

function normalizeTextWeights(
  weights: TextQueryWeights | undefined,
): Record<TextQueryField, number> {
  const normalized: Record<TextQueryField, number> = {
    name: 1,
    description: 1,
    tags: 1,
    schemaKeys: 1,
    metadataKeys: 1,
  };
  if (!weights) return normalized;
  for (const [field, value] of Object.entries(weights)) {
    if (!isTextQueryField(field)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    normalized[field] = Math.max(0, value);
  }
  return normalized;
}

const textQueryFieldSet = new Set<string>(DEFAULT_TEXT_FIELDS);

function isTextQueryField(value: string): value is TextQueryField {
  return textQueryFieldSet.has(value);
}

function clampThreshold(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.7;
  return Math.min(1, Math.max(0, value));
}

function extractMetadataKeys(metadata: JsonObject | undefined): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  return Object.keys(metadata);
}

function toToken(value: string): TextToken {
  return {
    raw: value,
    normalized: normalizeText(value),
  };
}
