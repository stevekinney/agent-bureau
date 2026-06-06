import { join } from 'node:path';

import { Glob } from 'bun';
import { describe, expect, it } from 'bun:test';

/**
 * PACKAGE BOUNDARY: Cloudflare-specific dependencies (Vectorize, Durable Objects,
 * Wrangler, `@cloudflare/workers-types`, the `cloudflare:` builtins) must stay
 * inside `packages/cloudflare`. Every other package targets a runtime-agnostic
 * surface; leaking a Workers-only import elsewhere would couple the whole
 * monorepo to workerd.
 *
 * This scans IMPORT/REQUIRE SPECIFIERS only — not prose — because the merged
 * `memory/src/memory-record-storage.ts` JSDoc legitimately mentions "Vectorize"
 * and "Cloudflare" while importing none of it. Matching module specifiers (and
 * imported binding names like `DurableObject`/`Vectorize`) avoids that
 * false-positive while still catching a real leak.
 */

/** Module specifiers that only the cloudflare package may import. */
const FORBIDDEN_SPECIFIER = /(?:from|require\()\s*['"](?:@cloudflare\/|cloudflare:)/;
/**
 * Workers-only binding names imported as values/types from any specifier — e.g.
 * `import type { DurableObject, Vectorize } from '...'`. Plain prose using these
 * words is not an `import` line, so it never matches.
 */
const FORBIDDEN_BINDING =
  /^\s*import\s+(?:type\s+)?[^;]*\b(?:DurableObject|Vectorize|VectorizeIndex)\b[^;]*\bfrom\b/m;

const PACKAGES_DIR = join(import.meta.dir, '..', '..');

async function nonCloudflareSourceFiles(): Promise<string[]> {
  const glob = new Glob('*/src/**/*.ts');
  const files: string[] = [];
  for await (const relative of glob.scan({ cwd: PACKAGES_DIR })) {
    if (relative.startsWith('cloudflare/')) continue;
    files.push(join(PACKAGES_DIR, relative));
  }
  return files;
}

describe('cloudflare dependencies stay inside packages/cloudflare', () => {
  it('finds source files to scan (guards against a broken glob silently passing)', async () => {
    const files = await nonCloudflareSourceFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('no non-cloudflare package imports a Workers-only module or binding', async () => {
    const files = await nonCloudflareSourceFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const source = await Bun.file(file).text();
      for (const line of source.split('\n')) {
        if (FORBIDDEN_SPECIFIER.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
      if (FORBIDDEN_BINDING.test(source)) {
        offenders.push(`${file}: imports a Workers-only binding (DurableObject/Vectorize)`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
