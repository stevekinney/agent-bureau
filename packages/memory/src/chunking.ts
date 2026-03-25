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
}

const DEFAULT_MAXIMUM_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;
const CHARACTERS_PER_TOKEN = 4;

/**
 * Splits markdown content into overlapping chunks based on token estimates.
 *
 * Uses a character-count heuristic (~4 characters per token) to estimate
 * token boundaries. Splits on line boundaries when possible, falling back
 * to character-level splitting for very long lines.
 */
export function chunkMarkdown(content: string, options?: ChunkingOptions): ContentChunk[] {
  if (!content || content.trim().length === 0) return [];

  const maximumTokens = options?.maximumTokens ?? DEFAULT_MAXIMUM_TOKENS;
  const overlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;

  const maximumCharacters = maximumTokens * CHARACTERS_PER_TOKEN;
  const overlapCharacters = overlapTokens * CHARACTERS_PER_TOKEN;

  const lines = content.split('\n');
  const chunks: ContentChunk[] = [];

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

    chunks.push({
      text,
      startLine: chunkStartLine,
      endLine,
      index: chunks.length,
    });

    // Carry forward overlap from the trailing lines.
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
        currentCharacters = segment.length;
        flushChunk(lineIndex);
        offset += maximumCharacters;
      }
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

  return chunks;
}
