import { createAgent } from '@lostgradient/operative';
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
});
