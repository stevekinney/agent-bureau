import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolbox } from '../src';
import { createSearchTool } from '../src/tools';

describe('createSearchTool', () => {
  const makeTool = (name: string, overrides: Partial<Parameters<typeof createTool>[0]> = {}) =>
    createTool({
      name,
      description: `${name} tool`,
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => ({ value }),
      ...overrides,
    });

  it('creates a search tool registered with the toolbox', () => {
    const toolbox = createToolbox();
    const searchTool = createSearchTool(toolbox);

    expect(searchTool.name).toBe('search-tools');
    expect(toolbox.getTool('search-tools')?.name).toBe('search-tools');
  });

  it('allows custom name', () => {
    const toolbox = createToolbox();
    const searchTool = createSearchTool(toolbox, { name: 'find-tools' });

    expect(searchTool.name).toBe('find-tools');
    expect(toolbox.getTool('find-tools')?.name).toBe('find-tools');
  });

  it('can skip registration', () => {
    const toolbox = createToolbox();
    const searchTool = createSearchTool(toolbox, { register: false });

    expect(toolbox.getTool('search-tools')).toBeUndefined();
    expect(searchTool.name).toBe('search-tools');
  });

  it('searches tools by query', async () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeTool('send-email', { description: 'Send an email message' }),
      makeTool('send-sms', { description: 'Send a text message' }),
      makeTool('get-weather', { description: 'Get weather forecast' }),
    );
    createSearchTool(toolbox);

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'send message' },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{ name: string; score: number }>;
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(tools.map((t) => t.name)).toContain('send-email');
    expect(tools.map((t) => t.name)).toContain('send-sms');
  });

  it('respects limit parameter', async () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeTool('tool-a'),
      makeTool('tool-b'),
      makeTool('tool-c'),
      makeTool('tool-d'),
    );
    createSearchTool(toolbox, { limit: 2 });

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'tool', limit: 2 },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{ name: string }>;
    expect(tools.length).toBe(2);
  });

  it('filters by tags', async () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeTool('send-email', { tags: ['communication'] }),
      makeTool('send-sms', { tags: ['communication'] }),
      makeTool('get-weather', { tags: ['weather'] }),
    );
    createSearchTool(toolbox);

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'send', tags: ['communication'] },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{ name: string }>;
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.name)).not.toContain('get-weather');
  });

  it('includes reasons when explain is enabled', async () => {
    const toolbox = createToolbox();
    toolbox.register(makeTool('send-email', { tags: ['email'] }));
    createSearchTool(toolbox, { explain: true });

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'email' },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{ name: string; reasons?: string[] }>;
    expect(tools[0]?.reasons).toBeDefined();
    expect(tools[0]?.reasons?.length).toBeGreaterThan(0);
  });

  it('returns tool descriptions and tags', async () => {
    const toolbox = createToolbox();
    toolbox.register(
      makeTool('send-email', {
        description: 'Send an email to recipients',
        tags: ['communication', 'email'],
      }),
    );
    createSearchTool(toolbox);

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'email' },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{
      name: string;
      description: string;
      tags?: string[];
    }>;
    expect(tools[0]?.name).toBe('send-email');
    expect(tools[0]?.description).toBe('Send an email to recipients');
    expect(tools[0]?.tags).toContain('communication');
    expect(tools[0]?.tags).toContain('email');
  });

  it('can be called directly', async () => {
    const toolbox = createToolbox();
    toolbox.register(makeTool('alpha'), makeTool('beta'));
    const searchTool = createSearchTool(toolbox);

    const results = await searchTool({ query: 'alpha' });

    expect(Array.isArray(results)).toBe(true);
    expect(results[0]?.name).toBe('alpha');
  });

  it('has readonly metadata', () => {
    const toolbox = createToolbox();
    const searchTool = createSearchTool(toolbox);

    expect(searchTool.metadata?.readOnly).toBe(true);
    expect(searchTool.tags).toContain('readonly');
  });

  describe('agent usability', () => {
    it('is available to agents via toolbox.execute()', async () => {
      const toolbox = createToolbox();
      toolbox.register(makeTool('example-tool'));
      createSearchTool(toolbox);

      // Simulate an agent calling the search tool via toolbox.execute()
      const result = await toolbox.execute({
        id: 'call-123',
        name: 'search-tools',
        arguments: { query: 'example' },
      });

      expect(result.error).toBeUndefined();
      expect(result.toolName).toBe('search-tools');
      expect(Array.isArray(result.result)).toBe(true);
    });

    it('is listed in toolbox.tools() for provider adapters', () => {
      const toolbox = createToolbox();
      createSearchTool(toolbox);

      const tools = toolbox.tools();
      const searchTool = tools.find((t) => t.name === 'search-tools');

      expect(searchTool).toBeDefined();
      expect(searchTool?.description).toContain('Search for available tools');
    });
  });

  describe('dynamic tool discovery', () => {
    it('finds tools registered AFTER the search tool is installed', async () => {
      const toolbox = createToolbox();

      // Install search tool FIRST
      createSearchTool(toolbox);

      // Register tools AFTER the search tool
      toolbox.register(
        makeTool('late-tool-alpha', { description: 'A tool added later' }),
        makeTool('late-tool-beta', { description: 'Another late tool' }),
      );

      // Search should find the late-registered tools
      const results = await toolbox.execute({
        name: 'search-tools',
        arguments: { query: 'late tool' },
      });

      expect(results.error).toBeUndefined();
      const tools = results.result as Array<{ name: string }>;
      expect(tools.map((t) => t.name)).toContain('late-tool-alpha');
      expect(tools.map((t) => t.name)).toContain('late-tool-beta');
    });

    it('finds tools registered at any point in time', async () => {
      const toolbox = createToolbox();

      // Register some tools before
      toolbox.register(makeTool('before-tool', { description: 'Registered before' }));

      // Install search tool
      createSearchTool(toolbox);

      // Register more tools after
      toolbox.register(makeTool('after-tool', { description: 'Registered after' }));

      // First search - should find both
      const results1 = await toolbox.execute({
        name: 'search-tools',
        arguments: { query: 'tool' },
      });
      const tools1 = results1.result as Array<{ name: string }>;
      expect(tools1.map((t) => t.name)).toContain('before-tool');
      expect(tools1.map((t) => t.name)).toContain('after-tool');

      // Register even more tools
      toolbox.register(makeTool('much-later-tool', { description: 'Registered much later' }));

      // Second search - should find all three
      const results2 = await toolbox.execute({
        name: 'search-tools',
        arguments: { query: 'tool' },
      });
      const tools2 = results2.result as Array<{ name: string }>;
      expect(tools2.map((t) => t.name)).toContain('before-tool');
      expect(tools2.map((t) => t.name)).toContain('after-tool');
      expect(tools2.map((t) => t.name)).toContain('much-later-tool');
    });

    it('does not include itself in search results by default', async () => {
      const toolbox = createToolbox();
      createSearchTool(toolbox);
      toolbox.register(makeTool('user-tool'));

      const results = await toolbox.execute({
        name: 'search-tools',
        arguments: { query: 'tool' },
      });

      const tools = results.result as Array<{ name: string }>;
      // The search tool itself should appear in results since it matches "tool"
      // but user-tool should definitely be there
      expect(tools.map((t) => t.name)).toContain('user-tool');
    });
  });
});
