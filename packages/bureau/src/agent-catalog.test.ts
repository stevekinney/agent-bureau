import { createAgent } from '@lostgradient/operative';
import { createModelCatalog, withBackendDescriptors } from '@lostgradient/operative/providers';
import { createMockGenerate } from '@lostgradient/operative/test';
import { describe, expect, it } from 'bun:test';

import { createAgentCatalog } from './agent-catalog';

function agent(name: string) {
  return createAgent({ generate: createMockGenerate([]), name });
}

describe('createAgentCatalog', () => {
  it('preserves definition order in names(), entries(), and query()', () => {
    const catalog = createAgentCatalog({
      writer: agent('writer'),
      researcher: agent('researcher'),
      editor: agent('editor'),
    });

    expect(catalog.names()).toEqual(['writer', 'researcher', 'editor']);
    expect(catalog.entries().map((entry) => entry.name)).toEqual([
      'writer',
      'researcher',
      'editor',
    ]);
    expect(catalog.query(() => true).map((entry) => entry.name)).toEqual([
      'writer',
      'researcher',
      'editor',
    ]);
  });

  it('get() returns the exact agent for a known literal name', () => {
    const writer = agent('writer');
    const catalog = createAgentCatalog({ writer });

    expect(catalog.get('writer')).toBe(writer);
  });

  it('get() throws for an unknown name', () => {
    const catalog = createAgentCatalog({ writer: agent('writer') });

    expect(() => catalog.get('ghost' as never)).toThrow(/Unknown agent "ghost"/);
  });

  it('find() returns the agent for a runtime string name', () => {
    const writer = agent('writer');
    const catalog = createAgentCatalog({ writer });

    const name: string = 'writer';
    expect(catalog.find(name)).toBe(writer);
  });

  it('find() returns undefined for an unknown runtime string name', () => {
    const catalog = createAgentCatalog({ writer: agent('writer') });

    expect(catalog.find('ghost')).toBeUndefined();
  });

  it('has() narrows a known name and rejects an unknown one', () => {
    const catalog = createAgentCatalog({ writer: agent('writer') });

    expect(catalog.has('writer')).toBe(true);
    expect(catalog.has('ghost')).toBe(false);
  });

  it('has() is exact-key, not case-insensitive — a differently-cased name is unknown', () => {
    const catalog = createAgentCatalog({ Writer: agent('Writer') });

    expect(catalog.has('writer')).toBe(false);
    expect(catalog.has('Writer')).toBe(true);
  });

  it('query() applies the predicate over entries in definition order', () => {
    const catalog = createAgentCatalog({
      writer: agent('writer'),
      researcher: agent('researcher'),
      editor: agent('editor'),
    });

    const matches = catalog.query((entry) => entry.name.startsWith('e') || entry.name === 'writer');

    expect(matches.map((entry) => entry.name)).toEqual(['writer', 'editor']);
  });

  it('query() supports a case-insensitive text search via its predicate — the AgentRegistry.query({text}) replacement', () => {
    const catalog = createAgentCatalog({
      Writer: agent('Writer'),
      Researcher: agent('Researcher'),
    });

    const matches = catalog.query((entry) => entry.name.toLowerCase().includes('writ'));

    expect(matches.map((entry) => entry.name)).toEqual(['Writer']);
  });

  it('an empty AgentDefinitions map produces an empty catalog', () => {
    const catalog = createAgentCatalog({});

    expect(catalog.names()).toEqual([]);
    expect(catalog.entries()).toEqual([]);
    expect(catalog.has('anything')).toBe(false);
  });

  it('the returned catalog is frozen — immutable for the bureau lifetime', () => {
    const catalog = createAgentCatalog({ writer: agent('writer') });

    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it('freezes each entry it hands out, not just the outer catalog — entries(), query(), and get()/find() cannot be desynchronized by mutating a returned entry', () => {
    const writer = agent('writer');
    const catalog = createAgentCatalog({ writer });

    const fromEntries = catalog.entries()[0]!;
    const fromQuery = catalog.query(() => true)[0]!;
    expect(Object.isFrozen(fromEntries)).toBe(true);
    expect(Object.isFrozen(fromQuery)).toBe(true);

    expect(() => {
      // @ts-expect-error — `AgentCatalogEntry` is a read-only interface;
      // this is exactly the "ordinary runtime reflection" case being
      // guarded against, not a type-checked call site.
      fromEntries.name = 'renamed';
    }).toThrow(TypeError);

    // The attempted mutation above did not go through — every read surface
    // still agrees with the original definition.
    expect(catalog.names()).toEqual(['writer']);
    expect(catalog.has('writer')).toBe(true);
    expect(catalog.has('renamed')).toBe(false);
    expect(catalog.get('writer')).toBe(writer);
  });
});

describe('createAgentCatalog: generationProfile (AB-64/AB-247/mod-02e)', () => {
  const FIXED_NOW = '2026-09-02T12:00:00.000Z';
  const seedDescriptors = createModelCatalog({ now: () => FIXED_NOW }).descriptors;
  function requireDescriptor(provider: (typeof seedDescriptors)[number]['provider']) {
    const descriptor = seedDescriptors.find((d) => d.provider === provider);
    if (!descriptor) throw new Error(`expected at least one seed descriptor for ${provider}`);
    return descriptor;
  }

  const anthropicDescriptor = requireDescriptor('anthropic');
  const openAIDescriptor = requireDescriptor('openai');
  const geminiDescriptor = requireDescriptor('gemini');

  function fixedAgent(name: string) {
    return createAgent({
      generate: withBackendDescriptors(createMockGenerate([]), [anthropicDescriptor]),
      name,
    });
  }

  function routedAgent(name: string) {
    return createAgent({
      generate: withBackendDescriptors(createMockGenerate([]), [
        anthropicDescriptor,
        openAIDescriptor,
      ]),
      name,
    });
  }

  function selectableAgent(name: string) {
    return createAgent({
      generate: createMockGenerate([]),
      name,
      allowedCandidates: [{ provider: geminiDescriptor.provider, model: geminiDescriptor.model }],
    });
  }

  function opaqueAgent(name: string) {
    return createAgent({ generate: createMockGenerate([]), name });
  }

  it('exposes the general projection of each mode, stamping projection: general and dropping pricing', () => {
    const catalog = createAgentCatalog({
      fixed: fixedAgent('fixed'),
      routed: routedAgent('routed'),
      selectable: selectableAgent('selectable'),
      opaque: opaqueAgent('opaque'),
    });

    const fixed = catalog.generationProfile('fixed');
    const routed = catalog.generationProfile('routed');
    const selectable = catalog.generationProfile('selectable');
    const opaque = catalog.generationProfile('opaque');

    expect(fixed?.mode).toBe('fixed');
    expect(routed?.mode).toBe('routed');
    expect(selectable?.mode).toBe('selectable');
    expect(opaque?.mode).toBe('opaque');

    for (const profile of [fixed, routed, selectable, opaque]) {
      expect(profile).toBeDefined();
      expect(profile?.projection).toBe('general');
      for (const descriptor of profile?.descriptors ?? []) {
        expect(Object.prototype.hasOwnProperty.call(descriptor, 'pricing')).toBe(false);
      }
    }

    // Descriptor counts survive the catalog read unchanged.
    expect(fixed?.descriptors.length).toBe(1);
    expect(routed?.descriptors.length).toBe(2);
    expect(opaque?.descriptors.length).toBe(0);
  });

  it('reports selector: unavailable for every mode when selectorAvailable is omitted (default false)', () => {
    const catalog = createAgentCatalog({
      fixed: fixedAgent('fixed'),
      routed: routedAgent('routed'),
      selectable: selectableAgent('selectable'),
      opaque: opaqueAgent('opaque'),
    });

    expect(catalog.generationProfile('fixed')?.selector).toBe('unavailable');
    expect(catalog.generationProfile('routed')?.selector).toBe('unavailable');
    expect(catalog.generationProfile('selectable')?.selector).toBe('unavailable');
    expect(catalog.generationProfile('opaque')?.selector).toBe('unavailable');
  });

  it('selectorAvailable: true flips only the selectable agent’s selector to available', () => {
    const catalog = createAgentCatalog(
      {
        fixed: fixedAgent('fixed'),
        routed: routedAgent('routed'),
        selectable: selectableAgent('selectable'),
        opaque: opaqueAgent('opaque'),
      },
      { selectorAvailable: true },
    );

    expect(catalog.generationProfile('fixed')?.selector).toBe('unavailable');
    expect(catalog.generationProfile('routed')?.selector).toBe('unavailable');
    expect(catalog.generationProfile('selectable')?.selector).toBe('available');
    expect(catalog.generationProfile('opaque')?.selector).toBe('unavailable');
  });

  it('returns undefined for a name the catalog does not hold', () => {
    const catalog = createAgentCatalog({ fixed: fixedAgent('fixed') });

    expect(catalog.generationProfile('ghost')).toBeUndefined();
  });

  it('caches the profile: repeated reads for the same name return the identical object by reference', () => {
    const catalog = createAgentCatalog({ fixed: fixedAgent('fixed') });

    const first = catalog.generationProfile('fixed');
    const second = catalog.generationProfile('fixed');

    expect(first).toBe(second);
  });

  it('returns a frozen profile', () => {
    const catalog = createAgentCatalog({ fixed: fixedAgent('fixed') });

    const profile = catalog.generationProfile('fixed');
    expect(profile).toBeDefined();
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile?.descriptors)).toBe(true);
  });
});
