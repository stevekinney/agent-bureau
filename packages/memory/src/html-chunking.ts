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

/** Common named HTML entities decoded outside of numeric character references. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u0020',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;

/** Decodes numeric and common named HTML entities so stored text matches what a reader sees. */
function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value;

  return value.replace(ENTITY_PATTERN, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }

    return NAMED_ENTITIES[entity] ?? match;
  });
}

/**
 * Strips an HTML document down to plain text plus heading-derived structure
 * hints, using Bun's built-in `HTMLRewriter` (no DOM dependency). Script,
 * style, and template content is dropped (including nested elements); block-level
 * elements force a line break so paragraphs and headings don't run together;
 * whitespace-only text between inline elements is normalized to a single space
 * instead of being dropped.
 */
async function extractTextFromHtml(
  html: string,
): Promise<{ text: string; structure: StructureHint[] }> {
  let output = '';
  const structure: StructureHint[] = [];
  let skipDepth = 0;
  let headingAccumulator: string[] | null = null;
  let needsSpace = false;

  const appendText = (raw: string) => {
    if (skipDepth > 0) return;

    const value = decodeHtmlEntities(raw);
    if (value.trim().length === 0) {
      if (value.length > 0 && output.length > 0 && !/\s$/.test(output)) {
        needsSpace = true;
      }
      return;
    }

    if (needsSpace) {
      output += ' ';
      needsSpace = false;
    }

    if (headingAccumulator !== null) {
      headingAccumulator.push(value);
    }

    output += value;
  };

  const rewriter = new HTMLRewriter()
    .on('*', {
      element(element: HTMLRewriterTypes.Element) {
        const tag = element.tagName.toLowerCase();

        if (SKIPPED_TAGS.has(tag)) {
          skipDepth++;
          element.onEndTag(() => {
            skipDepth = Math.max(0, skipDepth - 1);
          });
          return;
        }

        if (skipDepth > 0) return;

        if (HEADING_TAG_PATTERN.test(tag)) {
          if (output.length > 0 && !output.endsWith('\n')) output += '\n';
          needsSpace = false;

          const startLine = output.split('\n').length - 1;
          const accumulator: string[] = [];
          headingAccumulator = accumulator;

          element.onEndTag(() => {
            if (headingAccumulator === accumulator) {
              headingAccumulator = null;
            }
            const label = accumulator.join('').trim();
            if (label.length > 0) {
              structure.push({ startLine, label });
            }
          });
        } else if (BLOCK_TAGS.has(tag)) {
          if (output.length > 0 && !output.endsWith('\n')) output += '\n';
          needsSpace = false;
        }
      },
    })
    .onDocument({
      text(text: HTMLRewriterTypes.Text) {
        appendText(text.text);
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
