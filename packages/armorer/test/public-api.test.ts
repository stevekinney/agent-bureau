import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import * as root from '../src';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  exports?: Record<string, unknown>;
};

describe('public API export map', () => {
  const exportsMap = pkg.exports ?? {};

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
    expect(root.createToolbox.fromOpenAITools).toBeDefined();
    expect(root.createToolbox.fromAnthropicTools).toBeDefined();
    expect(root.createToolbox.fromGeminiTools).toBeDefined();
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
