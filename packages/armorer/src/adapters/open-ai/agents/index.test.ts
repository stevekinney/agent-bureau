import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../../../create-tool';
import { createToolbox } from '../../../create-toolbox';
import { createOpenAIToolGate, toOpenAIAgentTools } from './index';

describe('open-ai agents adapter', () => {
  it('creates SDK tools with mutating and dangerous lists', async () => {
    const toolbox = createToolbox([
      createTool({
        name: 'safe-tool',
        description: 'safe',
        input: z.object({}),
        async execute() {
          return { ok: true };
        },
      }),
      createTool({
        name: 'mutating-tool',
        description: 'mutates',
        input: z.object({}),
        metadata: { mutates: true },
        async execute() {
          return { ok: true };
        },
      }),
      createTool({
        name: 'dangerous-tool',
        description: 'dangerous',
        input: z.object({}),
        metadata: { dangerous: true },
        async execute() {
          return { ok: true };
        },
      }),
    ]);

    const { toolNames, mutatingToolNames, dangerousToolNames } =
      await toOpenAIAgentTools(toolbox);

    expect(toolNames).toEqual(['safe-tool', 'mutating-tool', 'dangerous-tool']);
    expect(mutatingToolNames).toEqual(['mutating-tool']);
    expect(dangerousToolNames).toEqual(['dangerous-tool']);
  });

  it('denies mutating and dangerous tools when gated', async () => {
    const toolbox = createToolbox([
      createTool({
        name: 'mutating-tool',
        description: 'mutates',
        input: z.object({}),
        metadata: { mutates: true },
        async execute() {
          return { ok: true };
        },
      }),
      createTool({
        name: 'dangerous-tool',
        description: 'dangerous',
        input: z.object({}),
        metadata: { dangerous: true },
        async execute() {
          return { ok: true };
        },
      }),
    ]);

    const gate = createOpenAIToolGate({
      registry: toolbox,
      readOnly: true,
      allowDangerous: false,
    });

    const mutatingDecision = await gate('mutating-tool');
    const dangerousDecision = await gate('dangerous-tool');

    expect(mutatingDecision).toEqual({
      behavior: 'deny',
      message: 'Read-only mode: mutating tools disabled.',
    });
    expect(dangerousDecision).toEqual({
      behavior: 'deny',
      message: 'Use --apply to allow mutating tools.',
    });
  });

  it('allows builtin dangerous tools when allowDangerous is true', async () => {
    const gate = createOpenAIToolGate({
      registry: createToolbox(),
      readOnly: true,
      allowMutation: false,
      allowDangerous: true,
      builtin: { dangerous: ['bash'] },
    });

    const decision = await gate('bash');

    expect(decision).toEqual({ behavior: 'allow' });
  });

  it('uses tags and readOnly metadata to classify tools', async () => {
    const toolbox = createToolbox([
      createTool({
        name: 'tag-mutating',
        description: 'mutating via tag',
        input: z.object({}),
        tags: ['mutating'],
        async execute() {
          return { ok: true };
        },
      }),
      createTool({
        name: 'tag-readonly',
        description: 'read-only via metadata',
        input: z.object({}),
        tags: ['mutating'],
        metadata: { readOnly: true },
        async execute() {
          return { ok: true };
        },
      }),
      createTool({
        name: 'tag-dangerous',
        description: 'dangerous via tag',
        input: z.object({}),
        tags: ['dangerous'],
        async execute() {
          return { ok: true };
        },
      }),
    ]);

    const { mutatingToolNames, dangerousToolNames } = await toOpenAIAgentTools(toolbox);

    expect(mutatingToolNames).toContain('tag-mutating');
    expect(mutatingToolNames).not.toContain('tag-readonly');
    expect(dangerousToolNames).toContain('tag-dangerous');
  });

  it('builds SDK tools with correct structure', async () => {
    const structured = createTool({
      name: 'structured',
      description: 'returns an object',
      input: z.object({}),
      async execute() {
        return { ok: true };
      },
    });
    const empty = createTool({
      name: 'empty',
      description: 'returns undefined',
      input: z.object({}),
      async execute() {
        return undefined;
      },
    });
    const stringResult = createTool({
      name: 'string',
      description: 'returns string',
      input: z.object({}),
      async execute() {
        return 'hello';
      },
    });

    const { tools } = await toOpenAIAgentTools([structured, empty, stringResult]);

    // Check tool structure
    expect(tools[0]!.name).toBe('structured');
    expect(tools[0]!.description).toBe('returns an object');
    expect(tools[0]!.type).toBe('function');
    expect(typeof tools[0]!.invoke).toBe('function');

    expect(tools[1]!.name).toBe('empty');
    expect(tools[2]!.name).toBe('string');
  });

  it('allows unknown tools with gate', async () => {
    const gate = createOpenAIToolGate({
      registry: createToolbox(),
      allowUnknown: true,
    });
    const decision = await gate('mystery');
    expect(decision).toEqual({ behavior: 'allow' });
  });

  it('denies unknown tools by default with custom messages', async () => {
    const gate = createOpenAIToolGate({
      registry: createToolbox(),
      messages: { unknown: (name) => `nope:${name}` },
    });

    const decision = await gate('unknown');
    expect(decision).toEqual({ behavior: 'deny', message: 'nope:unknown' });
  });

  it('rejects invalid tool lists', () => {
    const create = createOpenAIToolGate as unknown as (options: {
      registry: unknown;
    }) => (toolName: string) => Promise<unknown>;
    expect(() => create({ registry: [{}] })).toThrow('Invalid tool input');
  });

  it('handles tool configuration overrides', async () => {
    const tool = createTool({
      name: 'original',
      description: 'original description',
      input: z.object({ a: z.number() }),
      async execute({ a }) {
        return a * 2;
      },
    });

    const { tools, toolNames } = await toOpenAIAgentTools(tool, {
      toolConfiguration: (t) => ({
        name: `custom_${t.name}`,
        description: `Enhanced: ${t.description}`,
      }),
    });

    expect(toolNames).toEqual(['custom_original']);
    expect(tools[0]!.name).toBe('custom_original');
    expect(tools[0]!.description).toBe('Enhanced: original description');
  });

  it('invokes SDK tools and supports formatResult overrides', async () => {
    const tool = createTool({
      name: 'invoke-target',
      description: 'invoked through sdk wrapper',
      input: z.object({ value: z.number() }),
      async execute({ value }) {
        return { doubled: value * 2 };
      },
    });

    const { tools } = await toOpenAIAgentTools([tool], {
      formatResult: (result) => ({ outcome: result.outcome }),
    });

    const output = await tools[0]!.invoke(
      undefined as never,
      JSON.stringify({ value: 3 }),
    );
    expect(output).toEqual({ outcome: 'success' });
  });

  it('invokes SDK tools with default result formatting', async () => {
    const tool = createTool({
      name: 'default-format',
      description: 'uses default formatter',
      input: z.object({ value: z.number() }),
      async execute({ value }) {
        return { value };
      },
    });

    const { tools } = await toOpenAIAgentTools([tool]);
    const output = await tools[0]!.invoke(
      undefined as never,
      JSON.stringify({ value: 7 }),
    );
    expect(output).toEqual({ value: 7 });
  });

  it('stringifies fallback error content values when tool results fail', async () => {
    const makeFailingTool = (name: string, content: unknown): any => ({
      name,
      description: `${name} description`,
      input: { type: 'object', properties: {} },
      tags: [],
      metadata: undefined,
      async executeWith() {
        return {
          outcome: 'error',
          toolCallId: `call-${name}`,
          content,
        };
      },
    });

    const cases: Array<{ content: unknown; messageFragment: string }> = [
      { content: undefined, messageFragment: 'Error: Error' },
      { content: 'text error', messageFragment: 'Error: text error' },
      { content: 42, messageFragment: 'Error: 42' },
      { content: true, messageFragment: 'Error: true' },
      { content: null, messageFragment: 'Error: null' },
      { content: { ok: true }, messageFragment: '"ok": true' },
      { content: 1n, messageFragment: '[unserializable]' },
    ];

    const toolbox = {
      tools: () =>
        cases.map((entry, index) => makeFailingTool(`failing-${index}`, entry.content)),
    } as any;
    const { tools } = await toOpenAIAgentTools(toolbox);

    for (const [index, entry] of cases.entries()) {
      const output = await tools[index]!.invoke(undefined as never, '{}');
      expect(output).toContain(entry.messageFragment);
    }
  });

  it('covers gate decisions for direct tools and builtin tool lists', async () => {
    const directTool = createTool({
      name: 'direct-safe',
      description: 'single tool registry',
      input: z.object({}),
      async execute() {
        return { ok: true };
      },
    });

    const directGate = createOpenAIToolGate({ registry: directTool });
    expect(await directGate('direct-safe')).toEqual({ behavior: 'allow' });

    const builtinGate = createOpenAIToolGate({
      registry: createToolbox(),
      allowMutation: true,
      allowDangerous: false,
      builtin: {
        readOnly: ['list_files'],
        mutating: ['edit_file'],
        dangerous: ['run_bash'],
      },
    });
    expect(await builtinGate('list_files')).toEqual({ behavior: 'allow' });
    expect(await builtinGate('edit_file')).toEqual({ behavior: 'allow' });
    expect(await builtinGate('run_bash')).toEqual({
      behavior: 'deny',
      message: 'Use --dangerous to allow this tool.',
    });

    const readOnlyBuiltinGate = createOpenAIToolGate({
      registry: createToolbox(),
      readOnly: true,
      allowMutation: false,
      builtin: { mutating: ['edit_file'] },
    });
    expect(await readOnlyBuiltinGate('edit_file')).toEqual({
      behavior: 'deny',
      message: 'Read-only mode: mutating tools disabled.',
    });
  });

  it('rejects invalid non-tool registry input', () => {
    const create = createOpenAIToolGate as unknown as (options: {
      registry: unknown;
    }) => (toolName: string) => Promise<unknown>;
    expect(() => create({ registry: { nope: true } })).toThrow('Invalid input');
  });
});
