import { plugin } from 'bun';
import { SveltePlugin } from 'bun-plugin-svelte';

/**
 * Registers the official Bun Svelte plugin as a runtime loader so that
 * `.svelte` imports compile on the fly when the gateway runs from source
 * — under `bun run`, `bun --watch`, and `bun test`.
 *
 * The build pipeline (`scripts/build.ts`) registers the same plugin via
 * `Bun.build({ plugins: [...] })` to compile `.svelte` into `dist/`; this
 * preload covers the from-source paths that never touch the bundler.
 *
 * Wired through `bunfig.toml`:
 *   - top-level `preload` for `bun run` / `start` / `dev`
 *   - `[test].preload` for `bun test`
 *
 * The plugin's `onLoad` defaults the compile `side` to `'server'`, so the
 * default export becomes a real SSR component function usable by
 * `render()` from `svelte/server`. Despite the (stale) note in the
 * plugin README, server-side `.svelte` imports work today via this
 * runtime registration.
 */
plugin(SveltePlugin());
