/**
 * Normalizes line endings to LF (\n).
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
