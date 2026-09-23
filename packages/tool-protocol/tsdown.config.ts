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
  // `@lostgradient/lifecycle` is a foundation workspace package this package depends on
  // (corvidae's `dependencies`), so — matching armorer's and operative's convention — it is
  // deliberately NOT listed here and gets inlined into both the runtime and declaration output.
  deps: {
    neverBundle: [/^bun(:|$)/, /^node:/],
  },
});
