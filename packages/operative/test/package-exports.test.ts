import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { HandoffTarget } from '@lostgradient/operative';
import { createHandoffTool } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import conversationalistPackageJson from '../../conversationalist/package.json';
import packageJson from '../package.json';

const packageRoot = join(import.meta.dir, '..');
const distDir = join(packageRoot, 'dist');
const distBuilt = existsSync(distDir);

const exports = packageJson.exports as Record<string, Record<string, string> | string>;

describe('operative package exports', () => {
  it('declares the Node floor required by external ESM-only conversationalist', () => {
    // Asserts range/workspace compatibility rather than a literal range: the
    // release gate runs this suite on the already-versioned tree, where
    // `changeset version` may have rewritten the range (minor bumps) or left
    // it alone (patch bumps a caret range already covers), so any exact
    // string comparison breaks the gate by construction (agent-bureau#314).
    const declaredRange = packageJson.dependencies?.conversationalist;
    expect(declaredRange).toBeDefined();
    // A single caret range only — `satisfies` alone would also accept
    // over-broad declarations like `*`, `>=0`, or unioned carets, which
    // would let published operative installs resolve releases outside the
    // intended compatible train.
    expect(declaredRange).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(Bun.semver.satisfies(conversationalistPackageJson.version, declaredRange!)).toBe(true);
    expect(packageJson.engines?.node).toBe('>=20.19.0');
  });

  it('keeps conversationalist external for every output format', async () => {
    const buildConfiguration = await Bun.file(join(packageRoot, 'tsdown.config.ts')).text();

    expect(buildConfiguration).toContain("'conversationalist',");
    expect(buildConfiguration).toContain("'conversationalist/*',");
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

  it('all per-provider batch subpaths are in the exports map', () => {
    // One entry per provider with a native batch endpoint. There is
    // deliberately no OpenAI-compatible/local-server entry: those servers reuse
    // OpenAI's chat shape and implement no batches endpoint, so "unsupported"
    // is expressed as "nothing to import". Do not add one.
    const required = [
      './providers/batches',
      './providers/batches/anthropic',
      './providers/batches/openai',
      './providers/batches/gemini',
    ];

    const exported = new Set(Object.keys(exports));
    const missing = required.filter((subpath) => !exported.has(subpath));
    expect(missing).toEqual([]);
  });

  it('the providers/instrumentation subpath is in the exports map', () => {
    const exported = new Set(Object.keys(exports));
    expect(exported.has('./providers/instrumentation')).toBe(true);
  });

  it('re-exports HandoffTarget from the root barrel alongside createHandoffTool', () => {
    // Regression for a review finding: createHandoffTool's input shape
    // (HandoffTarget) was introduced but never re-exported from index.ts, so
    // consumers could call createHandoffTool but not name its `agent` option
    // type without reaching into the internal module path.
    const target: HandoffTarget = {
      agentName: 'writer',
      agent: { name: 'writer', run: () => Promise.resolve() as never },
    };
    const tool = createHandoffTool({ agent: target });
    expect(tool.name).toBe('transfer_to_writer');
  });
});
