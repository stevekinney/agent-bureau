import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createRegistry, defineTool } from '../src/core';
import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { queryTools, reindexSearchIndex, searchTools } from '../src/registry';

const makeTool = (name: string, overrides: Partial<Parameters<typeof createTool>[0]> = {}) =>
  createTool({
    name,
    description: `${name} tool`,
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value }),
    ...overrides,
  });

describe('registry helpers', () => {
  it('accepts tool, array, and iterable inputs', () => {
    const tool = makeTool('solo');

    expect(queryTools(tool).map((entry) => entry.name)).toEqual(['solo']);
    expect(queryTools([tool]).map((entry) => entry.name)).toEqual(['solo']);
    expect(queryTools(new Set([tool])).map((entry) => entry.name)).toEqual(['solo']);
  });

  it('throws on invalid query input', () => {
    expect(() => queryTools(123 as any)).toThrow('queryTools expects a ToolQuery input');
  });

  it('reindexes embeddings when configured', () => {
    let calls = 0;
    const embed = (texts: string[]) => {
      calls += 1;
      return texts.map(() => [1, 0]);
    };
    const toolbox = createToolbox([], { embed });
    toolbox.register(makeTool('reindex'));

    // Initial registration should have called the embedder
    expect(calls).toBe(1);

    // Reindexing with cached embeddings should not make additional calls
    // because the cached embedder returns stored results for the same texts
    reindexSearchIndex(toolbox);
    expect(calls).toBe(1);

    // Register a new tool and verify embedder is called again for new content
    toolbox.register(makeTool('new-tool'));
    expect(calls).toBe(2);
  });

  it('treats empty text queries as match-all', () => {
    const toolbox = createToolbox();
    toolbox.register(makeTool('alpha'), makeTool('beta'));

    const results = queryTools(toolbox, { text: '   ' });
    expect(results.map((tool) => tool.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('supports AND query groups', () => {
    const toolbox = createToolbox();
    toolbox.register(makeTool('alpha', { tags: ['fast'] }), makeTool('beta', { tags: ['slow'] }));

    const results = queryTools(toolbox, {
      and: [{ tags: { any: ['fast'] } }, { text: 'alpha' }],
    });
    expect(results.map((tool) => tool.name)).toEqual(['alpha']);
  });

  it('supports configuration and summary selection', () => {
    const toolbox = createToolbox();
    const tool = makeTool('meta', {
      tags: ['fast'],
      metadata: { tier: 'pro' },
    });
    toolbox.register(tool);

    const configurations = queryTools(toolbox, { select: 'configuration' });
    expect(configurations[0]?.name).toBe('meta');

    const summaries = queryTools(toolbox, {
      select: 'summary',
      includeSchema: true,
      includeToolConfiguration: true,
    });
    expect(summaries[0]?.metadata).toEqual({ tier: 'pro' });
    expect(summaries[0]?.schema).toBe(tool.input);
    expect(summaries[0]?.configuration?.name).toBe('meta');
  });

  it('supports name and configuration selections in search', () => {
    const toolbox = createToolbox();
    toolbox.register(makeTool('alpha'), makeTool('beta'));

    const names = searchTools(toolbox, { select: 'name' });
    expect(typeof names[0]?.tool).toBe('string');

    const configurations = searchTools(toolbox, { select: 'configuration' });
    expect(configurations[0]?.tool.name).toBeDefined();
  });

  it('includes tag matches in explain details', () => {
    const toolbox = createToolbox();
    toolbox.register(makeTool('tagged', { tags: ['fast'] }));

    const results = searchTools(toolbox, {
      rank: { tags: ['fast'] },
      explain: true,
    });

    expect(results[0]?.matches?.tags).toEqual(['fast']);
  });

  it('supports ranker exclude and match merging', () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeTool('keep', { tags: ['fast'], metadata: { tier: 'pro' } }),
      makeTool('skip'),
    );

    const results = searchTools(toolbox, {
      rank: { tags: ['fast'], text: 'keep' },
      explain: true,
      ranker: (tool) => {
        if (tool.name === 'skip') {
          return { exclude: true };
        }
        return {
          score: 2,
          reasons: ['bonus'],
          matches: {
            fields: ['name'],
            tags: ['fast'],
            schemaKeys: ['value'],
            metadataKeys: ['tier'],
            embedding: { field: 'name', score: 0.8 },
          },
        };
      },
    });

    expect(results.map((match) => match.tool.name)).toEqual(['keep']);
    expect(results[0]?.matches?.tags).toContain('fast');
    expect(results[0]?.matches?.metadataKeys).toContain('tier');
  });

  it('supports numeric ranker scores and tieBreaker none', () => {
    const toolbox = createToolbox();
    toolbox.register(makeTool('alpha'), makeTool('beta'));

    const results = searchTools(toolbox, {
      ranker: () => 1,
      tieBreaker: 'none',
    });

    expect(results).toHaveLength(2);
  });

  it('treats empty schema and tag filters as match-all', () => {
    const toolbox = createToolbox();
    toolbox.register(makeTool('alpha'), makeTool('beta'));

    const bySchema = queryTools(toolbox, { schema: { keys: [''] } });
    expect(bySchema).toHaveLength(2);

    const byAnyTags = queryTools(toolbox, { tags: { any: [''] } });
    expect(byAnyTags).toHaveLength(2);

    const byAllTags = queryTools(toolbox, { tags: { all: [''] } });
    expect(byAllTags).toHaveLength(2);
  });

  it('handles metadata filter edge cases', () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeTool('meta', {
        metadata: {
          flags: ['alpha', 'beta'],
          owner: 'team-core',
          score: 10,
          enabled: true,
          temp: 'hot',
        },
      }),
      makeTool('plain'),
    );

    const byFlags = queryTools(toolbox, {
      metadata: { contains: { flags: ['alpha'] } },
    });
    expect(byFlags.map((tool) => tool.name)).toEqual(['meta']);

    const byBoolean = queryTools(toolbox, {
      metadata: { contains: { enabled: 'yes' } },
    });
    expect(byBoolean).toHaveLength(0);

    const byStartsWith = queryTools(toolbox, {
      metadata: { startsWith: { owner: 'team-' } },
    });
    expect(byStartsWith.map((tool) => tool.name)).toEqual(['meta']);

    const byRangeMax = queryTools(toolbox, {
      metadata: { range: { score: { max: 5 } } },
    });
    expect(byRangeMax).toHaveLength(0);

    const byRangeNonNumber = queryTools(toolbox, {
      metadata: { range: { temp: { min: 1 } } },
    });
    expect(byRangeNonNumber).toHaveLength(0);
  });

  it('handles embedding edge cases without crashing', () => {
    const embed = (texts: string[]) =>
      texts.map((text) => (text.includes('query') ? [1, 0] : [NaN]));
    const toolbox = createToolbox([], { embed });
    toolbox.register(makeTool('invalid-embedding'));

    const results = searchTools(toolbox, { rank: { text: 'query' } });
    expect(results).toHaveLength(1);
  });

  it('skips embedding scores when vector lengths mismatch', () => {
    const embed = (texts: string[]) =>
      texts.map((text) => (text.includes('query') ? [1, 0, 0] : [1, 0]));
    const toolbox = createToolbox([], { embed });
    toolbox.register(makeTool('length-mismatch'));

    const results = searchTools(toolbox, { rank: { text: 'query' } });
    expect(results).toHaveLength(1);
  });

  it('handles sparse embedding vectors', () => {
    const embed = (texts: string[]) => texts.map(() => Array(2) as number[]);
    const toolbox = createToolbox([], { embed });
    toolbox.register(makeTool('sparse'));

    const results = searchTools(toolbox, { rank: { text: 'query' } });
    expect(results).toHaveLength(1);
  });

  describe('core registry versioning and aliases', () => {
    const makeDefinition = (name: string, version: string, deprecated = false) =>
      defineTool({
        name,
        version,
        description: `${name} tool`,
        input: z.object({ value: z.string() }),
        lifecycle: deprecated ? { deprecated: true } : undefined,
      });

    it('requires a version for get when using identity or string', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('alpha', '1.0.0'));
      expect(() => registry.get({ name: 'alpha' })).toThrow(
        'Tool identity must include a version for get/unregister',
      );
      expect(() => registry.get('default:alpha')).toThrow(
        'Tool identity must include a version for get/unregister',
      );
    });

    it('resolves highest semver by default', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('alpha', '1.0.0'));
      registry.register(makeDefinition('alpha', '2.1.0'));

      const resolved = registry.resolve({ name: 'alpha' });
      expect(resolved?.identity.version).toBe('2.1.0');
    });

    it('orders semver by minor and patch versions', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('minor', '1.2.0'));
      registry.register(makeDefinition('minor', '1.3.0'));
      registry.register(makeDefinition('minor', '1.3.1'));

      const resolved = registry.resolve({ name: 'minor' });
      expect(resolved?.identity.version).toBe('1.3.1');
    });

    it('falls back to registration order for non-semver versions', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('beta', 'alpha'));
      registry.register(makeDefinition('beta', 'beta'));

      const resolved = registry.resolve({ name: 'beta' });
      expect(resolved?.identity.version).toBe('beta');
    });

    it('skips deprecated tools unless allowDeprecated is true', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('gamma', '1.0.0'));
      registry.register(makeDefinition('gamma', '2.0.0', true));

      const resolved = registry.resolve({ name: 'gamma' });
      expect(resolved?.identity.version).toBe('1.0.0');

      const resolvedAllow = registry.resolve({ name: 'gamma' }, { allowDeprecated: true });
      expect(resolvedAllow?.identity.version).toBe('2.0.0');
    });

    it('rejects duplicate registrations unless override is true', () => {
      const registry = createRegistry();
      const definition = makeDefinition('dup', '1.0.0');
      registry.register(definition);
      expect(() => registry.register(definition)).toThrow('Tool already registered');

      const replacement = makeDefinition('dup', '1.0.0');
      registry.register(replacement, { override: true });
      const resolved = registry.get(replacement.id);
      expect(resolved?.id).toBe(replacement.id);
      expect(resolved?.identity).toEqual(replacement.identity);
    });

    it('rejects duplicate alias registrations without override', () => {
      const registry = createRegistry();
      const alpha = makeDefinition('alias', '1.0.0');
      const beta = makeDefinition('alias-two', '1.0.0');
      registry.register(alpha, { aliases: ['default:alias-key@1.0.0'] });
      expect(() => registry.register(beta, { aliases: ['default:alias-key@1.0.0'] })).toThrow(
        'Alias already registered',
      );
    });

    it('reassigns aliases when override is true', () => {
      const registry = createRegistry();
      const alpha = makeDefinition('alias-owner', '1.0.0');
      const beta = makeDefinition('alias-next', '1.0.0');
      registry.register(alpha, { aliases: ['default:alias-key@1.0.0'] });
      registry.register(beta, { aliases: ['default:alias-key@1.0.0'], override: true });

      expect(registry.aliases(alpha.id)).toEqual([]);
      expect(registry.resolve('default:alias-key@1.0.0')?.id).toBe(beta.id);
    });

    it('unregisters tools and clears aliases', () => {
      const registry = createRegistry();
      const alpha = makeDefinition('remove', '1.0.0');
      registry.register(alpha, { aliases: ['default:remove-alias@1.0.0'] });

      expect(registry.unregister(alpha.id)).toBe(true);
      expect(registry.resolve(alpha.id)).toBeUndefined();
      expect(registry.resolve('default:remove-alias@1.0.0')).toBeUndefined();
      expect(registry.unregister(alpha.id)).toBe(false);
    });

    it('resolves explicit versions and returns alias lists', () => {
      const registry = createRegistry();
      const alpha = makeDefinition('explicit', '1.0.0');
      registry.register(alpha, { aliases: ['default:explicit-alias@1.0.0'] });

      expect(registry.resolve({ name: 'explicit', version: '1.0.0' })?.id).toBe(alpha.id);
      expect(registry.get({ name: 'explicit', version: '1.0.0' })?.id).toBe(alpha.id);
      expect(registry.aliases(alpha.id)).toEqual(['default:explicit-alias@1.0.0']);
    });

    it('uses custom versionSelector when provided', () => {
      const registry = createRegistry({
        versionSelector: (definitions) =>
          definitions.find((definition) => definition.identity.version === '1.0.0'),
      });
      registry.register(makeDefinition('selector', '1.0.0'));
      registry.register(makeDefinition('selector', '2.0.0'));

      const resolved = registry.resolve({ name: 'selector' });
      expect(resolved?.identity.version).toBe('1.0.0');
    });

    it('resolves aliases and detects cycles', () => {
      const registry = createRegistry();
      const primary = makeDefinition('delta', '1.0.0');
      registry.register(primary, { aliases: ['default:delta-alias@1.0.0'] });
      expect(registry.resolve('default:delta-alias@1.0.0')?.id).toBe(primary.id);

      const cycleRegistry = createRegistry();
      const aliasOwner = makeDefinition('alias', '1.0.0');
      cycleRegistry.register(primary, { aliases: [aliasOwner.id] });
      cycleRegistry.register(aliasOwner, { aliases: [primary.id] });
      expect(() => cycleRegistry.resolve(primary.id)).toThrow('Alias cycle detected');
    });

    it('throws when alias resolution exceeds max depth', () => {
      const registry = createRegistry({ maxAliasDepth: 1 });
      const first = makeDefinition('depth-a', '1.0.0');
      const second = makeDefinition('depth-b', '1.0.0');
      registry.register(first, { aliases: [second.id] });
      registry.register(second, { aliases: ['default:depth-c@1.0.0'] });

      expect(() => registry.resolve('default:depth-c@1.0.0')).toThrow(
        'Alias resolution exceeded max depth',
      );
    });

    it('prefers release versions over prerelease versions', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('release', '1.0.0-alpha'));
      registry.register(makeDefinition('release', '1.0.0'));

      expect(registry.resolve({ name: 'release' })?.identity.version).toBe('1.0.0');
    });

    it('orders prerelease identifiers numerically', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('numeric-pre', '1.0.0-alpha.1'));
      registry.register(makeDefinition('numeric-pre', '1.0.0-alpha.2'));

      expect(registry.resolve({ name: 'numeric-pre' })?.identity.version).toBe('1.0.0-alpha.2');
    });

    it('orders prerelease identifiers by length', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('length-pre', '1.0.0-alpha'));
      registry.register(makeDefinition('length-pre', '1.0.0-alpha.1'));

      expect(registry.resolve({ name: 'length-pre' })?.identity.version).toBe('1.0.0-alpha');
    });

    it('orders numeric prerelease identifiers before alphanumeric', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('mixed-pre', '1.0.0-alpha.1'));
      registry.register(makeDefinition('mixed-pre', '1.0.0-alpha.beta'));

      expect(registry.resolve({ name: 'mixed-pre' })?.identity.version).toBe('1.0.0-alpha.1');
    });

    it('orders alphanumeric prerelease identifiers lexicographically', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('lex-pre', '1.0.0-alpha.beta'));
      registry.register(makeDefinition('lex-pre', '1.0.0-alpha.gamma'));

      expect(registry.resolve({ name: 'lex-pre' })?.identity.version).toBe('1.0.0-alpha.gamma');
    });

    it('orders shorter prerelease identifiers after longer ones when registered first', () => {
      const registry = createRegistry();
      registry.register(makeDefinition('short-pre', '1.0.0-alpha.1'));
      registry.register(makeDefinition('short-pre', '1.0.0-alpha'));

      expect(registry.resolve({ name: 'short-pre' })?.identity.version).toBe('1.0.0-alpha');
    });
  });
});
