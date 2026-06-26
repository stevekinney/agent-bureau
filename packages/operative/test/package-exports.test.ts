import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import packageJson from '../package.json';

const packageRoot = join(import.meta.dir, '..');

const exports = packageJson.exports as Record<string, Record<string, string> | string>;

describe('operative package exports', () => {
  it('all dist-referencing exports map entries point to existing files', () => {
    const missing: string[] = [];

    for (const [subpath, conditions] of Object.entries(exports)) {
      if (typeof conditions === 'string') {
        if (
          conditions.startsWith('./dist/') &&
          !existsSync(join(packageRoot, conditions.slice(2)))
        ) {
          missing.push(`${subpath}: ${conditions}`);
        }
        continue;
      }
      for (const [condition, filePath] of Object.entries(conditions)) {
        if (filePath.startsWith('./dist/') && !existsSync(join(packageRoot, filePath.slice(2)))) {
          missing.push(`${subpath} [${condition}]: ${filePath}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('all per-provider embedding subpaths are in the exports map', () => {
    // These subpaths are built by scripts/build.ts as explicit entry points.
    // Add to this list when adding new public embedding provider entry points.
    const required = [
      './providers/embeddings/openai',
      './providers/embeddings/gemini',
      './providers/embeddings/voyage',
      './providers/embeddings/ollama',
    ];

    const exported = new Set(Object.keys(exports));
    const missing = required.filter((subpath) => !exported.has(subpath));
    expect(missing).toEqual([]);
  });

  it('the providers/instrumentation subpath is in the exports map', () => {
    const exported = new Set(Object.keys(exports));
    expect(exported.has('./providers/instrumentation')).toBe(true);
  });
});
