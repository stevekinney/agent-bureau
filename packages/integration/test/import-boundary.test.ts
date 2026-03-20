import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const entryPath = join(directory, entry);
    const stats = statSync(entryPath);
    return stats.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

describe('integration package import boundaries', () => {
  it('does not import sibling src or dist files', () => {
    const directory = new URL('.', import.meta.url).pathname;
    const files = walk(directory).filter(
      (path) => path.endsWith('.ts') || path.endsWith('.js') || path.endsWith('.mjs'),
    );
    const restrictedImportPattern =
      /\b(?:from|import\s*\()\s*['"][^'"]*(?:\/src(?:\/|['"])|\/dist(?:\/|['"]))|(?:\.\.\/src|\.\/dist|armorer\/dist|conversationalist\/dist)/;

    for (const filePath of files) {
      const contents = readFileSync(filePath, 'utf8');
      expect(contents).not.toMatch(restrictedImportPattern);
    }
  });
});
