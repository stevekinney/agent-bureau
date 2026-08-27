import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import * as root from '../src';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports?: Record<string, unknown>;
  engines?: Record<string, string>;
};
const rootSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('public API export map', () => {
  const exportsMap = pkg.exports ?? {};

  it('declares the supported runtime conditions for every public subpath', () => {
    const browserSubpaths = [
      '.',
      './core',
      './query',
      './inspect',
      './adapters/openai',
      './adapters/anthropic',
      './adapters/gemini',
      './utilities',
      './lazy',
      './registry',
      './tools',
      './instrumentation',
      './middleware',
      './test',
      './truncation',
      './idempotency',
      './openapi',
    ];
    const serverOnlySubpaths = ['./mcp', './coding', './adapters/open-ai/agents'];

    expect(Object.keys(exportsMap).sort()).toEqual(
      [...browserSubpaths, ...serverOnlySubpaths].sort(),
    );
    for (const subpath of browserSubpaths) {
      expect((exportsMap[subpath] as Record<string, unknown>).browser).toBeDefined();
    }
    for (const subpath of serverOnlySubpaths) {
      expect((exportsMap[subpath] as Record<string, unknown>).browser).toBeUndefined();
    }
  });

  it('keeps the minimum supported runtime boundaries explicit', () => {
    expect(pkg.engines).toEqual({ bun: '>=1.3.13', node: '^20.16.0 || >=22.3.0' });
  });

  it('includes the canonical adapter subpaths', () => {
    expect(exportsMap['./adapters/openai']).toBeDefined();
    expect(exportsMap['./adapters/anthropic']).toBeDefined();
    expect(exportsMap['./adapters/gemini']).toBeDefined();
    expect(exportsMap['./adapters/open-ai/agents']).toBeDefined();
  });

  it('does not expose legacy short adapter aliases', () => {
    expect(exportsMap['./openai']).toBeUndefined();
    expect(exportsMap['./anthropic']).toBeUndefined();
    expect(exportsMap['./gemini']).toBeUndefined();
    expect(exportsMap['./open-ai/agents']).toBeUndefined();
  });

  it('exposes lazy provider import helpers on createToolbox', () => {
    expect(root.createToolbox.fromProvider).toBeDefined();
    expect(root.createToolbox.fromOpenAITools).toBeDefined();
    expect(root.createToolbox.fromAnthropicTools).toBeDefined();
    expect(root.createToolbox.fromGeminiTools).toBeDefined();
  });

  it('exposes shared interop materializers and types on the root surface', () => {
    expect(root.materializeToolCall).toBeDefined();
    expect(root.materializeToolCalls).toBeDefined();
    expect(root.materializeToolResult).toBeDefined();
    expect(root.materializeToolResultsAsync).toBeDefined();
  });

  it('exports the external execution projection type from the root surface', () => {
    expect(rootSource).toContain('ExternalExecutionProjection');
  });

  it('documents the complete durable approval state store contract', () => {
    const approvalSection = readme.slice(
      readme.indexOf('## Approval Flows'),
      readme.indexOf('### Request Authority and Execution Projections'),
    );

    expect(approvalSection).toContain('approvalStateStore');
    expect(approvalSection).toContain('sharedDurableApprovalStore');
    expect(approvalSection).toContain('recoveredToolbox.resumeApproval');
    for (const method of [
      'issue(binding)',
      'reserve(binding, context, now)',
      'commit(binding)',
      'release(binding)',
      'consume(binding, context, now)',
      'revoke(binding)',
      'state(binding)',
    ]) {
      expect(approvalSection).toContain(method);
    }
  });

  it('uses dynamic imports for provider adapters in createToolbox', () => {
    const source = readFileSync(new URL('../src/create-toolbox.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/await import\('\.\/adapters\/openai'\)/);
    expect(source).toMatch(/await import\(\s*'\.\/adapters\/anthropic'\s*\)/);
    expect(source).toMatch(/await import\('\.\/adapters\/gemini'\)/);
    expect(source).not.toMatch(
      /import\s+\{[^}]+\}\s+from\s+['"]\.\/adapters\/(?:openai|anthropic|gemini)['"]/,
    );
    expect(source).not.toMatch(
      /import\s+\*\s+as\s+\w+\s+from\s+['"]\.\/adapters\/(?:openai|anthropic|gemini)['"]/,
    );
  });
});
