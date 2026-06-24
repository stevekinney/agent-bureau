export const DEFAULT_MAX_CHARACTERS = 8000;
export const DEFAULT_ERROR_MAX_CHARACTERS = 400;

export interface TruncationOptions {
  marker?: string;
}

export interface ToolResultTruncationOptions {
  maxCharacters?: number;
  errorMaxCharacters?: number;
  marker?: string;
  isError?: boolean;
  base64Placeholder?: string;
}

export interface StructuredToolResultTruncationOptions {
  maxBytes?: number;
  headBytes?: number;
  tailBytes?: number;
  base64Placeholder?: string;
}

export type StructuredToolResultTruncation = {
  head: string;
  tail: string;
  originalSize: number;
  omittedBytes: number;
  truncated: boolean;
};

const textEncoder = new TextEncoder();

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function safeSlice(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (text.length <= maxLength) return text;

  let slicePoint = maxLength;

  // If the character at slicePoint is a low surrogate (second half of a pair),
  // back up one to exclude the entire pair rather than splitting it.
  if (isLowSurrogate(text.charCodeAt(slicePoint))) {
    slicePoint -= 1;
  }

  // If the last character in the slice is an orphaned high surrogate
  // (its partner was excluded or doesn't exist), exclude it too.
  if (slicePoint > 0 && isHighSurrogate(text.charCodeAt(slicePoint - 1))) {
    const partnerCode = text.charCodeAt(slicePoint);
    if (!isLowSurrogate(partnerCode)) {
      slicePoint -= 1;
    }
  }

  return text.slice(0, slicePoint);
}

export function truncateText(
  text: string,
  maxCharacters: number,
  options?: TruncationOptions,
): string {
  if (text.length <= maxCharacters) return text;

  const marker = options?.marker ?? '\n…(truncated)…';

  if (maxCharacters <= marker.length) {
    return safeSlice(text, maxCharacters);
  }

  return safeSlice(text, maxCharacters - marker.length) + marker;
}

export function containsBase64Data(text: string): boolean {
  return /data:[^;]*;base64,/.test(text);
}

export function stripBase64Data(text: string, placeholder?: string): string {
  const replacement = placeholder ?? '[base64 data omitted]';
  return text.replace(/data:[^;]*;base64,[^\s)"']*/g, replacement);
}

/**
 * Wraps an async iterable, yielding chunks verbatim until the accumulated
 * character length exceeds `maxCharacters`. For string chunks the final partial
 * chunk is safely sliced (preserving surrogate pairs); for non-string chunks
 * the length is accounted via `JSON.stringify` but the original object is
 * yielded. Once the limit is reached, the truncation marker is emitted and
 * iteration stops.
 */
export async function* createTruncatingAsyncIterable<T>(
  source: AsyncIterable<T>,
  options?: { maxCharacters?: number; marker?: string },
): AsyncIterable<T | string> {
  const maxCharacters = options?.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const marker = options?.marker ?? '\n\u2026(truncated)\u2026';
  let accumulated = 0;

  for await (const chunk of source) {
    if (typeof chunk === 'string') {
      const remaining = maxCharacters - accumulated;

      if (chunk.length <= remaining) {
        accumulated += chunk.length;
        yield chunk;
      } else {
        // Partial yield: safely slice at the remaining boundary
        if (remaining > 0) {
          yield safeSlice(chunk, remaining) as T;
        }
        yield marker as T | string;
        return;
      }
    } else {
      const serialized = JSON.stringify(chunk);
      const length = serialized.length;
      const remaining = maxCharacters - accumulated;

      if (length <= remaining) {
        accumulated += length;
        yield chunk;
      } else {
        // Non-string chunk exceeds limit — emit marker and stop
        yield marker as T | string;
        return;
      }
    }
  }
}

export function truncateToolResultContent(
  content: string,
  options?: ToolResultTruncationOptions,
): string {
  // 1. Strip base64 if present (silently fall back if regex fails)
  let processed = content;
  try {
    if (containsBase64Data(processed)) {
      processed = stripBase64Data(processed, options?.base64Placeholder);
    }
  } catch {
    // Silently fall back to unprocessed content
  }

  // 2. Determine max characters
  const max = options?.isError
    ? (options.errorMaxCharacters ?? DEFAULT_ERROR_MAX_CHARACTERS)
    : (options?.maxCharacters ?? DEFAULT_MAX_CHARACTERS);

  // 3. Truncate with the marker
  return truncateText(processed, max, { marker: options?.marker });
}

function byteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function safeSliceByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  let best = '';

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = safeSlice(text, middle);
    const candidateBytes = byteLength(candidate);
    if (candidateBytes <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

function safeTailByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;

  const characters = Array.from(text);
  let tail = '';

  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const candidate = characters[index] + tail;
    if (byteLength(candidate) > maxBytes) {
      break;
    }
    tail = candidate;
  }

  return tail;
}

export function truncateToolResultContentStructured(
  content: string,
  options?: StructuredToolResultTruncationOptions,
): StructuredToolResultTruncation {
  let processed = content;
  try {
    if (containsBase64Data(processed)) {
      processed = stripBase64Data(processed, options?.base64Placeholder);
    }
  } catch {
    // Silently fall back to unprocessed content.
  }

  const originalSize = byteLength(processed);
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_CHARACTERS;

  if (originalSize <= maxBytes) {
    return {
      head: processed,
      tail: '',
      originalSize,
      omittedBytes: 0,
      truncated: false,
    };
  }

  const requestedHeadBytes = options?.headBytes ?? Math.ceil(maxBytes / 2);
  const headBudget = Math.max(0, Math.min(maxBytes, requestedHeadBytes));
  const tailBudget = Math.max(0, Math.min(maxBytes - headBudget, options?.tailBytes ?? maxBytes));
  const head = safeSliceByBytes(processed, headBudget);
  const tail = safeTailByBytes(processed, tailBudget);
  const visibleBytes = byteLength(head) + byteLength(tail);

  return {
    head,
    tail,
    originalSize,
    omittedBytes: Math.max(0, originalSize - visibleBytes),
    truncated: true,
  };
}
