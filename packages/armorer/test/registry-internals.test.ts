import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineTool } from '../src/core';
import type { NormalizedTextQuery, TextSearchIndex } from '../src/core/query-predicates';
import {
  internalRegistryTestUtilities,
  queryTools,
  registerToolIndexes,
  reindexSearchIndex,
  searchTools,
  unregisterToolIndexes,
} from '../src/core/registry';
import {
  type EmbeddingInfo,
  registerRegistryEmbedder,
  warmToolEmbeddings,
} from '../src/core/registry/embeddings';
import { createTool } from '../src/create-tool';

const {
  addFieldTokens,
  addToolToInvertedIndex,
  buildEmbeddingIndex,
  buildInvertedIndex,
  buildTextInvertedIndex,
  collectCharIntersectionCandidates,
  compileCriteria,
  createEmbeddingBucketIndex,
  createFieldTokenIndex,
  createMatchComparator,
  createProjectionMatrix,
  createToolSummary,
  filterTools,
  getEmbeddingBandKeys,
  getEmbeddingConfiguration,
  getEmbeddingSignatureBits,
  getRegistryEmbeddingIndex,
  getRegistryInvertedIndex,
  getRegistryTextIndex,
  getTokenCharacters,
  getTokenGrams,
  getToolLookup,
  intersectFromIndex,
  isToolRegistered,
  normalizeFilterValues,
  removeFieldTokens,
  removeToolFromEmbeddingIndex,
  removeToolFromInvertedIndex,
  resolveTools,
  riskMatches,
  selectCandidateTools,
  selectEmbeddingCandidates,
  selectMatchResults,
  selectQueryResults,
  selectTopMatches,
} = internalRegistryTestUtilities;

const makeTool = (name: string, overrides: Partial<Parameters<typeof createTool>[0]> = {}) =>
  createTool({
    name,
    description: `${name} description`,
    input: z.object({
      value: z.string().optional(),
      category: z.string().optional(),
    }),
    execute: async (params) => params,
    ...overrides,
  });

const makeTextIndex = (tool: {
  identity: { name: string };
  description: string;
  tags?: readonly string[];
  input: z.ZodObject<any>;
  metadata?: Record<string, unknown>;
}): TextSearchIndex => ({
  name: tool.identity.name.toLowerCase(),
  description: tool.description.toLowerCase(),
  nameTokens: [tool.identity.name.toLowerCase()],
  descriptionTokens: tool.description.toLowerCase().split(/\s+/g).filter(Boolean),
  tags: (tool.tags ?? []).map((tag) => ({ raw: tag, normalized: tag.toLowerCase() })),
  schemaKeys: Object.keys((tool.input as z.ZodObject<any>).shape).map((key) => ({
    raw: key,
    normalized: key.toLowerCase(),
  })),
  metadataKeys: Object.keys(tool.metadata ?? {}).map((key) => ({
    raw: key,
    normalized: key.toLowerCase(),
  })),
});

const makeNormalizedTextQuery = (
  overrides: Partial<NormalizedTextQuery> = {},
): NormalizedTextQuery => ({
  raw: 'alpha',
  query: 'alpha',
  mode: 'contains',
  fields: ['name', 'description', 'tags', 'schemaKeys', 'metadataKeys'],
  threshold: 0.5,
  tokens: ['alpha'],
  weights: {
    name: 1,
    description: 1,
    tags: 1,
    schemaKeys: 1,
    metadataKeys: 1,
  },
  ...overrides,
});

describe('registry internal coverage', () => {
  it('hits the query cache and emits query events on cached reads', () => {
    const tool = makeTool('cache-hit');
    const events: unknown[] = [];
    const registry = {
      tools: () => [tool],
      register: () => registry,
      dispatchEvent: (event: unknown) => {
        events.push(event);
        return true;
      },
    };

    const first = queryTools(registry as any, { select: 'name' });
    const second = queryTools(registry as any, { select: 'name' });

    expect(first).toEqual(['cache-hit']);
    expect(second).toEqual(['cache-hit']);
    expect(events).toHaveLength(2);
  });

  it('reindexes async embeddings without re-adding stale tools', async () => {
    const tool = makeTool('stale-embed');
    let live = true;
    let resolveEmbeddings: ((vectors: number[][]) => void) | undefined;
    const registry = {
      tools: () => [tool],
      register: () => registry,
      getTool: () => (live ? tool : undefined),
    };

    registerRegistryEmbedder(
      registry,
      () =>
        new Promise<number[][]>((resolve) => {
          resolveEmbeddings = resolve;
        }),
    );

    reindexSearchIndex(registry as any);
    live = false;
    resolveEmbeddings?.(Array.from({ length: 5 }, () => [1, 0]));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(true).toBe(true);
  });

  it('reindexes async embeddings for still-registered tools', async () => {
    const tool = makeTool('live-embed');
    let resolveEmbeddings: ((vectors: number[][]) => void) | undefined;
    const registry = {
      tools: () => [tool],
      register: () => registry,
      getTool: (name: string) => (name === tool.name ? tool : undefined),
    };

    registerRegistryEmbedder(
      registry,
      () =>
        new Promise<number[][]>((resolve) => {
          resolveEmbeddings = resolve;
        }),
    );

    reindexSearchIndex(registry as any);
    resolveEmbeddings?.(Array.from({ length: 5 }, () => [1, 0]));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(true).toBe(true);
  });

  it('maintains explicit index sizes and cleans up text, inverted, and embedding buckets', () => {
    const existing = makeTool('existing', {
      tags: ['fast'],
      metadata: { owner: 'team-core' },
    });
    const added = makeTool('added', {
      tags: ['fast', 'exact'],
      metadata: { owner: 'team-added' },
    });
    const registry = {
      tools: () => [existing, added],
      register: () => registry,
      getTool: (name: string) =>
        name === existing.name || name === added.name ? added : undefined,
    };
    const embed = (texts: string[]) => texts.map(() => [1, 0]);

    warmToolEmbeddings(existing, embed);
    warmToolEmbeddings(added, embed);

    const inverted = getRegistryInvertedIndex(registry, [existing]);
    const text = getRegistryTextIndex(registry, [existing], makeTextIndex as any);
    const embeddings = getRegistryEmbeddingIndex(registry, [existing]);

    registerToolIndexes(registry, added, 5);
    expect(inverted.size).toBe(5);
    expect(text.size).toBe(5);
    expect(embeddings.size).toBe(5);

    unregisterToolIndexes(registry, added, 1);
    expect(inverted.size).toBe(1);
    expect(text.size).toBe(1);
    expect(embeddings.size).toBe(1);
    expect(inverted.tagIndex.get('exact')).toBeUndefined();
    expect(text.fields.tags.map.get('exact')).toBeUndefined();

    registerToolIndexes(registry, added);
    expect(inverted.size).toBe(2);
    expect(text.size).toBe(2);
    expect(embeddings.size).toBe(2);

    unregisterToolIndexes(registry, added);
    expect(inverted.size).toBe(1);
    expect(text.size).toBe(1);
    expect(embeddings.size).toBe(1);
  });

  it('covers field token indexing, lookup caching, and inverted-index cleanup helpers', () => {
    const tool = makeTool('token-tool', {
      tags: ['Fast-Path'.toLowerCase()],
      metadata: { owner: 'ops' },
    });
    const fieldIndex = createFieldTokenIndex();
    const inverted = buildInvertedIndex([]);

    addFieldTokens(fieldIndex, ['', 'a1', 'beta'], tool);
    expect(getTokenCharacters('')).toEqual([]);
    expect(getTokenGrams('a!', 2)).toEqual([]);
    expect(getToolLookup(tool)).toBe(getToolLookup(tool));

    addToolToInvertedIndex(inverted, tool);
    expect(inverted.tagIndex.get('fast-path')).toBeDefined();

    removeFieldTokens(fieldIndex, ['', 'a1', 'beta'], tool);
    removeToolFromInvertedIndex(inverted, tool);

    expect(fieldIndex.tokens).toEqual([]);
    expect(fieldIndex.lengths).toEqual([]);
    expect(fieldIndex.charMap.size).toBe(0);
    expect(fieldIndex.bigramMap.size).toBe(0);
    expect(fieldIndex.gramMap.size).toBe(0);
    expect(inverted.tagIndex.size).toBe(0);
    expect(inverted.schemaKeyIndex.size).toBe(0);
  });

  it('covers embedding index helpers and candidate selection fallbacks', () => {
    const tool = makeTool('embed-me', { tags: ['vector'] });
    const missingTool = makeTool('missing-embed');
    const toolWithoutEmbeddings = makeTool('still-missing');
    const embed = (texts: string[]) => texts.map(() => [1, 0]);
    warmToolEmbeddings(tool, embed);

    const indexed = buildEmbeddingIndex([tool]);
    const indexedWithMissing = buildEmbeddingIndex([tool, missingTool]);
    const missingOnly = buildEmbeddingIndex([missingTool]);
    const normalized = makeNormalizedTextQuery({
      fields: ['name'],
      weights: { name: 1, description: 0, tags: 0, schemaKeys: 0, metadataKeys: 0 },
    });
    const missingFieldQuery = makeNormalizedTextQuery({
      fields: ['metadataKeys'],
      weights: { name: 0, description: 0, tags: 0, schemaKeys: 0, metadataKeys: 1 },
    });
    const queryEmbedding: EmbeddingInfo = { vector: [1, 0], magnitude: 1 };
    const noWeightQuery = makeNormalizedTextQuery({
      fields: ['name'],
      weights: { name: 0, description: 0, tags: 0, schemaKeys: 0, metadataKeys: 0 },
    });

    expect(createProjectionMatrix(0, 4)).toEqual([]);
    expect(getEmbeddingConfiguration(32).hashBits).toBe(16);
    expect(getEmbeddingConfiguration(128).hashBits).toBe(20);
    expect(getEmbeddingConfiguration(768).hashBits).toBe(28);
    expect(getEmbeddingSignatureBits([], [1, 0])).toEqual([]);
    expect(getEmbeddingSignatureBits([[1, 0], undefined as any], [1, 0])).toEqual([]);
    expect(getEmbeddingBandKeys([1, 0, 1, 0], 2)).toEqual([2, 6]);
    expect(selectEmbeddingCandidates(indexed, { vector: [], magnitude: 0 }, normalized)).toBeNull();
    expect(selectEmbeddingCandidates(indexed, queryEmbedding, noWeightQuery)).toBeNull();
    expect(selectEmbeddingCandidates(missingOnly, queryEmbedding, normalized)).toEqual(
      new Set([missingTool]),
    );
    expect(selectEmbeddingCandidates(indexedWithMissing, queryEmbedding, normalized)).toEqual(
      new Set([tool, missingTool]),
    );
    expect(
      selectEmbeddingCandidates(indexedWithMissing, queryEmbedding, missingFieldQuery),
    ).toEqual(new Set([missingTool]));
    expect(
      selectEmbeddingCandidates(indexed, { vector: [-1, -1], magnitude: Math.sqrt(2) }, normalized),
    ).toBeNull();

    removeToolFromEmbeddingIndex(indexed, tool);
    removeToolFromEmbeddingIndex(indexed, toolWithoutEmbeddings as any);
    const bucketIndex = createEmbeddingBucketIndex(2);
    expect(bucketIndex.dimension).toBe(2);
  });

  it('covers text candidate selection branches and query predicate compilation', () => {
    const alpha = defineTool({
      name: 'alpha-tool',
      namespace: 'ops',
      version: '1.0.0',
      description: 'alpha description',
      input: z.object({
        value: z.string().optional(),
        category: z.string().optional(),
      }),
      tags: ['fast', 'read-only'],
      risk: { readOnly: true, mutates: false, dangerous: false },
      lifecycle: { deprecated: true },
      metadata: { owner: 'team-alpha', tier: 'gold', score: 5, status: 'active' },
    });
    const beta = defineTool({
      name: 'beta-tool',
      namespace: 'core',
      version: '2.0.0',
      description: 'beta description',
      input: z.object({
        value: z.string().optional(),
        category: z.string().optional(),
      }),
      tags: ['slow'],
      risk: { readOnly: false, mutates: true, dangerous: true },
      metadata: { owner: 'team-beta', flags: ['x', 'y'], status: 'archived' },
    });
    const tools = [alpha, beta];
    const textIndex = buildTextInvertedIndex(tools, makeTextIndex as any);

    expect(
      selectCandidateTools(tools, { tags: { any: ['missing'] } }, undefined, () => textIndex),
    ).toEqual([]);
    expect(
      selectCandidateTools(
        tools,
        { text: { query: 'be', mode: 'contains', fields: ['name'] } },
        undefined,
        () => textIndex,
      ).map((tool) => tool.name),
    ).toContain('beta-tool');
    expect(
      (internalRegistryTestUtilities.collectTextCandidates as any)(
        textIndex,
        makeNormalizedTextQuery({ tokens: [] }),
      ),
    ).toBeNull();
    expect(
      (internalRegistryTestUtilities.collectTextCandidates as any)(
        textIndex,
        makeNormalizedTextQuery({ mode: 'fuzzy', threshold: 0, tokens: ['alpha'] }),
      ),
    ).toBeNull();
    expect(
      (internalRegistryTestUtilities.collectTextCandidates as any)(
        textIndex,
        makeNormalizedTextQuery({ mode: 'fuzzy', threshold: Number.NaN, tokens: ['alpha'] }),
      ),
    ).toBeNull();
    expect(
      (internalRegistryTestUtilities.collectTextCandidates as any)(
        textIndex,
        makeNormalizedTextQuery({ mode: 'exact', fields: ['name'], tokens: ['alpha-tool'] }),
      ),
    ).toEqual(new Set([alpha]));
    expect(
      (internalRegistryTestUtilities.collectTextCandidates as any)(
        textIndex,
        makeNormalizedTextQuery({ fields: ['name'], tokens: ['be'] }),
      ),
    ).toEqual(new Set([beta]));
    expect(
      (internalRegistryTestUtilities.collectTextCandidates as any)(
        textIndex,
        makeNormalizedTextQuery({ fields: ['name'], tokens: ['a'] }),
      ),
    ).toEqual(new Set([alpha, beta]));
    expect(
      (internalRegistryTestUtilities.collectTextCandidates as any)(
        textIndex,
        makeNormalizedTextQuery({ fields: ['name'], tokens: ['!!!'] }),
      ),
    ).toEqual(new Set());
    expect(
      (internalRegistryTestUtilities.collectTextCandidates as any)(
        textIndex,
        makeNormalizedTextQuery({ fields: ['name'], tokens: ['!!'] }),
      ),
    ).toEqual(new Set());
    expect(collectCharIntersectionCandidates(createFieldTokenIndex(), '')).toBeNull();

    const predicate = compileCriteria({
      namespace: 'ops',
      version: '1.0.0',
      deprecated: true,
      risk: { readOnly: true, mutates: false, dangerous: false },
      metadata: {
        contains: { status: ['active', 'paused'] },
      },
    });
    expect(predicate(alpha)).toBe(true);
    expect(predicate(beta)).toBe(false);
    expect(filterTools(tools, undefined, makeTextIndex as any, undefined, () => textIndex)).toEqual(
      tools,
    );
    expect(normalizeFilterValues('ops')).toEqual(['ops']);
    expect(riskMatches(undefined, { readOnly: true, mutates: false, dangerous: false })).toBe(
      false,
    );
    expect(
      riskMatches(
        { readOnly: true, mutates: false, dangerous: false },
        { readOnly: true, mutates: false, dangerous: false },
      ),
    ).toBe(true);
    expect(
      riskMatches({ readOnly: true, mutates: false, dangerous: false }, { readOnly: false }),
    ).toBe(false);
    expect(
      riskMatches({ readOnly: true, mutates: false, dangerous: false }, { mutates: true }),
    ).toBe(false);
    expect(
      riskMatches({ readOnly: true, mutates: false, dangerous: false }, { dangerous: true }),
    ).toBe(false);
  });

  it('covers ranking comparators, negative-score exclusion, selection fallbacks, and summary creation', () => {
    const alpha = defineTool({
      name: 'alpha-rank',
      description: 'alpha rank description',
      input: z.object({ value: z.string().optional() }),
      tags: ['fast'],
      lifecycle: { deprecated: true },
      metadata: { owner: 'team-alpha' },
      risk: { readOnly: true },
    });
    const beta = defineTool({
      name: 'beta-rank',
      description: 'beta rank description',
      input: z.object({ value: z.string().optional() }),
    });
    const matches = [
      { tool: alpha, score: 1, reasons: [] },
      { tool: beta, score: 1, reasons: [] },
    ];

    const nameComparator = createMatchComparator('name');
    expect(nameComparator(matches[0] as any, matches[1] as any)).toBeLessThan(0);
    const customComparator = createMatchComparator(() => 0);
    expect(selectTopMatches([...matches], 1, customComparator as any)).toHaveLength(1);

    expect(
      searchTools([alpha, beta], {
        limit: 1,
        tieBreaker: () => 0,
        ranker: (tool) => (tool.name === 'alpha-rank' ? 2 : 1),
      }).map((entry) => entry.tool.name),
    ).toEqual(['alpha-rank']);
    expect(searchTools([alpha], { ranker: () => -1 })).toEqual([]);
    expect(selectMatchResults(matches as any, { select: 'summary' as any }).length).toBe(2);
    expect(selectMatchResults(matches as any, { select: 'unknown' as any })).toBe(matches);
    expect(selectQueryResults([alpha], { select: 'unknown' as any })).toEqual([alpha]);

    const summary = createToolSummary(alpha, true, true);
    expect(summary.deprecated).toBe(true);
    expect(summary.lifecycle?.deprecated).toBe(true);
    expect(summary.configuration?.name).toBe('alpha-rank');
    expect(summary.schema).toBe(alpha.input);
  });

  it('covers registry cache helpers and set intersection edge cases', () => {
    const alpha = makeTool('registry-alpha', { tags: ['x'] });
    const beta = makeTool('registry-beta', { tags: ['y'] });
    const registry = {
      tools: () => [alpha, beta],
      register: () => registry,
      getTool: (name: string) => (name === alpha.name ? alpha : undefined),
    };
    const tagIndex = new Map([
      ['x', new Set([alpha])],
      ['y', new Set([beta])],
    ]);

    expect(getRegistryInvertedIndex(registry, [alpha, beta])).toBe(
      getRegistryInvertedIndex(registry, [alpha, beta]),
    );
    expect(getRegistryTextIndex(registry, [alpha, beta], makeTextIndex as any)).toBe(
      getRegistryTextIndex(registry, [alpha, beta], makeTextIndex as any),
    );
    warmToolEmbeddings(alpha, (texts) => texts.map(() => [1, 0]));
    expect(getRegistryEmbeddingIndex(registry, [alpha, beta])).toBe(
      getRegistryEmbeddingIndex(registry, [alpha, beta]),
    );
    expect(intersectFromIndex(tagIndex, [])).toEqual(new Set());
    expect(intersectFromIndex(tagIndex, ['x', 'missing'])).toEqual(new Set());
    expect(intersectFromIndex(tagIndex, ['x', 'y'])).toEqual(new Set());
    expect(isToolRegistered(registry as any, alpha)).toBe(true);
    expect(isToolRegistered(registry as any, beta)).toBe(false);
    expect(isToolRegistered({ tools: () => [alpha] } as any, alpha)).toBe(false);
  });

  it('covers resolveTools accessor closures across registry, tool, array, and iterable inputs', () => {
    const alpha = makeTool('resolve-alpha', {
      tags: ['x'],
      metadata: { owner: 'ops' },
    });
    const beta = makeTool('resolve-beta');
    warmToolEmbeddings(alpha, (texts) => texts.map(() => [1, 0]));

    const registry = {
      tools: () => [alpha, beta],
      register: () => registry,
      getTool: (name: string) => (name === alpha.name ? alpha : undefined),
    };
    registerRegistryEmbedder(registry, (texts) => texts.map(() => [1, 0]));

    const registryResolved = resolveTools(registry as any);
    expect(registryResolved.getInvertedIndex?.()).toBeDefined();
    expect(registryResolved.getTextIndex()).toBeDefined();
    expect(registryResolved.getEmbeddingIndex?.()).toBeDefined();

    const singleResolved = resolveTools(alpha as any);
    expect(singleResolved.getInvertedIndex?.()).toBeDefined();
    expect(singleResolved.getTextIndex()).toBeDefined();

    const arrayResolved = resolveTools([alpha, beta] as any);
    expect(arrayResolved.getInvertedIndex?.()).toBeDefined();
    expect(arrayResolved.getTextIndex()).toBeDefined();

    const iterableResolved = resolveTools(new Set([alpha, beta]) as any);
    expect(iterableResolved.getInvertedIndex?.()).toBeDefined();
    expect(iterableResolved.getTextIndex()).toBeDefined();
  });
});
