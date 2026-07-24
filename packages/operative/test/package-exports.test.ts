import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import packageJson from '../package.json';

const packageRoot = join(import.meta.dir, '..');
const distDir = join(packageRoot, 'dist');
const distBuilt = existsSync(distDir);

const exports = packageJson.exports as Record<string, Record<string, string> | string>;

describe('operative package exports', () => {
  it('declares the Node floor required by external ESM-only conversationalist', () => {
    expect(packageJson.dependencies?.conversationalist).toBe('^0.5.0');
    expect(packageJson.engines?.node).toBe('>=20.19.0');
  });

  // This assertion requires a prior build. It passes when run via `turbo run test`
  // (which declares "build" as a dependency) but is skipped on a clean checkout
  // where dist/ has not yet been produced.
  it.skipIf(!distBuilt)('all dist-referencing exports map entries point to existing files', () => {
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
