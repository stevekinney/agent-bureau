import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Component } from 'svelte';
import { render } from 'svelte/server';

type AssetManifest = Record<string, string>;

let cachedManifest: AssetManifest | undefined;

/**
 * Loads the build manifest that maps logical client-entry names to their
 * content-hashed public URLs (e.g. `entry.js` -> `/public/entry-<hash>.js`).
 * The manifest is written by `scripts/build.ts` to `dist/manifest.json`,
 * which resolves relative to this module's compiled location in the flat
 * `dist/` output. A missing manifest degrades gracefully to the
 * unhashed `/public/*` fallbacks used during development.
 */
async function loadManifest(): Promise<AssetManifest> {
  if (cachedManifest) return cachedManifest;
  try {
    // Bun bundles the whole server graph flat into `dist/index.js`, so at
    // runtime `import.meta.url` resolves to `dist/`, and the manifest sits
    // alongside it at `dist/manifest.json`.
    const currentDirectory = dirname(fileURLToPath(import.meta.url));
    const manifestPath = resolve(currentDirectory, 'manifest.json');
    const raw = await readFile(manifestPath, 'utf-8');
    cachedManifest = JSON.parse(raw) as AssetManifest;
  } catch {
    cachedManifest = {};
  }
  return cachedManifest;
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Escapes a serialized JSON payload so it can be embedded inside a
 * `<script>` tag without prematurely closing it (`</script>`) or breaking
 * on the U+2028 / U+2029 line terminators that are valid in JSON but
 * illegal in JavaScript string literals. Mirrors the XSS-escaping the
 * former React render path performed.
 */
function serializeInitialData(data: unknown): string {
  return JSON.stringify(data)
    .replaceAll('<', '\\u003c')
    .replaceAll(LINE_SEPARATOR, '\\u2028')
    .replaceAll(PARAGRAPH_SEPARATOR, '\\u2029');
}

/**
 * A Svelte page component accepting the canonical app props. Generic over
 * the props so {@link renderPage} can render either the real {@link App}
 * or a test fixture without coupling to a single component.
 */
export type PageComponent<Props extends Record<string, unknown>> = Component<Props>;

interface RenderPageOptions<Props extends Record<string, unknown>> {
  /** Document `<title>`. */
  title: string;
  /** The Svelte component to server-render into `<div id="root">`. */
  component: PageComponent<Props>;
  /** Props passed to the component. */
  props: Props;
  /**
   * Data serialized into `window.__INITIAL_DATA__` for the client to
   * hydrate from. Defaults to `props` when omitted, since the app's props
   * are themselves the hydration payload in the common case.
   */
  data?: unknown;
}

/**
 * Server-renders a Svelte page into the gateway's HTML document shell.
 *
 * This is the single source of truth for page markup: Svelte produces the
 * body (and any head markup) via `render()` from `svelte/server`, and the
 * shell contributes only the genuinely load-bearing server output — the
 * `#root` mount point, the escaped `window.__INITIAL_DATA__` injection,
 * the cinder stylesheet link for a styled first paint, and the hashed
 * client module `<script>` resolved through the build manifest.
 *
 * Returned as an HTML string (Hono wraps it in a `Response`); unlike the
 * former React streaming path, the Svelte SSR renderer is synchronous.
 */
export async function renderPage<Props extends Record<string, unknown>>({
  title,
  component,
  props,
  data,
}: RenderPageOptions<Props>): Promise<string> {
  const manifest = await loadManifest();
  const clientScript = manifest['entry.js'] ?? '/public/entry.js';
  const stylesheet = manifest['styles.css'] ?? '/public/styles.css';

  const output = render(component, { props });
  const serializedData = serializeInitialData(data ?? props);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="${stylesheet}" />
    ${output.head}
  </head>
  <body>
    <div id="root">${output.body}</div>
    <script>window.__INITIAL_DATA__ = ${serializedData};</script>
    <script type="module" src="${clientScript}"></script>
  </body>
</html>`;
}
