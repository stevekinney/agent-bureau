import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineTool } from '../src/core';
import { createRegistry } from '../src/core/registry/registry';
import { buildNameCandidates, normalizeName, resolveName } from '../src/core/registry/resolve-name';

describe('normalizeName', () => {
  it('lowercases ASCII letters', () => {
    expect(normalizeName('ReadFile')).toBe('readfile');
    expect(normalizeName('UPPERCASE')).toBe('uppercase');
  });

  it('replaces underscores with hyphens', () => {
    expect(normalizeName('read_file')).toBe('read-file');
    expect(normalizeName('a_b_c')).toBe('a-b-c');
  });

  it('replaces slashes with hyphens', () => {
    expect(normalizeName('read/file')).toBe('read-file');
    expect(normalizeName('a/b/c')).toBe('a-b-c');
  });

  it('replaces dots with hyphens', () => {
    expect(normalizeName('read.file')).toBe('read-file');
    expect(normalizeName('a.b.c')).toBe('a-b-c');
  });

  it('handles mixed separators', () => {
    expect(normalizeName('Read_File.Name/Test')).toBe('read-file-name-test');
  });

  it('is idempotent', () => {
    const name = 'read-file';
    expect(normalizeName(normalizeName(name))).toBe(normalizeName(name));
  });

  it('handles consecutive separators', () => {
    expect(normalizeName('foo..bar')).toBe('foo--bar');
    expect(normalizeName('foo__bar')).toBe('foo--bar');
    expect(normalizeName('foo//bar')).toBe('foo--bar');
  });

  it('trims whitespace', () => {
    expect(normalizeName('  read-file  ')).toBe('read-file');
  });

  it('handles non-ASCII characters as-is (no transformation)', () => {
    expect(normalizeName('café')).toBe('café');
    expect(normalizeName('日本語')).toBe('日本語');
  });
});

describe('buildNameCandidates', () => {
  it('returns candidates in deterministic order: normalized, then suffix', () => {
    const candidates = buildNameCandidates('Read_File');
    // Normalized: read-file
    // Suffixes: ead-file, ad-file, d-file, -file, file, ile, le, e
    expect(candidates[0]).toBe('read-file');
    expect(candidates).toContain('file');
    expect(candidates).toContain('e');
  });

  it('generates suffix candidates', () => {
    const candidates = buildNameCandidates('my-tool-name');
    // Normalized: my-tool-name
    // Suffixes include: tool-name, ool-name, ol-name, ..., me, e
    expect(candidates[0]).toBe('my-tool-name');
    expect(candidates).toContain('name');
    expect(candidates).toContain('e');
  });

  it('handles single-char input', () => {
    const candidates = buildNameCandidates('a');
    expect(candidates[0]).toBe('a');
    expect(candidates).toContain('a');
  });

  it('handles empty string', () => {
    const candidates = buildNameCandidates('');
    expect(candidates).toContain('');
  });

  it('preserves order: normalized first, then suffixes', () => {
    const candidates = buildNameCandidates('TestTool');
    expect(candidates[0]).toBe('testtool');
    // Next candidates should be right-anchored suffixes: esttool, sttool, ...
    expect(candidates[1]).toBe('esttool');
    expect(candidates[2]).toBe('sttool');
  });
});

describe('resolveName', () => {
  it('resolves exact match', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('read-file', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('exact');
  });

  it('resolves case-insensitive match', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('Read-File', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('case-insensitive');
  });

  it('resolves normalized match (underscores to hyphens)', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('read_file', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('normalized');
  });

  it('resolves normalized match (slashes to hyphens)', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('read/file', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('normalized');
  });

  it('resolves suffix match', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('file', registry);
    expect(result.resolved).toBe('my-read-file');
    expect(result.tier).toBe('suffix');
  });

  it('returns null when tool not found', () => {
    const registry = createRegistry();
    const result = resolveName('nonexistent', registry);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBeUndefined();
  });

  it('detects ambiguity: multiple tools match case-insensitively', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'Read-File',
      version: '2.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    const result = resolveName('READ_FILE', registry);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBeDefined();
    expect(result.ambiguous).toContain('read-file');
    expect(result.ambiguous).toContain('read-file');
  });

  it('detects ambiguity: multiple tools match suffix', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'my-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'your-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    const result = resolveName('read-file', registry);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBeDefined();
    expect(result.ambiguous?.length).toBe(2);
  });

  it('resolves single suffix match over multiple ambiguous exact matches', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'read-file',
      version: '2.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool3 = defineTool({
      name: 'write-file',
      version: '1.0.0',
      description: 'write',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);
    registry.register(tool3);

    const result = resolveName('write-file', registry);
    expect(result.resolved).toBe('write-file');
    expect(result.tier).toBe('exact');
  });

  it('respects tier restriction: only tries allowed tiers', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('file', registry, { restrictTo: ['exact', 'case-insensitive'] });
    expect(result.resolved).toBeNull();
  });

  it('allows suffix tier by default', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('file', registry);
    expect(result.tier).toBe('suffix');
  });

  it('respects allowDeprecated flag', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'old-tool',
      version: '1.0.0',
      description: 'deprecated',
      lifecycle: { deprecated: true },
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('old-tool', registry, { allowDeprecated: false });
    expect(result.resolved).toBeNull();
  });

  it('allows deprecated tools when flag is true', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'old-tool',
      version: '1.0.0',
      description: 'deprecated',
      lifecycle: { deprecated: true },
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('old-tool', registry, { allowDeprecated: true });
    expect(result.resolved).toBe('old-tool');
  });

  it('handles multiple versions of the same tool', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'my-tool',
      version: '1.0.0',
      description: 'v1',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'my-tool',
      version: '2.0.0',
      description: 'v2',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    const result = resolveName('my-tool', registry);
    expect(result.resolved).toBe('my-tool');
    expect(result.tier).toBe('exact');
  });

  it('returns empty array for ambiguous when unambiguous match found', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('read-file', registry);
    expect(result.ambiguous).toBeUndefined();
  });

  it('emits resolution event when tool resolved', (done) => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    let eventEmitted = false;
    const mockDispatchEvent = (event: any) => {
      if (event.type === 'toolResolved') {
        expect(event.detail.resolved).toBe('read-file');
        expect(event.detail.tier).toBe('exact');
        expect(event.detail.input).toBe('read-file');
        eventEmitted = true;
      }
      return true;
    };

    const result = resolveName('read-file', registry, undefined, mockDispatchEvent);
    expect(result.resolved).toBe('read-file');
    expect(eventEmitted).toBe(true);
    done();
  });

  it('does not emit event when dispatchEvent is not provided', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('read-file', registry);
    expect(result.resolved).toBe('read-file');
  });

  it('emits no event when resolution fails', (done) => {
    const registry = createRegistry();

    let eventEmitted = false;
    const mockDispatchEvent = () => {
      eventEmitted = true;
      return true;
    };

    const result = resolveName('nonexistent', registry, undefined, mockDispatchEvent);
    expect(result.resolved).toBeNull();
    expect(eventEmitted).toBe(false);
    done();
  });

  it('prioritizes earlier tiers over later ones', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'file-reader',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    // 'Read-File' matches tool1 case-insensitively, and tool2 by suffix
    // Should match tool1 because case-insensitive comes before suffix
    const result = resolveName('Read-File', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('case-insensitive');
  });

  it('handles complex names with many hyphens', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-complex-tool-name-v2',
      version: '1.0.0',
      description: 'complex',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('My_Complex_Tool_Name_V2', registry);
    expect(result.resolved).toBe('my-complex-tool-name-v2');
    expect(result.tier).toBe('normalized');
  });

  it('single character suffix match', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'send-message',
      version: '1.0.0',
      description: 'send',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('e', registry);
    expect(result.resolved).toBe('send-message');
    expect(result.tier).toBe('suffix');
  });

  it('handles namespace in tool names', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      namespace: 'filesystem',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    // Note: resolveName only looks at tool names, not namespaces
    const result = resolveName('read-file', registry);
    expect(result.resolved).toBe('read-file');
  });

  it('detects ambiguous match at suffix tier', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'tool-a',
      version: '1.0.0',
      description: 'a',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'tool-b',
      version: '1.0.0',
      description: 'b',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    const result = resolveName('tool', registry);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBeDefined();
    expect(result.ambiguous?.length).toBe(2);
  });

  it('returns correct tier when resolving', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-tool',
      version: '1.0.0',
      description: 'tool',
      input: z.object({}),
    });
    registry.register(tool);

    const exactResult = resolveName('my-tool', registry);
    expect(exactResult.tier).toBe('exact');

    const caseInsensitiveResult = resolveName('My-Tool', registry);
    expect(caseInsensitiveResult.tier).toBe('case-insensitive');

    const normalizedResult = resolveName('my_tool', registry);
    expect(normalizedResult.tier).toBe('normalized');

    const suffixResult = resolveName('tool', registry);
    expect(suffixResult.tier).toBe('suffix');
  });
});
