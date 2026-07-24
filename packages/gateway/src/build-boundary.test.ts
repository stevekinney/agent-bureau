import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'bun:test';

describe('Gateway build boundary', () => {
  it('keeps the scoped Operative root and subpaths external', async () => {
    const buildSource = await readFile(new URL('../scripts/build.ts', import.meta.url), 'utf-8');

    expect(buildSource).toContain("'@lostgradient/operative',");
    expect(buildSource).toContain("'@lostgradient/operative/*',");
    expect(buildSource).not.toContain("'operative',");
  });
});
