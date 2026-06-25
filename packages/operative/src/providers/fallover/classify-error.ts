import { extractStatusCode } from '../errors.ts';
import type { ErrorClassification } from './types.ts';

const AUTH_STATUS_CODES = new Set([401, 403]);
const RATE_LIMIT_STATUS_CODES = new Set([429]);
const SERVER_ERROR_STATUS_CODES = new Set([500, 502, 503, 504]);

const OVERFLOW_PATTERNS = [/context_length_exceeded/i, /max_tokens/i];
const NETWORK_PATTERNS = [/ECONNREFUSED/i, /ETIMEDOUT/i, /fetch failed/i];

/**
 * Classifies an error into a category that drives fallover decisions.
 *
 * ProviderError instances are inspected for statusCode first, then the
 * error message (including nested cause messages) is matched against
 * known patterns for overflow and network failures.
 */
export function classifyProviderError(error: unknown): ErrorClassification {
  const statusCode = extractStatusCode(error);
  const message = extractFullMessage(error);

  // Check overflow patterns first — these are content problems, not provider problems,
  // and should be detected regardless of status code.
  if (matchesAny(message, OVERFLOW_PATTERNS)) {
    return 'overflow';
  }

  if (statusCode !== undefined) {
    if (AUTH_STATUS_CODES.has(statusCode)) return 'auth';
    if (RATE_LIMIT_STATUS_CODES.has(statusCode)) return 'rate-limit';
    if (SERVER_ERROR_STATUS_CODES.has(statusCode)) return 'server-error';
  }

  if (matchesAny(message, NETWORK_PATTERNS)) {
    return 'network';
  }

  return 'unknown';
}

function extractFullMessage(error: unknown): string {
  const parts: string[] = [];

  if (error instanceof Error) {
    parts.push(error.message);
    if (error.cause instanceof Error) {
      parts.push(error.cause.message);
    }
  } else if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string') parts.push(message);
  }

  return parts.join(' ');
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}
