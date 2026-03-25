import { describe, expect, it } from 'bun:test';

import {
  type AgentRegistryEntry,
  createAgentDiscoveryTool,
  createAgentRegistry,
} from '../src/create-agent-registry';
import type { AgentDefinition } from '../src/types';

function createStubAgent(name: string): AgentDefinition {
  return {
    name,
    options: { name, generate: async () => ({ content: '', toolCalls: [] }), toolbox: {} },
    run: async () => ({
      conversation: {} as never,
      steps: [],
      content: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'stop-condition' as const,
    }),
    createRun: () => ({}) as never,
  };
}

function createEntry(
  name: string,
  description: string,
  capabilities: string[],
  options?: { metadata?: Record<string, unknown>; tags?: string[] },
): AgentRegistryEntry {
  return {
    agent: createStubAgent(name),
    description,
    capabilities,
    ...(options?.tags && { tags: options.tags }),
    ...(options?.metadata && { metadata: options.metadata }),
  };
}

describe('createAgentRegistry', () => {
  describe('register / get / has / unregister / entries', () => {
    it('registers and retrieves an entry', () => {
      const registry = createAgentRegistry();
      const entry = createEntry('writer', 'Writes content', ['writing']);
      registry.register(entry);

      expect(registry.has('writer')).toBe(true);
      expect(registry.get('writer')).toBe(entry);
    });

    it('entries returns all registered entries', () => {
      const registry = createAgentRegistry();
      const a = createEntry('a', 'Agent A', ['x']);
      const b = createEntry('b', 'Agent B', ['y']);
      registry.register(a);
      registry.register(b);

      expect(registry.entries()).toEqual([a, b]);
    });

    it('unregister removes the agent', () => {
      const registry = createAgentRegistry();
      registry.register(createEntry('temp', 'Temporary', []));
      registry.unregister('temp');

      expect(registry.has('temp')).toBe(false);
      expect(registry.get('temp')).toBeUndefined();
    });

    it('get returns undefined for unknown agent', () => {
      const registry = createAgentRegistry();
      expect(registry.get('unknown')).toBeUndefined();
    });

    it('has returns false for unknown agent', () => {
      const registry = createAgentRegistry();
      expect(registry.has('unknown')).toBe(false);
    });

    it('throws on duplicate registration', () => {
      const registry = createAgentRegistry();
      registry.register(createEntry('dup', 'First', []));
      expect(() => registry.register(createEntry('dup', 'Second', []))).toThrow(
        'Agent "dup" is already registered',
      );
    });
  });

  describe('query', () => {
    function populatedRegistry() {
      const registry = createAgentRegistry();
      registry.register(
        createEntry('writer', 'Writes blog posts and articles', ['writing', 'content']),
      );
      registry.register(createEntry('coder', 'Writes and reviews code', ['coding', 'review']));
      registry.register(
        createEntry('researcher', 'Searches and analyzes data', ['search', 'analysis']),
      );
      return registry;
    }

    it('empty query returns all entries', () => {
      const registry = populatedRegistry();
      expect(registry.query({})).toHaveLength(3);
    });

    it('query by text matches name (case-insensitive)', () => {
      const registry = populatedRegistry();
      const results = registry.query({ text: 'WRITER' });
      expect(results).toHaveLength(1);
      expect(results[0]!.agent.name).toBe('writer');
    });

    it('query by text matches description', () => {
      const registry = populatedRegistry();
      const results = registry.query({ text: 'blog posts' });
      expect(results).toHaveLength(1);
      expect(results[0]!.agent.name).toBe('writer');
    });

    it('query by capabilities (any match)', () => {
      const registry = populatedRegistry();
      const results = registry.query({ capabilities: ['coding'] });
      expect(results).toHaveLength(1);
      expect(results[0]!.agent.name).toBe('coder');
    });

    it('query by capabilities matches any of the listed', () => {
      const registry = populatedRegistry();
      const results = registry.query({ capabilities: ['writing', 'search'] });
      expect(results).toHaveLength(2);
    });

    it('query by allCapabilities requires all to match', () => {
      const registry = populatedRegistry();
      const results = registry.query({ allCapabilities: ['writing', 'content'] });
      expect(results).toHaveLength(1);
      expect(results[0]!.agent.name).toBe('writer');
    });

    it('query by allCapabilities excludes partial matches', () => {
      const registry = populatedRegistry();
      const results = registry.query({ allCapabilities: ['writing', 'coding'] });
      expect(results).toHaveLength(0);
    });

    it('query with custom predicate', () => {
      const registry = populatedRegistry();
      const results = registry.query({
        predicate: (entry) => entry.agent.name.startsWith('c'),
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.agent.name).toBe('coder');
    });

    it('query with limit', () => {
      const registry = populatedRegistry();
      const results = registry.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('query with combined criteria (AND)', () => {
      const registry = populatedRegistry();
      const results = registry.query({
        text: 'writes',
        capabilities: ['writing'],
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.agent.name).toBe('writer');
    });

    it('capabilities matching is case-insensitive', () => {
      const registry = populatedRegistry();
      const results = registry.query({ capabilities: ['CODING'] });
      expect(results).toHaveLength(1);
    });
  });

  describe('event emission', () => {
    it('emits agent.registered event', () => {
      const registry = createAgentRegistry();
      const events: unknown[] = [];
      registry.addEventListener('agent.registered', (event) => {
        events.push(event);
      });

      const entry = createEntry('test', 'Test', []);
      registry.register(entry);

      expect(events).toHaveLength(1);
      expect((events[0] as { name: string }).name).toBe('test');
    });

    it('emits agent.unregistered event', () => {
      const registry = createAgentRegistry();
      const events: unknown[] = [];
      registry.register(createEntry('test', 'Test', []));
      registry.addEventListener('agent.unregistered', (event) => {
        events.push(event);
      });

      registry.unregister('test');

      expect(events).toHaveLength(1);
      expect((events[0] as { name: string }).name).toBe('test');
    });

    it('emits agent.queried event', () => {
      const registry = createAgentRegistry();
      registry.register(createEntry('test', 'Test', []));
      const events: unknown[] = [];
      registry.addEventListener('agent.queried', (event) => {
        events.push(event);
      });

      registry.query({ text: 'test' });

      expect(events).toHaveLength(1);
      expect((events[0] as { results: unknown[] }).results).toHaveLength(1);
    });
  });
});

describe('createAgentDiscoveryTool', () => {
  it('has correct name', () => {
    const registry = createAgentRegistry();
    const tool = createAgentDiscoveryTool(registry);
    expect(tool.name).toBe('discover-agents');
  });

  it('discovers agents by text', async () => {
    const registry = createAgentRegistry();
    registry.register(createEntry('writer', 'Writes content', ['writing']));
    registry.register(createEntry('coder', 'Writes code', ['coding']));

    const tool = createAgentDiscoveryTool(registry);
    const result = await tool({ text: 'content' });
    const parsed = JSON.parse(result as string) as { name: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe('writer');
  });

  it('discovers agents by capabilities', async () => {
    const registry = createAgentRegistry();
    registry.register(createEntry('writer', 'Writes content', ['writing']));
    registry.register(createEntry('coder', 'Writes code', ['coding']));

    const tool = createAgentDiscoveryTool(registry);
    const result = await tool({ capabilities: ['coding'] });
    const parsed = JSON.parse(result as string) as { name: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe('coder');
  });

  it('returns all agents when no filters provided', async () => {
    const registry = createAgentRegistry();
    registry.register(createEntry('a', 'Agent A', []));
    registry.register(createEntry('b', 'Agent B', []));

    const tool = createAgentDiscoveryTool(registry);
    const result = await tool({});
    const parsed = JSON.parse(result as string) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it('includes tags in discovery tool output', async () => {
    const registry = createAgentRegistry();
    registry.register(
      createEntry('tagger', 'Tagged agent', ['writing'], { tags: ['production', 'v2'] }),
    );

    const tool = createAgentDiscoveryTool(registry);
    const result = await tool({});
    const parsed = JSON.parse(result as string) as { name: string; tags: string[] }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.tags).toEqual(['production', 'v2']);
  });

  it('discovery tool filters by tags', async () => {
    const registry = createAgentRegistry();
    registry.register(createEntry('tagged', 'Tagged agent', ['writing'], { tags: ['production'] }));
    registry.register(createEntry('untagged', 'Untagged agent', ['writing']));

    const tool = createAgentDiscoveryTool(registry);
    const result = await tool({ tags: ['production'] });
    const parsed = JSON.parse(result as string) as { name: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe('tagged');
  });
});

describe('query by tags', () => {
  function taggedRegistry() {
    const registry = createAgentRegistry();
    registry.register(
      createEntry('alpha', 'Alpha agent', ['writing'], { tags: ['production', 'v2'] }),
    );
    registry.register(createEntry('beta', 'Beta agent', ['coding'], { tags: ['staging', 'v2'] }));
    registry.register(createEntry('gamma', 'Gamma agent', ['analysis'], { tags: ['production'] }));
    registry.register(createEntry('delta', 'Delta agent', ['search']));
    return registry;
  }

  it('query by tags returns matching entries', () => {
    const registry = taggedRegistry();
    const results = registry.query({ tags: ['staging'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.agent.name).toBe('beta');
  });

  it('query by tags + capabilities combined', () => {
    const registry = taggedRegistry();
    const results = registry.query({ tags: ['production'], capabilities: ['writing'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.agent.name).toBe('alpha');
  });

  it('tags are case-insensitive', () => {
    const registry = taggedRegistry();
    const results = registry.query({ tags: ['PRODUCTION'] });
    expect(results).toHaveLength(2);
    const names = results.map((r) => r.agent.name).sort();
    expect(names).toEqual(['alpha', 'gamma']);
  });

  it('query with no matching tags returns empty', () => {
    const registry = taggedRegistry();
    const results = registry.query({ tags: ['nonexistent'] });
    expect(results).toHaveLength(0);
  });

  it('entries without tags are excluded when filtering by tags', () => {
    const registry = taggedRegistry();
    const results = registry.query({ tags: ['production'] });
    // delta has no tags, should not appear
    expect(results.every((r) => r.agent.name !== 'delta')).toBe(true);
  });
});
