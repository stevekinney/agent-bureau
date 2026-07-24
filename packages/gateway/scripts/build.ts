import { $ } from 'bun';
import { SveltePlugin } from 'bun-plugin-svelte';

/**
 * Gateway build: one unified pipeline that emits both the server bundle and
 * the hydration client bundle, then writes a single `dist/manifest.json`
 * and a single `dist/public/styles.css`.
 *
 * Both passes load the official Bun Svelte plugin. Gateway consumes Cinder's
 * published component output instead of forcing Cinder's source condition, so
 * the build stays aligned with the package's public contract.
 */

await $`rm -rf dist`;

// ── PASS 1 — SERVER (SSR) ───────────────────────────────────────────
// `target: 'bun'` makes the Svelte plugin emit `generate: 'server'`. The
// server graph reaches `app.svelte` via create-gateway -> pages.ts, so the
// plugin compiles those files to SSR output. `svelte` itself stays external
// so the bundle imports `svelte/server` and `svelte/internal/server` from the
// single installed version at runtime.
const serverResult = await Bun.build({
  // `start.ts` (the process entrypoint — see documentation/deployment.md)
  // is built here, not just run from source, because `server/render.ts`
  // only serves the content-hashed client bundle (`dist/public/entry-<hash>.js`)
  // when it detects it is running from `dist/` (via `import.meta.url`); run
  // from source it degrades to unhashed `/public/entry.js` URLs, which do
  // not exist on disk (only the hashed files do) and 404 the client
  // bundle. `bun run dist/start.js` — not `bun run src/start.ts` — is the
  // correct way to run this in production; the reference Dockerfile does
  // this.
  entrypoints: ['./src/index.ts', './src/events.ts', './src/start.ts'],
  outdir: './dist',
  root: './src',
  target: 'bun',
  format: 'esm',
  // Default naming keeps entries flat (`index.js`, `events.js`, `start.js`)
  // and preserves non-entry asset extensions if a future server graph
  // emits them.
  sourcemap: 'external',
  minify: true,
  external: [
    'hono',
    'hono/*',
    '@hono/node-server',
    '@hono/node-server/*',
    'svelte',
    'svelte/*',
    'operative',
    '@lostgradient/operative/*',
    'armorer',
    'bureau',
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

// ── PASS 2 — CLIENT (DOM / hydrate) ─────────────────────────────────
// `target: 'browser'` makes the Svelte plugin emit `generate: 'client'`.
// Bundle the Svelte runtime and Cinder's component graph because browsers
// cannot resolve bare specifiers. Component CSS flows through this pass's
// CSS outputs.
const clientResult = await Bun.build({
  entrypoints: ['./src/client/entry.ts'],
  outdir: './dist/public',
  target: 'browser',
  format: 'esm',
  splitting: true,
  naming: '[name]-[hash].[ext]',
  sourcemap: 'external',
  minify: true,
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
// /public/styles.css. entry.ts imports Cinder's base layer, while rendered
// component entrypoints contribute their own CSS to the client graph. That
// client-pass CSS comes before Gateway app CSS under src/ui/styles/.
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

// These selectors come from components rendered by the Gateway client. Keep
// this check in the production build so missing Cinder side effects fail the
// artifact-producing path itself rather than a second, test-only Svelte build.
for (const selector of ['.cinder-card', '.cinder-textarea']) {
  if (!cssBundle.includes(selector)) {
    throw new Error(`Client CSS bundle is missing required selector: ${selector}`);
  }
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
