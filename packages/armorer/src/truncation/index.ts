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
