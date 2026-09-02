import { createAgent } from '@lostgradient/operative';
import { createMockGenerate } from '@lostgradient/operative/test';
import { describe, expect, it } from 'bun:test';

import { createAgentCatalog } from './agent-catalog';
import { createAgentDiscoveryTool } from './create-agent-discovery-tool';

function agent(name: string) {
  return createAgent({ generate: createMockGenerate([]), name });
}

describe('createAgentDiscoveryTool', () => {
  it('returns every agent name when called without a search text', async () => {
    const catalog = createAgentCatalog({
      writer: agent('writer'),
      researcher: agent('researcher'),
    });
    const tool = createAgentDiscoveryTool(catalog);

    const result = JSON.parse(await tool.execute({})) as Array<{ name: string }>;

    expect(result.map((entry) => entry.name)).toEqual(['writer', 'researcher']);
  });

  it('filters case-insensitively by substring match on name', async () => {
    const catalog = createAgentCatalog({
      Writer: agent('Writer'),
      Researcher: agent('Researcher'),
    });
    const tool = createAgentDiscoveryTool(catalog);

    const result = JSON.parse(await tool.execute({ text: 'writ' })) as Array<{ name: string }>;

    expect(result.map((entry) => entry.name)).toEqual(['Writer']);
  });

  it('returns an empty array when no name matches', async () => {
    const catalog = createAgentCatalog({ writer: agent('writer') });
    const tool = createAgentDiscoveryTool(catalog);

    const result = JSON.parse(await tool.execute({ text: 'nonexistent' })) as unknown[];

    expect(result).toEqual([]);
  });

  it('returns an empty array for an empty catalog', async () => {
    const catalog = createAgentCatalog({});
    const tool = createAgentDiscoveryTool(catalog);

    const result = JSON.parse(await tool.execute({})) as unknown[];

    expect(result).toEqual([]);
  });

  it('exposes metadata only — every entry has exactly a name field', async () => {
    const catalog = createAgentCatalog({ writer: agent('writer') });
    const tool = createAgentDiscoveryTool(catalog);

    const result = JSON.parse(await tool.execute({})) as Array<Record<string, unknown>>;

    expect(result).toEqual([{ name: 'writer' }]);
    expect(Object.keys(result[0]!)).toEqual(['name']);
  });

  it('never resolves a lazy agent to answer discovery — descriptors come from catalog names', async () => {
    let lazyLoaded = false;
    const catalog = createAgentCatalog({
      lazy: {
        name: '(lazy)',
        hasOutput: false,
        run: () => {
          lazyLoaded = true;
          throw new Error('the lazy agent must never load for discovery');
        },
      },
    });
    const tool = createAgentDiscoveryTool(catalog);

    const result = JSON.parse(await tool.execute({})) as Array<{ name: string }>;

    expect(result).toEqual([{ name: 'lazy' }]);
    expect(lazyLoaded).toBe(false);
  });
});
