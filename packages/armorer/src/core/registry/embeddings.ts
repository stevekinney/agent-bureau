import type { TextQueryField } from '../query-predicates';
import { getSchemaKeys } from '../schema-utilities';
import type { AnyToolDefinition as ToolDefinition } from '../tool-definition';

export type EmbeddingVector = number[];
export type Embedder = (texts: string[]) => EmbeddingVector[] | Promise<EmbeddingVector[]>;

export type EmbeddingInfo = {
  vector: EmbeddingVector;
  magnitude: number;
};

export type EmbeddingEntry = {
  field: TextQueryField;
  text: string;
  vector: EmbeddingVector;
  magnitude: number;
};

type EmbeddingInput = {
  field: TextQueryField;
  text: string;
};

const registryEmbedders = new WeakMap<object, Embedder>();
const toolEmbeddings = new WeakMap<ToolDefinition, EmbeddingEntry[] | Promise<EmbeddingEntry[]>>();
const queryEmbeddings = new WeakMap<
  Embedder,
  Map<string, EmbeddingInfo | Promise<EmbeddingInfo>>
>();

export function registerRegistryEmbedder(registry: object, embedder: Embedder): void {
  registryEmbedders.set(registry, embedder);
  if (!queryEmbeddings.has(embedder)) {
    queryEmbeddings.set(embedder, new Map());
  }
}

export function getRegistryEmbedder(registry: object): Embedder | undefined {
  return registryEmbedders.get(registry);
}

export function warmToolEmbeddings(
  tool: ToolDefinition,
  embedder: Embedder,
  onResolved?: (tool: ToolDefinition, entries: EmbeddingEntry[]) => void,
): void {
  const inputs = buildEmbeddingInputs(tool);
  if (!inputs.length) {
    toolEmbeddings.set(tool, []);
    onResolved?.(tool, []);
    return;
  }
  const texts = inputs.map((input) => input.text);
  const result = embedder(texts);
  if (isPromise(result)) {
    const pending = Promise.resolve(result)
      .then((vectors) => normalizeEmbeddingEntries(inputs, vectors))
      .then((entries) => {
        toolEmbeddings.set(tool, entries);
        onResolved?.(tool, entries);
        return entries;
      })
      .catch(() => {
        toolEmbeddings.delete(tool);
        onResolved?.(tool, []);
        return [] as EmbeddingEntry[];
      });
    toolEmbeddings.set(tool, pending);
    return;
  }
  const entries = normalizeEmbeddingEntries(inputs, result);
  toolEmbeddings.set(tool, entries);
  onResolved?.(tool, entries);
}

export function getToolEmbeddings(tool: ToolDefinition): EmbeddingEntry[] | undefined {
  const cached = toolEmbeddings.get(tool);
  if (Array.isArray(cached)) {
    return cached;
  }
  return undefined;
}

export function getQueryEmbeddingInfo(
  embedder: Embedder,
  query: string,
): EmbeddingInfo | undefined {
  const key = query.trim();
  if (!key) return undefined;
  const cache =
    queryEmbeddings.get(embedder) ?? new Map<string, EmbeddingInfo | Promise<EmbeddingInfo>>();
  if (!queryEmbeddings.has(embedder)) {
    queryEmbeddings.set(embedder, cache);
  }
  const cached = cache.get(key);
  if (cached && !isPromise(cached)) {
    return cached;
  }
  if (cached) {
    return undefined;
  }
  const result = embedder([key]);
  if (isPromise(result)) {
    const emptyInfo: EmbeddingInfo = { vector: [], magnitude: 0 };
    const pending = Promise.resolve(result)
      .then((vectors) => normalizeQueryEmbedding(vectors))
      .then((info) => {
        if (info) {
          cache.set(key, info);
        } else {
          cache.delete(key);
        }
        return info ?? emptyInfo;
      })
      .catch(() => {
        cache.delete(key);
        return emptyInfo;
      });
    cache.set(key, pending);
    return undefined;
  }
  const info = normalizeQueryEmbedding(result);
  if (info) {
    cache.set(key, info);
  }
  return info ?? undefined;
}

export function getQueryEmbedding(embedder: Embedder, query: string): EmbeddingVector | undefined {
  const info = getQueryEmbeddingInfo(embedder, query);
  return info?.vector;
}

function buildEmbeddingInputs(tool: ToolDefinition): EmbeddingInput[] {
  const inputs: EmbeddingInput[] = [];
  const name = tool.identity.name.trim();
  if (name) {
    inputs.push({ field: 'name', text: name });
  }
  const description = tool.display.description.trim();
  if (description) {
    inputs.push({ field: 'description', text: description });
  }
  if (tool.tags?.length) {
    const tagsText = tool.tags.filter(Boolean).join(' ').trim();
    if (tagsText) {
      inputs.push({ field: 'tags', text: tagsText });
    }
  }
  const schema = tool.input;
  const schemaKeys = getSchemaKeys(schema);
  if (schemaKeys.length) {
    inputs.push({ field: 'schemaKeys', text: schemaKeys.join(' ') });
  }
  const metadataKeys = Object.keys(tool.metadata ?? {});
  if (metadataKeys.length) {
    inputs.push({ field: 'metadataKeys', text: metadataKeys.join(' ') });
  }
  return inputs;
}

function normalizeEmbeddingEntries(
  inputs: EmbeddingInput[],
  vectors: EmbeddingVector[],
): EmbeddingEntry[] {
  if (!Array.isArray(vectors) || vectors.length !== inputs.length) {
    return [];
  }
  const entries: EmbeddingEntry[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const vector = vectors[index];
    if (!input || !vector) {
      return [];
    }
    const info = toEmbeddingInfo(vector);
    if (!info) {
      return [];
    }
    entries.push({
      field: input.field,
      text: input.text,
      vector: info.vector,
      magnitude: info.magnitude,
    });
  }
  return entries;
}

function normalizeQueryEmbedding(vectors: EmbeddingVector[]): EmbeddingInfo | undefined {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    return undefined;
  }
  const vector = vectors[0];
  return vector ? toEmbeddingInfo(vector) : undefined;
}

function isVector(value: unknown): value is EmbeddingVector {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function toEmbeddingInfo(vector: EmbeddingVector): EmbeddingInfo | undefined {
  if (!isVector(vector)) {
    return undefined;
  }
  return { vector, magnitude: vectorMagnitude(vector) };
}

function vectorMagnitude(vector: EmbeddingVector): number {
  let sum = 0;
  for (const entry of vector) {
    sum += entry * entry;
  }
  return Math.sqrt(sum);
}

/**
 * Register pre-computed embedding vectors for a tool.
 * The `embeddings` keys are field names matching TextQueryField: 'name', 'description', 'tags', 'schemaKeys', 'metadataKeys'.
 */
export function registerToolEmbeddings(
  tool: ToolDefinition,
  embeddings: Record<string, EmbeddingVector>,
): void {
  const entries: EmbeddingEntry[] = [];
  for (const [field, vector] of Object.entries(embeddings)) {
    if (!isVector(vector)) {
      continue;
    }
    entries.push({
      field: field as TextQueryField,
      text: '',
      vector,
      magnitude: vectorMagnitude(vector),
    });
  }
  toolEmbeddings.set(tool, entries);
}

/**
 * Wait for any pending embedding computation to complete for a tool.
 * Returns the resolved embeddings, or undefined if none exist.
 */
export async function awaitToolEmbeddings(
  tool: ToolDefinition,
): Promise<EmbeddingEntry[] | undefined> {
  const cached = toolEmbeddings.get(tool);
  if (cached === undefined) {
    return undefined;
  }
  if (Array.isArray(cached)) {
    return cached;
  }
  return cached;
}

function isPromise<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
}
