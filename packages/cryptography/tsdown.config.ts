import { defineConfig } from 'tsdown';

/**
 * Single public export, mirroring corvidae's `{".": "./src/index.ts"}` — this package has no
 * subpath exports today. Modeled on `packages/armorer/tsdown.config.ts` and
 * `packages/operative/tsdown.config.ts`.
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
  // `dependencies` for this package. Only the runtime itself is external.
  deps: {
    neverBundle: [/^bun(:|$)/, /^node:/],
  },
});
