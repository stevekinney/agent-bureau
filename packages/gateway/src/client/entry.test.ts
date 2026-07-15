import { describe, expect, it } from 'bun:test';

const entryPath = `${import.meta.dir}/entry.ts`;

describe('Gateway client styles', () => {
  it('does not maintain a separate Cinder component stylesheet list', async () => {
    const entry = await Bun.file(entryPath).text();

    expect(entry).not.toMatch(/@lostgradient\/cinder\/.+\/styles/);
    expect(entry).not.toContain('@lostgradient/cinder/styles/all');
  });
});
