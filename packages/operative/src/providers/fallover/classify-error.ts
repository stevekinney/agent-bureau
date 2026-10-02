import { extractStatusCode } from '../errors.ts';
import type { ErrorClassification } from './types.ts';

const AUTH_STATUS_CODES = new Set([401, 403]);
const RATE_LIMIT_STATUS_CODES = new Set([429]);
const SERVER_ERROR_STATUS_CODES = new Set([500, 502, 503, 504]);

const OVERFLOW_PATTERNS = [/context_length_exceeded/i, /max_tokens/i];
const NETWORK_PATTERNS = [/ECONNREFUSED/i, /ETIMEDOUT/i, /fetch failed/i];

const SAMPLING_PARAMETER_FIELDS = ['temperature', 'top_p', 'top_k'] as const;

/** A sampling parameter by its Anthropic wire name. */
export type SamplingParameterField = (typeof SAMPLING_PARAMETER_FIELDS)[number];

/**
 * Anthropic's 400 for a sampling parameter a model no longer accepts, captured
 * live on 2026-10-02 from `claude-opus-4-8` and `claude-sonnet-5` (COR-989):
 * "`temperature` is deprecated for this model." The field must sit directly
 * before the phrase, so a message that merely mentions a field elsewhere, or
 * the separate "cannot both be specified" rejection, does not match.
 */
const SAMPLING_REJECTION_PATTERN =
  /`?\b(temperature|top_p|top_k)\b`?\s+is deprecated for this model/gi;

/**
 * Classifies an error into a category that drives fallover decisions.
 *
 * ProviderError instances are inspected for statusCode first, then the
 * error message (including nested cause messages) is matched against
 * known patterns for overflow, sampling-parameter, and network failures.
 * A sampling-parameter rejection additionally requires a 400.
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

  if (statusCode === 400 && matchSamplingRejection(message).length > 0) {
    return 'sampling-parameter-unsupported';
  }

  if (matchesAny(message, NETWORK_PATTERNS)) {
    return 'network';
  }

  return 'unknown';
}

/**
 * Returns the sampling parameters a rejection names, deduplicated and in the
 * fixed order `temperature`, `top_p`, `top_k`, or an empty array when the error
 * is not a sampling-parameter rejection.
 *
 * It lives beside `classifyProviderError`, and shares its matcher, so every
 * piece of knowledge about Anthropic's error text stays in this one file and
 * the two can never disagree: whenever the classification is
 * `sampling-parameter-unsupported`, this returns at least one field.
 */
export function extractSamplingParameterFields(error: unknown): readonly SamplingParameterField[] {
  return matchSamplingRejection(extractFullMessage(error));
}

function matchSamplingRejection(message: string): readonly SamplingParameterField[] {
  const named = new Set<string>();
  for (const match of message.matchAll(SAMPLING_REJECTION_PATTERN)) {
    const field = match[1];
    if (field !== undefined) named.add(field.toLowerCase());
  }
  return SAMPLING_PARAMETER_FIELDS.filter((field) => named.has(field));
}

function extractFullMessage(error: unknown): string {
  const parts: string[] = [];

  if (error instanceof Error) {
    parts.push(error.message);
    if (error.cause instanceof Error) {
      parts.push(error.cause.message);
    }
  } else if (error && typeof error === 'object' && 'message' in error) {
    const message = error.message;
    if (typeof message === 'string') parts.push(message);
  }

  return parts.join(' ');
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}
