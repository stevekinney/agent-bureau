import { describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';

import { createToolbox, type ToolConfiguration } from '../src';
import { defineTool } from '../src/core';
import { createRegistry } from '../src/core/registry/registry';
import { createTool } from '../src/create-tool';
import { createDeprecationWarningMiddleware } from '../src/middleware/index';

const makeConfiguration = (overrides?: Partial<ToolConfiguration>): ToolConfiguration => ({
  name: 'test-tool',
  description: 'a test tool',
  input: z.object({}),
  async execute() {
    return 'result';
  },
  ...overrides,
});

describe('version resolution', () => {
  it('resolves to the latest semver version by default', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({ name: 'tool', version: '1.0.0', description: 'v1', input: z.object({}) }),
    );
    registry.register(
      defineTool({ name: 'tool', version: '2.0.0', description: 'v2', input: z.object({}) }),
    );
    registry.register(
      defineTool({ name: 'tool', version: '1.5.0', description: 'v1.5', input: z.object({}) }),
    );

    const resolved = registry.resolve({ name: 'tool' });
    expect(resolved?.identity.version).toBe('2.0.0');
  });

  it('allows versionSelector to override default resolution', () => {
    const registry = createRegistry({
      versionSelector: (definitions) =>
        definitions.find((definition) => definition.identity.version === '1.0.0'),
    });

    registry.register(
      defineTool({ name: 'tool', version: '1.0.0', description: 'v1', input: z.object({}) }),
    );
    registry.register(
      defineTool({ name: 'tool', version: '2.0.0', description: 'v2', input: z.object({}) }),
    );

    const resolved = registry.resolve({ name: 'tool' });
    expect(resolved?.identity.version).toBe('1.0.0');
  });

  it('excludes deprecated tools from resolution by default', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'tool',
        version: '2.0.0',
        description: 'v2 deprecated',
        input: z.object({}),
        lifecycle: { deprecated: true },
      }),
    );
    registry.register(
      defineTool({ name: 'tool', version: '1.0.0', description: 'v1', input: z.object({}) }),
    );

    const resolved = registry.resolve({ name: 'tool' });
    expect(resolved?.identity.version).toBe('1.0.0');
  });

  it('includes deprecated tools when allowDeprecated is set', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'tool',
        version: '2.0.0',
        description: 'v2 deprecated',
        input: z.object({}),
        lifecycle: { deprecated: true },
      }),
    );
    registry.register(
      defineTool({ name: 'tool', version: '1.0.0', description: 'v1', input: z.object({}) }),
    );

    const resolved = registry.resolve({ name: 'tool' }, { allowDeprecated: true });
    expect(resolved?.identity.version).toBe('2.0.0');
  });
});

describe('deprecation string support', () => {
  it('treats deprecated: "Use v2" the same as deprecated: true for filtering', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'tool',
        version: '2.0.0',
        description: 'v2 string-deprecated',
        input: z.object({}),
        lifecycle: { deprecated: 'Use tool-v3 instead' },
      }),
    );
    registry.register(
      defineTool({ name: 'tool', version: '1.0.0', description: 'v1', input: z.object({}) }),
    );

    const resolved = registry.resolve({ name: 'tool' });
    expect(resolved?.identity.version).toBe('1.0.0');
  });

  it('treats deprecated: false as not deprecated', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'tool',
        version: '1.0.0',
        description: 'v1',
        input: z.object({}),
        lifecycle: { deprecated: false },
      }),
    );

    const resolved = registry.resolve({ name: 'tool' });
    expect(resolved?.identity.version).toBe('1.0.0');
  });

  it('treats deprecated: "" (empty string) as not deprecated', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'tool',
        version: '1.0.0',
        description: 'v1',
        input: z.object({}),
        lifecycle: { deprecated: '' },
      }),
    );

    const resolved = registry.resolve({ name: 'tool' });
    expect(resolved?.identity.version).toBe('1.0.0');
  });

  it('excludes string-deprecated tools from resolution by default', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'tool',
        version: '2.0.0',
        description: 'v2',
        input: z.object({}),
        lifecycle: { deprecated: 'Replaced by tool-v3' },
      }),
    );

    const resolved = registry.resolve({ name: 'tool' });
    expect(resolved).toBeUndefined();
  });

  it('includes string-deprecated tools when allowDeprecated is set', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'tool',
        version: '2.0.0',
        description: 'v2',
        input: z.object({}),
        lifecycle: { deprecated: 'Replaced by tool-v3' },
      }),
    );

    const resolved = registry.resolve({ name: 'tool' }, { allowDeprecated: true });
    expect(resolved?.identity.version).toBe('2.0.0');
  });
});

describe('getDeprecatedTools', () => {
  it('returns tools with deprecated: true', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'old-tool',
        version: '1.0.0',
        description: 'deprecated',
        input: z.object({}),
        lifecycle: { deprecated: true },
      }),
    );
    registry.register(
      defineTool({
        name: 'new-tool',
        version: '1.0.0',
        description: 'active',
        input: z.object({}),
      }),
    );

    const deprecated = registry.getDeprecatedTools();
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0]?.name).toBe('old-tool');
  });

  it('returns tools with deprecated: "message"', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'old-tool',
        version: '1.0.0',
        description: 'deprecated with message',
        input: z.object({}),
        lifecycle: { deprecated: 'Use new-tool instead' },
      }),
    );

    const deprecated = registry.getDeprecatedTools();
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0]?.lifecycle?.deprecated).toBe('Use new-tool instead');
  });

  it('does not return tools with deprecated: false', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'active-tool',
        version: '1.0.0',
        description: 'active',
        input: z.object({}),
        lifecycle: { deprecated: false },
      }),
    );

    const deprecated = registry.getDeprecatedTools();
    expect(deprecated).toHaveLength(0);
  });

  it('does not return tools with no lifecycle', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'plain-tool',
        version: '1.0.0',
        description: 'plain',
        input: z.object({}),
      }),
    );

    const deprecated = registry.getDeprecatedTools();
    expect(deprecated).toHaveLength(0);
  });

  it('returns empty array when no deprecated tools exist', () => {
    const registry = createRegistry();
    expect(registry.getDeprecatedTools()).toEqual([]);
  });

  it('returns multiple deprecated tools', () => {
    const registry = createRegistry();

    registry.register(
      defineTool({
        name: 'old-a',
        version: '1.0.0',
        description: 'deprecated a',
        input: z.object({}),
        lifecycle: { deprecated: true },
      }),
    );
    registry.register(
      defineTool({
        name: 'old-b',
        version: '1.0.0',
        description: 'deprecated b',
        input: z.object({}),
        lifecycle: { deprecated: 'Use new-b' },
      }),
    );
    registry.register(
      defineTool({
        name: 'active',
        version: '1.0.0',
        description: 'active',
        input: z.object({}),
      }),
    );

    const deprecated = registry.getDeprecatedTools();
    expect(deprecated).toHaveLength(2);
    expect(deprecated.map((tool) => tool.name).sort()).toEqual(['old-a', 'old-b']);
  });
});

describe('onDeprecatedToolCalled', () => {
  it('fires callback when a deprecated tool is executed via toolbox', async () => {
    const callback = mock(() => {});

    const tool = createTool({
      name: 'old-tool',
      description: 'Deprecated tool',
      input: z.object({}),
      execute: async () => 'result',
      lifecycle: { deprecated: true },
    });

    const toolbox = createToolbox([tool], {
      onDeprecatedToolCalled: callback,
    });

    await toolbox.execute({ name: 'old-tool', arguments: {} });

    expect(callback).toHaveBeenCalledTimes(1);
    const [config, callInfo] = callback.mock.calls[0]!;
    expect(config.name).toBe('old-tool');
    expect(callInfo.name).toBe('old-tool');
  });

  it('fires callback when a string-deprecated tool is executed', async () => {
    const callback = mock(() => {});

    const tool = createTool({
      name: 'old-tool',
      description: 'Deprecated tool',
      input: z.object({}),
      execute: async () => 'result',
      lifecycle: { deprecated: 'Use new-tool instead' },
    });

    const toolbox = createToolbox([tool], {
      onDeprecatedToolCalled: callback,
    });

    await toolbox.execute({ name: 'old-tool', arguments: {} });

    expect(callback).toHaveBeenCalledTimes(1);
    const [config] = callback.mock.calls[0]!;
    expect(config.lifecycle?.deprecated).toBe('Use new-tool instead');
  });

  it('does not fire callback for non-deprecated tools', async () => {
    const callback = mock(() => {});

    const tool = createTool({
      name: 'active-tool',
      description: 'Active tool',
      input: z.object({}),
      execute: async () => 'result',
    });

    const toolbox = createToolbox([tool], {
      onDeprecatedToolCalled: callback,
    });

    await toolbox.execute({ name: 'active-tool', arguments: {} });

    expect(callback).toHaveBeenCalledTimes(0);
  });

  it('passes call id when available', async () => {
    const callback = mock(() => {});

    const tool = createTool({
      name: 'old-tool',
      description: 'Deprecated tool',
      input: z.object({}),
      execute: async () => 'result',
      lifecycle: { deprecated: true },
    });

    const toolbox = createToolbox([tool], {
      onDeprecatedToolCalled: callback,
    });

    await toolbox.execute({ id: 'call-123', name: 'old-tool', arguments: {} });

    expect(callback).toHaveBeenCalledTimes(1);
    const [, callInfo] = callback.mock.calls[0]!;
    expect(callInfo.id).toBe('call-123');
  });
});

describe('createDeprecationWarningMiddleware', () => {
  it('calls onWarning for deprecated tools during execution', async () => {
    const warnings: ToolConfiguration[] = [];
    const middleware = createDeprecationWarningMiddleware((configuration) => {
      warnings.push(configuration);
    });

    const toolbox = createToolbox(
      [
        makeConfiguration({
          name: 'old-tool',
          description: 'Deprecated tool',
          lifecycle: { deprecated: true },
        }),
      ],
      { middleware: [middleware] },
    );

    await toolbox.execute({ name: 'old-tool', arguments: {} });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.name).toBe('old-tool');
  });

  it('does not wrap non-deprecated tools', async () => {
    const warnings: ToolConfiguration[] = [];
    const middleware = createDeprecationWarningMiddleware((configuration) => {
      warnings.push(configuration);
    });

    const toolbox = createToolbox(
      [makeConfiguration({ name: 'active-tool', description: 'Active tool' })],
      { middleware: [middleware] },
    );

    await toolbox.execute({ name: 'active-tool', arguments: {} });

    expect(warnings).toHaveLength(0);
  });

  it('tool execution still works correctly after wrapping', async () => {
    const middleware = createDeprecationWarningMiddleware(() => {});

    const toolbox = createToolbox(
      [
        makeConfiguration({
          name: 'old-tool',
          description: 'Deprecated tool',
          input: z.object({ value: z.number() }),
          async execute({ value }: { value: number }) {
            return (value as number) * 2;
          },
          lifecycle: { deprecated: true },
        }),
      ],
      { middleware: [middleware] },
    );

    const result = await toolbox.execute({
      name: 'old-tool',
      arguments: { value: 21 },
    });

    expect(result.result).toBe(42);
  });

  it('provides string deprecation message in onWarning callback', async () => {
    let deprecationMessage: boolean | string | undefined;
    const middleware = createDeprecationWarningMiddleware((configuration) => {
      deprecationMessage = configuration.lifecycle?.deprecated;
    });

    const toolbox = createToolbox(
      [
        makeConfiguration({
          name: 'old-tool',
          description: 'Deprecated tool',
          lifecycle: { deprecated: 'Migrate to new-tool v2' },
        }),
      ],
      { middleware: [middleware] },
    );

    await toolbox.execute({ name: 'old-tool', arguments: {} });

    expect(deprecationMessage).toBe('Migrate to new-tool v2');
  });

  it('invokes onWarning on every execution of a deprecated tool', async () => {
    const callCount = mock(() => {});
    const middleware = createDeprecationWarningMiddleware(callCount);

    const toolbox = createToolbox(
      [
        makeConfiguration({
          name: 'old-tool',
          description: 'Deprecated tool',
          lifecycle: { deprecated: true },
        }),
      ],
      { middleware: [middleware] },
    );

    await toolbox.execute({ name: 'old-tool', arguments: {} });
    await toolbox.execute({ name: 'old-tool', arguments: {} });

    expect(callCount).toHaveBeenCalledTimes(2);
  });
});
