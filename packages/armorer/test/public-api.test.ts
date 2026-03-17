import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

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
});
