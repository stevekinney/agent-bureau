import type { ChunkingOptions, ContentChunk, StructureHint } from './chunking';
import { chunkText } from './chunking';

/** Tags whose content is dropped entirely (never contributes to extracted text). */
const SKIPPED_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/** Tags that force a line break before their content, so blocks don't run together. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'br',
  'tr',
  'section',
  'article',
  'header',
  'footer',
  'blockquote',
  'pre',
]);

const HEADING_TAG_PATTERN = /^h[1-6]$/;

/**
 * Strips an HTML document down to plain text plus heading-derived structure
 * hints, using Bun's built-in `HTMLRewriter` (no DOM dependency). Script,
 * style, and template content is dropped; block-level elements force a line
 * break so paragraphs and headings don't run together.
 */
async function extractTextFromHtml(
  html: string,
): Promise<{ text: string; structure: StructureHint[] }> {
  let output = '';
  const structure: StructureHint[] = [];
  let skipDepth = 0;
  let pendingHeadingLevel: number | null = null;

  const rewriter = new HTMLRewriter().on('*', {
    element(element: HTMLRewriterTypes.Element) {
      const tag = element.tagName.toLowerCase();

      if (SKIPPED_TAGS.has(tag)) {
        skipDepth++;
        element.onEndTag(() => {
          skipDepth = Math.max(0, skipDepth - 1);
        });
        return;
      }

      if (HEADING_TAG_PATTERN.test(tag)) {
        if (output.length > 0 && !output.endsWith('\n')) output += '\n';
        pendingHeadingLevel = Number(tag[1]);
      } else if (BLOCK_TAGS.has(tag)) {
        if (output.length > 0 && !output.endsWith('\n')) output += '\n';
      }
    },
    text(text: HTMLRewriterTypes.Text) {
      if (skipDepth > 0) return;

      const value = text.text;
      if (value.trim().length === 0) return;

      if (pendingHeadingLevel !== null) {
        const startLine = output.split('\n').length - 1;
        structure.push({ startLine, label: value.trim() });
        pendingHeadingLevel = null;
      }

      output += value;
    },
  });

  await rewriter.transform(new Response(html)).text();

  return { text: output, structure };
}

/**
 * First-party HTML loader: strips tags with a lightweight streaming parser
 * (Bun's `HTMLRewriter` — no heavyweight DOM dependency) and chunks the
 * result via {@link chunkText}, carrying heading text forward as each
 * chunk's `heading`.
 *
 * Matches the `chunk(document) -> chunks` loader contract so it can be
 * passed directly as `ingest()`'s `chunk` option.
 */
export async function chunkHtml(html: string, options?: ChunkingOptions): Promise<ContentChunk[]> {
  if (!html || html.trim().length === 0) return [];

  const { text, structure } = await extractTextFromHtml(html);
  return chunkText({ text, structure }, options);
}
