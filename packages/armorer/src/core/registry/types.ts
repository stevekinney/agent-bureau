import type { z } from 'zod';

import type { ToolIdentity } from '../identity';
import type {
  NormalizedTextQuery,
  TextQuery,
  TextQueryField,
  TextSearchIndex,
  ToolPredicate,
} from '../query-predicates';
import type { ToolRisk } from '../risk';
import type { ToolSchema } from '../schema-utilities';
import type { JsonObject } from '../serialization/json';
import type { AnyToolDefinition as ToolDefinition } from '../tool-definition';
import type { Embedder, EmbeddingEntry, EmbeddingInfo, EmbeddingVector } from './embeddings';

export type { Embedder, EmbeddingEntry, EmbeddingInfo, EmbeddingVector, ToolDefinition };

export type TagFilter<TTag extends string = string> = {
  any?: readonly TTag[];
  all?: readonly TTag[];
  none?: readonly TTag[];
};

export type SchemaFilter<TSchemaKey extends string = string> = {
  keys?: readonly TSchemaKey[];
  matches?: ToolSchema;
};

export type MetadataPrimitive = string | number | boolean | null;

export type MetadataRange = {
  min?: number;
  max?: number;
};

export type MetadataFilter<TMetadataKey extends string = string> = {
  has?: readonly TMetadataKey[];
  eq?: Partial<Record<TMetadataKey, unknown>>;
  contains?: Partial<Record<TMetadataKey, MetadataPrimitive | readonly MetadataPrimitive[]>>;
  startsWith?: Partial<Record<TMetadataKey, string>>;
  range?: Partial<Record<TMetadataKey, MetadataRange>>;
  predicate?: (metadata: JsonObject | undefined) => boolean;
};

export type RiskFilter = {
  readOnly?: boolean;
  mutates?: boolean;
  dangerous?: boolean;
  untrustedOutput?: boolean;
  permissions?: readonly string[];
};

export type ToolQuerySelect = 'tool' | 'name' | 'configuration' | 'summary';

export type ToolSummary<TTool extends ToolDefinition = ToolDefinition> = {
  id: TTool['id'];
  identity: ToolIdentity;
  name: string;
  description: string;
  tags?: readonly string[];
  schemaKeys?: readonly string[];
  metadata?: JsonObject;
  risk?: ToolRisk;
  lifecycle?: TTool['lifecycle'];
  deprecated?: boolean;
  schema?: ToolSchema;
  configuration?: TTool;
};

type ToolTagFromMarker<TTool extends ToolDefinition> = TTool extends {
  __tags?: readonly (infer TTag)[];
}
  ? Extract<TTag, string>
  : never;

type ToolTagFromDefinition<TTool extends ToolDefinition> =
  TTool['tags'] extends readonly (infer TTag)[] ? Extract<TTag, string> : never;

type ToolQueryTag<TTool extends ToolDefinition> = [
  ToolTagFromMarker<TTool> | ToolTagFromDefinition<TTool>,
] extends [never]
  ? string
  : ToolTagFromMarker<TTool> | ToolTagFromDefinition<TTool>;

type ToolQuerySchemaKey<TTool extends ToolDefinition> = TTool extends { __schema?: infer TSchema }
  ? TSchema extends z.ZodType
    ? Extract<keyof z.infer<TSchema>, string>
    : string
  : string;

type ToolQueryMetadataKey<TTool extends ToolDefinition> = TTool extends {
  metadata: infer TMetadata;
}
  ? Extract<keyof NonNullable<TMetadata>, string>
  : TTool extends { metadata?: infer TMetadata }
    ? Extract<keyof NonNullable<TMetadata>, string>
    : string;

export type ToolQueryCriteria<TTool extends ToolDefinition = ToolDefinition> = {
  namespace?: string | readonly string[];
  version?: string | readonly string[];
  risk?: RiskFilter;
  deprecated?: boolean;
  tags?: TagFilter<ToolQueryTag<TTool>>;
  text?: TextQuery;
  schema?: SchemaFilter<ToolQuerySchemaKey<TTool>>;
  metadata?: MetadataFilter<ToolQueryMetadataKey<TTool>>;
  predicate?: ToolPredicate<TTool>;
  and?: ToolQueryCriteria<TTool>[];
  or?: ToolQueryCriteria<TTool>[];
  not?: ToolQueryCriteria<TTool> | ToolQueryCriteria<TTool>[];
};

export type ToolQueryOptions = {
  limit?: number;
  offset?: number;
  select?: ToolQuerySelect;
  includeToolConfiguration?: boolean;
  includeSchema?: boolean;
};

export type ToolQuery<TTool extends ToolDefinition = ToolDefinition> = ToolQueryCriteria<TTool> &
  ToolQueryOptions;

export type QueryResult<TTool extends ToolDefinition = ToolDefinition> = TTool[];

export type QuerySelectionResult<TTool extends ToolDefinition = ToolDefinition> =
  TTool[] | string[] | ToolSummary<TTool>[];

export type ToolSearchRank = {
  tags?: readonly string[];
  tagWeights?: Record<string, number>;
  text?: TextQuery;
  weights?: {
    tags?: number;
    text?: number;
  };
};

export type ToolMatchDetails = {
  fields?: TextQueryField[];
  tags?: string[];
  schemaKeys?: string[];
  metadataKeys?: string[];
  embedding?: EmbeddingMatch;
};

export type EmbeddingMatch = {
  field: TextQueryField;
  score: number;
};

export type ToolRankResult = {
  score: number;
  reasons?: string[];
  matches?: ToolMatchDetails;
  override?: boolean;
  exclude?: boolean;
};

export type ToolRankContext = {
  text?: NormalizedTextQuery | null;
  preferredTags: string[];
  tagWeights: Record<string, number>;
  weights: {
    tags: number;
    text: number;
  };
  index: TextSearchIndex;
};

export type ToolRanker<TTool extends ToolDefinition = ToolDefinition> = (
  tool: TTool,
  context: ToolRankContext,
) => ToolRankResult | number | null | undefined;

export type ToolSearchRanker<TTool extends ToolDefinition = ToolDefinition> = ToolRanker<TTool>;

export type ToolTieBreaker<TTool extends ToolDefinition = ToolDefinition> =
  'name' | 'none' | ((a: ToolMatch<TTool>, b: ToolMatch<TTool>) => number);

export type ToolSearchOptions<TTool extends ToolDefinition = ToolDefinition> = {
  filter?: ToolQueryCriteria<TTool>;
  rank?: ToolSearchRank;
  ranker?: ToolRanker<TTool>;
  tieBreaker?: ToolTieBreaker<TTool>;
  limit?: number;
  offset?: number;
  select?: ToolQuerySelect;
  includeToolConfiguration?: boolean;
  includeSchema?: boolean;
  explain?: boolean;
};

export type ToolMatch<T = ToolDefinition> = {
  tool: T;
  score: number;
  reasons: string[];
  matches?: ToolMatchDetails;
};

export type ToolRegistryLike<TTool extends ToolDefinition = ToolDefinition> = {
  tools: () => readonly TTool[];
  dispatchEvent?: (event: Event) => boolean;
};

export type ToolQueryInput<TTool extends ToolDefinition = ToolDefinition> =
  TTool | ToolRegistryLike<TTool> | Iterable<TTool> | readonly TTool[];

export type QueryEvent<TTool extends ToolDefinition = ToolDefinition> = {
  criteria?: ToolQuery<TTool>;
  results: QuerySelectionResult<TTool>;
};

export type SearchEvent<TTool extends ToolDefinition = ToolDefinition> = {
  options: ToolSearchOptions<TTool>;
  results: ToolMatch<TTool>[];
};

export type ToolLookupCache = {
  tags: string[];
  tagsLower: string[];
  tagSet: Set<string>;
  schemaKeysLower: string[];
  schemaKeySet: Set<string>;
};

export type InvertedIndex = {
  tagIndex: Map<string, Set<ToolDefinition>>;
  schemaKeyIndex: Map<string, Set<ToolDefinition>>;
  size: number;
};

export type FieldTokenIndex = {
  map: Map<string, Set<ToolDefinition>>;
  tokens: string[];
  lengthMap: Map<number, Set<ToolDefinition>>;
  lengths: number[];
  charMap: Map<string, Set<ToolDefinition>>;
  bigramMap: Map<string, Set<ToolDefinition>>;
  gramMap: Map<string, Set<ToolDefinition>>;
};

export type TextInvertedIndex = {
  fields: Record<TextQueryField, FieldTokenIndex>;
  size: number;
};

export type EmbeddingBucketIndex = {
  dimension: number;
  hashBits: number;
  bandSize: number;
  bands: number;
  bucketSize: number;
  projections: number[][];
  buckets: Record<TextQueryField, Map<number, Set<ToolDefinition>>>;
};

export type EmbeddingIndex = {
  dimensions: Map<number, EmbeddingBucketIndex>;
  missing: Set<ToolDefinition>;
  size: number;
};
