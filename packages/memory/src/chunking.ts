export interface ChunkingOptions {
  /** Maximum tokens per chunk. Default: 400 */
  maximumTokens?: number;
  /** Overlap tokens between adjacent chunks. Default: 80 */
  overlapTokens?: number;
}

export interface ContentChunk {
  text: string;
  startLine: number;
  endLine: number;
  index: number;
  /** Nearest structural label (e.g. heading text) covering this chunk, when known. */
  heading?: string;
}

/**
 * A structural boundary within pre-extracted text, e.g. a heading or page
 * break reported by an external extractor. `startLine` is the 0-based line
 * (within {@link ExtractedDocument.text}) where the structural unit begins.
 */
export interface StructureHint {
  startLine: number;
  /** Label for the unit, e.g. a heading's text or "page 3". */
  label?: string;
}

/**
 * The ingestion contract for callers that have already extracted plain text
 * from a non-Markdown source (PDF, DOCX, a custom parser, ...) and optionally
 * know its structure. Chunk boundaries never cross a structure hint, so
 * sections stay intact even when they are shorter than `maximumTokens`.
 */
export interface ExtractedDocument {
  text: string;
  /** Structural boundaries within `text`, sorted or unsorted. */
  structure?: StructureHint[];
}

const DEFAULT_MAXIMUM_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;
const CHARACTERS_PER_TOKEN = 4;

interface ResolvedChunkingOptions {
  maximumTokens: number;
  overlapTokens: number;
}

function resolveOptions(options?: ChunkingOptions): ResolvedChunkingOptions {
  const maximumTokens = Math.max(1, options?.maximumTokens ?? DEFAULT_MAXIMUM_TOKENS);
  const rawOverlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  // Clamp overlap to less than the chunk size to prevent duplicate chunks.
  const overlapTokens = Math.min(rawOverlapTokens, Math.max(0, maximumTokens - 1));
  return { maximumTokens, overlapTokens };
}

interface LineChunk {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Splits an array of lines into overlapping chunks based on token estimates.
 * `startLine`/`endLine` on the result are relative to `lines` (index 0 is
 * `lines[0]`); callers that are chunking a section of a larger document add
 * their own line offset afterward.
 */
function chunkLines(lines: string[], resolved: ResolvedChunkingOptions): LineChunk[] {
  const { maximumTokens, overlapTokens } = resolved;
  const maximumCharacters = maximumTokens * CHARACTERS_PER_TOKEN;
  const overlapCharacters = overlapTokens * CHARACTERS_PER_TOKEN;

  const result: LineChunk[] = [];

  let currentLines: string[] = [];
  let currentCharacters = 0;
  let chunkStartLine = 0;

  function flushChunk(endLine: number): void {
    if (currentLines.length === 0) return;

    const text = currentLines.join('\n');
    if (text.trim().length === 0) {
      currentLines = [];
      currentCharacters = 0;
      return;
    }

    result.push({ text, startLine: chunkStartLine, endLine });

    // Carry forward overlap from the trailing lines.
    if (overlapCharacters === 0) {
      currentLines = [];
      currentCharacters = 0;
      chunkStartLine = endLine + 1;
    } else {
      const overlapLines: string[] = [];
      let overlapSize = 0;
      for (let i = currentLines.length - 1; i >= 0; i--) {
        const lineSize = currentLines[i]!.length + 1; // +1 for newline
        if (overlapSize + lineSize > overlapCharacters && overlapLines.length > 0) break;
        overlapLines.unshift(currentLines[i]!);
        overlapSize += lineSize;
      }

      currentLines = overlapLines;
      currentCharacters = overlapSize;
      chunkStartLine = endLine - overlapLines.length + 1;
    }
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const lineLength = line.length + 1; // +1 for newline

    // Handle very long lines by splitting into segments.
    if (lineLength > maximumCharacters) {
      // Flush any accumulated content first.
      if (currentLines.length > 0) {
        flushChunk(lineIndex - 1);
      }

      // Split the long line into character-level segments.
      let offset = 0;
      while (offset < line.length) {
        const segment = line.slice(offset, offset + maximumCharacters);
        chunkStartLine = lineIndex;
        currentLines = [segment];
        flushChunk(lineIndex);
        offset += maximumCharacters;
      }

      // Clear residual overlap so the final flush does not re-emit the last segment.
      currentLines = [];
      currentCharacters = 0;
      chunkStartLine = lineIndex + 1;
      continue;
    }

    // If adding this line would exceed the limit, flush first.
    if (currentCharacters + lineLength > maximumCharacters && currentLines.length > 0) {
      flushChunk(lineIndex - 1);
    }

    if (currentLines.length === 0) {
      chunkStartLine = lineIndex;
    }

    currentLines.push(line);
    currentCharacters += lineLength;
  }

  // Flush any remaining content.
  if (currentLines.length > 0) {
    flushChunk(lines.length - 1);
  }

  return result;
}

/**
 * Splits markdown content into overlapping chunks based on token estimates.
 *
 * Uses a character-count heuristic (~4 characters per token) to estimate
 * token boundaries. Splits on line boundaries when possible, falling back
 * to character-level splitting for very long lines.
 */
export function chunkMarkdown(content: string, options?: ChunkingOptions): ContentChunk[] {
  if (!content || content.trim().length === 0) return [];

  const resolved = resolveOptions(options);
  const lines = content.split('\n');

  return chunkLines(lines, resolved).map((chunk, index) => ({ ...chunk, index }));
}

/**
 * Splits pre-extracted text into overlapping chunks, respecting structural
 * boundaries when provided. This is the ingestion contract for loaders that
 * extract text outside this package (HTML, PDF, DOCX, ...): they hand back
 * plain text plus optional {@link StructureHint}s, and chunking never merges
 * content across a hint boundary.
 *
 * With no `structure` hints, this behaves like {@link chunkMarkdown}.
 */
export function chunkText(document: ExtractedDocument, options?: ChunkingOptions): ContentChunk[] {
  const { text, structure } = document;
  if (!text || text.trim().length === 0) return [];

  const resolved = resolveOptions(options);
  const lines = text.split('\n');

  if (!structure || structure.length === 0) {
    return chunkLines(lines, resolved).map((chunk, index) => ({ ...chunk, index }));
  }

  // Sort and clamp hint boundaries into range, always including line 0 so the
  // first section is covered even when no hint targets it.
  const boundaries = Array.from(
    new Set([
      0,
      ...structure.map((hint) => Math.max(0, Math.min(hint.startLine, lines.length - 1))),
    ]),
  ).sort((a, b) => a - b);

  const labelByStartLine = new Map<number, string>();
  for (const hint of structure) {
    if (hint.label !== undefined) {
      const clamped = Math.max(0, Math.min(hint.startLine, lines.length - 1));
      labelByStartLine.set(clamped, hint.label);
    }
  }

  const chunks: ContentChunk[] = [];
  let currentLabel: string | undefined;

  for (let sectionIndex = 0; sectionIndex < boundaries.length; sectionIndex++) {
    const sectionStart = boundaries[sectionIndex]!;
    const sectionEnd = boundaries[sectionIndex + 1] ?? lines.length;
    if (labelByStartLine.has(sectionStart)) {
      currentLabel = labelByStartLine.get(sectionStart);
    }

    const sectionLines = lines.slice(sectionStart, sectionEnd);
    const sectionChunks = chunkLines(sectionLines, resolved);

    for (const chunk of sectionChunks) {
      chunks.push({
        text: chunk.text,
        startLine: chunk.startLine + sectionStart,
        endLine: chunk.endLine + sectionStart,
        index: chunks.length,
        ...(currentLabel !== undefined ? { heading: currentLabel } : {}),
      });
    }
  }

  return chunks;
}
