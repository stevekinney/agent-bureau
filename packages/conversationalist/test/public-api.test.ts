import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  exports?: Record<string, unknown>;
};

describe('public API export map', () => {
  const exportsMap = pkg.exports ?? {};

  it('includes the canonical subpaths', () => {
    expect(exportsMap['./conversation']).toBeDefined();
    expect(exportsMap['./context']).toBeDefined();
    expect(exportsMap['./streaming']).toBeDefined();
    expect(exportsMap['./history']).toBeDefined();
    expect(exportsMap['./message']).toBeDefined();
    expect(exportsMap['./utilities']).toBeDefined();
    expect(exportsMap['./test']).toBeDefined();
    expect(exportsMap['./adapters/openai']).toBeDefined();
    expect(exportsMap['./adapters/anthropic']).toBeDefined();
    expect(exportsMap['./adapters/gemini']).toBeDefined();
    expect(exportsMap['./redaction']).toBeDefined();
  });

  it('does not expose removed alias subpaths', () => {
    expect(exportsMap['./openai']).toBeUndefined();
    expect(exportsMap['./anthropic']).toBeUndefined();
    expect(exportsMap['./gemini']).toBeUndefined();
    expect(exportsMap['./plugins']).toBeUndefined();
  });
});
