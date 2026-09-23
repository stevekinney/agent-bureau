import { defineConfig } from 'tsdown';

/**
 * Single public export, mirroring corvidae's `{".": "./src/index.ts"}` — this package has no
 * subpath exports today. Modeled on `packages/armorer/tsdown.config.ts` and
 * `packages/operative/tsdown.config.ts`.
 *
 * package-surface.json's `build.scripts` merges `"build": "tsdown"` onto this manifest's
 * `scripts` block on every sync, overwriting the target's own `"build": "bun run scripts/build.ts"`
 * — this file is what makes that overwritten command actually work. `scripts/build.ts` becomes
 * dead after the merge (the transform never prunes a target-owned build input, so it survives
 * unreferenced; see the report for this finding).
 */
const entry = {
  index: './src/index.ts',
};

export default defineConfig({
  entry,
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  platform: 'neutral',
  tsconfig: './tsconfig.build.json',
  // No foundation workspace dependencies to inline: corvidae's package.json declares no runtime
  // `dependencies` for this package (armorer, conversationalist, operative and others depend ON
  // it, not the reverse). Only the runtime itself is external.
  deps: {
    neverBundle: [/^bun(:|$)/, /^node:/],
  },
});
