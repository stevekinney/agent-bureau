import { z } from 'zod';

import { isToolError, type ToolError, type ToolErrorCategory } from '../core/errors';
import type { JsonValue } from '../core/serialization/json';

export function formatNonStringReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason === 'number' || typeof reason === 'boolean' || typeof reason === 'bigint') {
    return String(reason);
  }
  if (typeof reason === 'symbol') return reason.description ?? 'Symbol';
  if (typeof reason !== 'object') return undefined;
  try {
    return JSON.stringify(reason);
  } catch {
    return undefined;
  }
}

export function classifyErrorCategory(error: unknown): ToolErrorCategory {
  if (isToolError(error)) return error.category;
  if (isTimeoutError(error)) return 'timeout';
  if (isTransientError(error)) return 'transient';
  return 'internal';
}

export function isTimeoutError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (code === 'TIMEOUT') return true;
  const message = getStringProperty(error, 'message')?.toLowerCase() ?? '';
  return message.includes('timeout');
}

function isTransientError(error: unknown): boolean {
  const code = getStringProperty(error, 'code');
  const message = getStringProperty(error, 'message')?.toLowerCase() ?? '';
  const transientCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ENETDOWN',
    'ENETUNREACH',
    'EHOSTUNREACH',
  ]);
  return (
    (code !== undefined && transientCodes.has(code)) ||
    message.includes('timeout') ||
    message.includes('rate limit')
  );
}

export function defaultErrorCode(category: ToolErrorCategory): string {
  switch (category) {
    case 'validation':
      return 'VALIDATION_ERROR';
    case 'permission':
      return 'PERMISSION_DENIED';
    case 'not_found':
      return 'NOT_FOUND';
    case 'unavailable':
      return 'TOOL_UNAVAILABLE';
    case 'conflict':
      return 'CONFLICT';
    case 'transient':
      return 'TRANSIENT_ERROR';
    case 'timeout':
      return 'TIMEOUT';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'INTERNAL_ERROR';
  }
}

export function extractErrorCode(error: unknown): string | undefined {
  const code = getStringProperty(error, 'code');
  if (code) return code;
  const name = getStringProperty(error, 'name');
  return name && name !== 'Error' ? name : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = Reflect.get(value, key);
  return typeof entry === 'string' ? entry : undefined;
}

export function createToolError(
  category: ToolErrorCategory,
  message: string,
  options: { code?: string; retryable?: boolean; details?: JsonValue } = {},
): ToolError {
  return {
    code: options.code ?? defaultErrorCode(category),
    category,
    retryable: (options.retryable ?? category === 'transient') || category === 'timeout',
    message,
    ...(options.details !== undefined ? { details: options.details } : {}),
  };
}

export function serializeZodIssues(issues: z.core.$ZodIssue[]): JsonValue {
  return issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map((segment) =>
      typeof segment === 'symbol' ? (segment.description ?? 'symbol') : segment,
    ),
    message: issue.message,
  }));
}
