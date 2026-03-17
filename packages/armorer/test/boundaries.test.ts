import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

describe('package dependency boundaries', () => {
  it('keeps MCP out of dependencies', () => {
    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBeUndefined();
  });

  it('declares MCP as an optional peer dependency', () => {
    expect(pkg.peerDependencies?.['@modelcontextprotocol/sdk']).toBeDefined();
    expect(pkg.peerDependenciesMeta?.['@modelcontextprotocol/sdk']?.optional).toBe(true);
  });
});
