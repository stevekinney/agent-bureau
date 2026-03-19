import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  schemaHasKeys,
  schemaMatches,
  scoreTextMatch,
  tagsMatchAll,
  tagsMatchAny,
  tagsMatchNone,
  textMatches,
} from '../src/query-predicates';

const baseTool = {
  name: 'alpha-sum',
  description: 'Handles alpha computations',
  input: z.object({
    fooId: z.string(),
    barValue: z.number().optional(),
  }),
  tags: ['alpha', 'primary'],
  metadata: {
    tier: 'premium',
    owner: 'alpha-team',
  },
} as const;

describe('tagsMatchAny', () => {
  it('matches any provided tags and falls back to match-all when empty', () => {
    expect(tagsMatchAny(['alpha'])(baseTool as any)).toBe(true);
    expect(tagsMatchAny(['beta'])(baseTool as any)).toBe(false);
    expect(tagsMatchAny([])(baseTool as any)).toBe(true);
  });

  it('performs case-insensitive matching', () => {
    expect(tagsMatchAny(['ALPHA'])(baseTool as any)).toBe(true);
    expect(tagsMatchAny(['PRIMARY'])(baseTool as any)).toBe(true);
  });
});

describe('tagsMatchAll', () => {
  it('requires all tags to be present', () => {
    expect(tagsMatchAll(['alpha', 'primary'])(baseTool as any)).toBe(true);
    expect(tagsMatchAll(['alpha', 'missing'])(baseTool as any)).toBe(false);
  });

  it('returns match-all when tag list is empty', () => {
    expect(tagsMatchAll([])(baseTool as any)).toBe(true);
  });
});

describe('tagsMatchNone', () => {
  it('excludes tools that contain any of the tags', () => {
    expect(tagsMatchNone(['alpha'])(baseTool as any)).toBe(false);
    expect(tagsMatchNone(['beta'])(baseTool as any)).toBe(true);
  });

  it('handles tools without tags', () => {
    const noTagsTool = { ...baseTool, tags: undefined };
    expect(tagsMatchNone(['alpha'])(noTagsTool as any)).toBe(true);
  });

  it('returns match-all when tag list is empty', () => {
    expect(tagsMatchNone([])(baseTool as any)).toBe(true);
  });
});

describe('textMatches', () => {
  it('matches fuzzy text across name, description, tags, schema keys, and metadata keys', () => {
    expect(textMatches('alpha')(baseTool as any)).toBe(true);
    expect(textMatches('handles')(baseTool as any)).toBe(true);
    expect(textMatches('primary')(baseTool as any)).toBe(true);
    expect(textMatches('fooId')(baseTool as any)).toBe(true);
    expect(textMatches('tier')(baseTool as any)).toBe(true);
    expect(textMatches('missing')(baseTool as any)).toBe(false);
  });

  it('returns match-all when query is empty', () => {
    expect(textMatches('   ')(baseTool as any)).toBe(true);
  });

  it('supports field-restricted text queries', () => {
    expect(textMatches({ query: 'alpha', fields: ['name'] })(baseTool as any)).toBe(true);
    expect(textMatches({ query: 'handles', fields: ['tags'] })(baseTool as any)).toBe(false);
  });

  it('tokenizes queries for camelCase schema keys', () => {
    expect(textMatches({ query: 'foo id', fields: ['schemaKeys'] })(baseTool as any)).toBe(true);
  });

  it('matches text without diacritics', () => {
    const diacriticsTool = {
      ...baseTool,
      description: 'Cafe \u00e9lan',
    };
    expect(textMatches({ query: 'cafe', fields: ['description'] })(diacriticsTool as any)).toBe(
      true,
    );
  });

  it('supports fuzzy matching with thresholds', () => {
    expect(textMatches({ query: 'alpa', mode: 'fuzzy', threshold: 0.6 })(baseTool as any)).toBe(
      true,
    );
    expect(textMatches({ query: 'alpa', mode: 'fuzzy', threshold: 0.95 })(baseTool as any)).toBe(
      false,
    );
  });

  it('supports exact matching for name and tag tokens', () => {
    const nameScore = scoreTextMatch(baseTool as any, {
      query: 'alpha-sum',
      mode: 'exact',
      fields: ['name'],
    });
    expect(nameScore.fields).toContain('name');
    expect(nameScore.score).toBeGreaterThan(0);

    const tagScore = scoreTextMatch(baseTool as any, {
      query: 'alpha',
      mode: 'exact',
      fields: ['tags'],
    });
    expect(tagScore.tagMatches).toContain('alpha');
    expect(tagScore.score).toBeGreaterThan(0);
  });

  it('returns an empty score for empty queries', () => {
    const result = scoreTextMatch(baseTool as any, '   ');
    expect(result).toEqual({
      score: 0,
      fields: [],
      tagMatches: [],
      schemaMatches: [],
      metadataMatches: [],
      reasons: [],
    });
  });
});

describe('schemaMatches', () => {
  it('performs loose schema comparisons', () => {
    const matching = schemaMatches(z.object({ fooId: z.string() }));
    const nonMatching = schemaMatches(z.object({ baz: z.string() }));
    expect(matching(baseTool as any)).toBe(true);
    expect(nonMatching(baseTool as any)).toBe(false);
  });
});

describe('schemaHasKeys', () => {
  it('requires all provided keys', () => {
    const predicate = schemaHasKeys(['fooId', 'barValue']);
    expect(predicate(baseTool as any)).toBe(true);
    expect(schemaHasKeys(['unknown'])(baseTool as any)).toBe(false);
  });

  it('returns match-all for empty keys', () => {
    expect(schemaHasKeys([])(baseTool as any)).toBe(true);
  });
});
