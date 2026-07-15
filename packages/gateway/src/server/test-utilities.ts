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
