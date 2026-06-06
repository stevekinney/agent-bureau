import { $ } from 'bun';
import { SveltePlugin } from 'bun-plugin-svelte';

/**
 * Gateway build: one unified pipeline that emits both the server bundle and
 * the hydration client bundle, then writes a single `dist/manifest.json`
 * and a single `dist/public/styles.css`.
 *
 * Both passes load the official Bun Svelte plugin and force
 * `conditions: ['svelte']` so cinder (and our own `.svelte` files) resolve
 * to raw `src/` and are compiled by the single installed Svelte version —
 * never cinder's prebuilt `dist/`, which would couple us to its build-time
 * `svelte/internal/*`.
 */

await $`rm -rf dist`;

// ── PASS 1 — SERVER (SSR) ───────────────────────────────────────────
// `target: 'bun'` makes the Svelte plugin emit `generate: 'server'`. The
// server graph reaches `app.svelte` via create-gateway -> pages.ts, so the
// plugin compiles those (and cinder's `.svelte`) to SSR output. `svelte`
// itself stays external so the bundle imports `svelte/server` and
// `svelte/internal/server` from the single installed version at runtime.
const serverResult = await Bun.build({
  entrypoints: ['./src/index.ts', './src/events.ts'],
  outdir: './dist',
  root: './src',
  target: 'bun',
  format: 'esm',
  // Default naming keeps entries flat (`index.js`, `events.js`) AND lets the
  // cinder side-effect CSS asset retain its `.css` extension. The former
  // `'[dir]/[name].js'` string override forced that asset to `index.js`,
  // colliding with the entry now that the server graph pulls in `.svelte`.
  sourcemap: 'external',
  minify: true,
  conditions: ['svelte'],
  external: [
    'hono',
    'hono/*',
    '@hono/node-server',
    '@hono/node-server/*',
    'svelte',
    'svelte/*',
    'operative',
    'sentinel',
    'herald',
    'armorer',
    'conversationalist',
    'lifecycle',
    'lifecycle/*',
    'memory',
    'memory/*',
    'storage',
    'zod',
  ],
  plugins: [SveltePlugin()],
});

if (!serverResult.success) {
  console.error('Server build failed:', serverResult.logs);
  process.exit(1);
}

// Drop the SSR pass's stray CSS assets. Cinder's `.svelte` files
// side-effect `import './<name>.css'`, so the server pass emits CSS even
// though SSR never references it — only the client-pass CSS feeds the
// linked `/public/styles.css`. Removing it keeps `dist/` clean and avoids
// a dead `*.css` sitting next to the server entry.
for (const output of serverResult.outputs) {
  if (output.path.endsWith('.css')) {
    await $`rm -f ${output.path}`;
  }
}

// ── PASS 2 — CLIENT (DOM / hydrate) ─────────────────────────────────
// `target: 'browser'` makes the Svelte plugin emit `generate: 'client'`.
// Bundle the svelte runtime AND cinder's compiled component graph (browsers
// can't resolve bare specifiers). Per-component CSS (external `.css`
// side-effect imports plus compiled `<style>` blocks emitted as virtual
// CSS) flows through this pass's CSS outputs.
const clientResult = await Bun.build({
  entrypoints: ['./src/client/entry.ts'],
  outdir: './dist/public',
  target: 'browser',
  format: 'esm',
  splitting: true,
  naming: '[name]-[hash].[ext]',
  sourcemap: 'external',
  minify: true,
  conditions: ['svelte'],
  plugins: [SveltePlugin()],
});

if (!clientResult.success) {
  console.error('Client build failed:', clientResult.logs);
  process.exit(1);
}

// ── MANIFEST ────────────────────────────────────────────────────────
// Map each hashed client output back to its logical name. Bun's content
// hash uses a base-36 alphabet (0-9a-z), so strip a `-<hash>` segment that
// sits immediately before the file extension. The prior `/-[a-f0-9]+\./`
// regex silently failed on non-hex hashes and fell back to '/public/entry.js'.
const manifest: Record<string, string> = {};
for (const output of clientResult.outputs) {
  const filename = output.path.split('/').pop();
  if (!filename) continue;
  const logical = filename.replace(/-[0-9a-z]+(\.[a-z0-9]+)$/, '$1');
  manifest[logical] = `/public/${filename}`;
}

// ── CSS ─────────────────────────────────────────────────────────────
// Compose a single deterministic stylesheet the HTML shell links as
// /public/styles.css. Cinder is import-order-sensitive (its @layer order is
// declared by the `styles/all` base, imported first in entry.ts), so the
// client-pass CSS — base + tokens + foundation + per-component CSS +
// compiled `<style>` blocks + utilities — comes first, followed by any
// hand-written gateway app CSS under src/ui/styles/.
const cssOutputs = clientResult.outputs
  .filter((output) => output.path.endsWith('.css'))
  .sort((a, b) => a.path.localeCompare(b.path));

let cssBundle = '';
for (const output of cssOutputs) {
  cssBundle += await output.text();
  cssBundle += '\n';
}

const styleGlob = new Bun.Glob('src/ui/styles/*.css');
const stylePaths: string[] = [];
for await (const path of styleGlob.scan('.')) {
  stylePaths.push(path);
}
stylePaths.sort();
for (const path of stylePaths) {
  cssBundle += await Bun.file(path).text();
  cssBundle += '\n';
}

await Bun.write('./dist/public/styles.css', cssBundle);
manifest['styles.css'] = '/public/styles.css';

await Bun.write('./dist/manifest.json', JSON.stringify(manifest, null, 2));

console.log('Build complete!');
console.log('  Server:', serverResult.outputs.length, 'files');
console.log('  Client:', clientResult.outputs.length, 'files');
console.log(
  '  CSS bundle:',
  cssBundle.length,
  'bytes from',
  cssOutputs.length,
  'client +',
  stylePaths.length,
  'app sources',
);
console.log('  Manifest:', Object.keys(manifest).length, 'entries');
