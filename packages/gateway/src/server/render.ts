import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Component } from 'svelte';
import { render } from 'svelte/server';

type AssetManifest = Record<string, string>;

let cachedManifest: AssetManifest | undefined;

const currentDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * True when this module is running from the compiled `dist/` build rather than
 * from source. The build emits content-hashed assets and a `manifest.json`
 * alongside the bundled `dist/index.js`, so in this mode the manifest is
 * load-bearing: the unhashed `/public/*` URLs do not exist and a missing
 * manifest must fail loudly rather than serve a page with dead hydration.
 *
 * Checks the exact directory name (`dist`) rather than a substring of the full
 * path, so a source checkout living under a path that merely contains "dist"
 * (e.g. `/tmp/distilled-agent-bureau/...`) is not misclassified as built.
 */
const isBuiltOutput = basename(currentDirectory) === 'dist';

/**
 * Loads the build manifest that maps logical client-entry names to their
 * content-hashed public URLs (e.g. `entry.js` -> `/public/entry-<hash>.js`).
 *
 * The manifest is written by `scripts/build.ts` to `dist/manifest.json`,
 * which resolves relative to this module's compiled location in the flat
 * `dist/` output. In built (`dist/`) mode the manifest is required and a
 * missing or invalid one throws — serving the unhashed fallbacks there would
 * 404 the client bundle and silently break hydration. When running from
 * source (dev/test, no `dist/manifest.json`), the manifest is absent by
 * design and the caller degrades to the unhashed `/public/*` URLs.
 */
/** Manifest keys the built server must be able to resolve to hashed assets. */
const REQUIRED_MANIFEST_KEYS = ['entry.js', 'styles.css'] as const;

async function loadManifest(): Promise<AssetManifest> {
  if (cachedManifest) return cachedManifest;
  let manifest: AssetManifest;
  try {
    // Bun bundles the whole server graph flat into `dist/index.js`, so at
    // runtime `import.meta.url` resolves to `dist/`, and the manifest sits
    // alongside it at `dist/manifest.json`.
    const manifestPath = resolve(currentDirectory, 'manifest.json');
    const raw = await readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(raw) as AssetManifest;
  } catch (error) {
    if (isBuiltOutput) {
      throw new Error(
        'gateway: dist/manifest.json is missing or invalid. The built server ' +
          'requires the asset manifest to resolve content-hashed client bundles; ' +
          'rebuild with `bun run build`.',
        { cause: error },
      );
    }
    // From source there is no manifest by design; degrade to unhashed URLs.
    cachedManifest = {};
    return cachedManifest;
  }

  // A manifest that parses but omits a required key would otherwise fall through
  // to the unhashed `/public/*` URLs, which 404 in built mode → a 200 page with
  // dead hydration. Fail loudly instead.
  if (isBuiltOutput) {
    const missing = REQUIRED_MANIFEST_KEYS.filter((key) => !manifest[key]);
    if (missing.length > 0) {
      throw new Error(
        `gateway: dist/manifest.json is missing required ${missing.join(', ')} ` +
          'entr(y/ies). The built server cannot resolve content-hashed client ' +
          'bundles; rebuild with `bun run build`.',
      );
    }
  }

  cachedManifest = manifest;
  return cachedManifest;
}

/**
 * Escapes the five HTML metacharacters so untrusted text (e.g. a run id
 * embedded in the document `<title>`) cannot break out of its element or
 * inject markup. Mirrors the escaping React performed on text children.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
  // In built mode loadManifest() has already thrown if the manifest is absent,
  // so these keys are present; the `??` only covers from-source dev/test where
  // the unhashed `/public/*` URLs are the real assets.
  const clientScript = manifest['entry.js'] ?? '/public/entry.js';
  const stylesheet = manifest['styles.css'] ?? '/public/styles.css';

  const output = render(component, { props });
  const serializedData = serializeInitialData(data ?? props);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
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
