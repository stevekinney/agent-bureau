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
