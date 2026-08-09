/**
 * Extracts the markup server-rendered into the application root, excluding
 * the serialized hydration data that follows it.
 */
export function extractRootMarkup(html: string): string {
  const match = html.match(/<div id="root">(.*?)<\/div>\s*<script>window\.__INITIAL_DATA__/s);
  if (!match) {
    throw new Error('#root mount not found in SSR output');
  }
  return match[1] ?? '';
}

/** Svelte SSR anchor comments that delimit a hydratable dynamic region. */
const hydrationMarker = /<!--[[\]][^>]*-->/g;

/**
 * Strips the Svelte SSR hydration anchors (`<!--[-->`, `<!--[0-->`, `<!--]-->`)
 * that wrap dynamic regions in server-rendered markup. They contribute no text
 * and are invisible to the accessibility tree, so assertions about rendered
 * copy should compare against the stripped form rather than coupling to a
 * component's internal choice of static text versus a dynamic expression.
 */
export function stripHydrationMarkers(markup: string): string {
  return markup.replaceAll(hydrationMarker, '');
}
