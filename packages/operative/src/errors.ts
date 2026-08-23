import { isToolCallParseError } from './providers/errors.ts';

export type AgentRunErrorKind =
  'load' | 'contract' | 'generate' | 'tool' | 'abort' | 'output' | 'policy';

export type AsyncDefinitionLoadCode = 'INVALID_EXPORT' | 'LOAD_FAILED';

export type AgentRunErrorCode =
  | AsyncDefinitionLoadCode
  | 'ABORTED'
  | 'BUDGET_EXCEEDED'
  | 'ELICITATION_DENIED'
  | 'INVALID_OUTPUT'
  | 'MAXIMUM_STEPS'
  | 'TRIPWIRE'
  | 'UNKNOWN';

export class AgentRunError extends Error {
  readonly kind: AgentRunErrorKind;
  readonly code: AgentRunErrorCode;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: { kind: AgentRunErrorKind; code: AgentRunErrorCode; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'AgentRunError';
    this.kind = options.kind;
    this.code = options.code;
    this.cause = options.cause;
  }
}

function formatUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error == null) return 'Unknown error';
  if (
    typeof error === 'number' ||
    typeof error === 'boolean' ||
    typeof error === 'bigint' ||
    typeof error === 'symbol'
  ) {
    return String(error);
  }
  try {
    return JSON.stringify(error) ?? Object.prototype.toString.call(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

export function toAgentRunError(
  error: unknown,
  options: {
    kind?: AgentRunErrorKind;
    code?: AgentRunErrorCode;
    message?: string;
  } = {},
): AgentRunError {
  if (error instanceof AgentRunError) return error;

  const message = options.message ?? formatUnknownErrorMessage(error);

  return new AgentRunError(message, {
    kind: options.kind ?? 'generate',
    code: options.code ?? 'UNKNOWN',
    cause: error,
  });
}

export class MaximumStepsExceededError extends AgentRunError {
  constructor(maximumSteps: number) {
    super(`Agent run exceeded maximumSteps (${maximumSteps}).`, {
      kind: 'policy',
      code: 'MAXIMUM_STEPS',
    });
    this.name = 'MaximumStepsExceededError';
  }
}

export class ElicitationDeniedError extends AgentRunError {
  constructor(message?: string) {
    super(message ?? '', { kind: 'policy', code: 'ELICITATION_DENIED' });
    this.name = 'ElicitationDeniedError';
  }
}

export class BudgetExceededError extends AgentRunError {
  constructor(message?: string) {
    super(message ?? '', { kind: 'policy', code: 'BUDGET_EXCEEDED' });
    this.name = 'BudgetExceededError';
  }
}

/** Raised when a lazily loaded agent definition cannot be resolved. */
export class AsyncDefinitionLoadError extends AgentRunError {
  constructor(code: AsyncDefinitionLoadCode, message: string, cause?: unknown) {
    super(message, { kind: 'load', code, cause });
    this.name = 'AsyncDefinitionLoadError';
  }
}

/** Raised when an agent run is aborted before lazy generate loading can complete. */
export class AbortAgentRunError extends AgentRunError {
  constructor(message = 'The agent run was aborted', cause?: unknown) {
    super(message, { kind: 'abort', code: 'ABORTED', cause });
    this.name = 'AbortAgentRunError';
  }
}

/**
 * Raised when a `responseSchema` that is a non-Zod Standard Schema validator
 * (Valibot, ArkType, ...) rejects the model's structured output. Carries the
 * validator's raw `issues` array (per the Standard Schema spec) so callers
 * that inspect the error programmatically don't need to guess the shape.
 */
export class StandardSchemaValidationError extends AgentRunError {
  readonly issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }>;

  constructor(issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }>) {
    super(
      issues.length > 0
        ? `Response failed schema validation: ${issues.map((issue) => issue.message).join('; ')}`
        : 'Response failed schema validation',
      { kind: 'output', code: 'INVALID_OUTPUT' },
    );
    this.name = 'StandardSchemaValidationError';
    this.issues = issues;
  }
}

/** Identifying details of the guardrail that tripped the wire. */
export interface GuardrailTripwireDetail {
  /** The name of the detector (input) or validator (output) that tripped. */
  guardrailName: string;
  /** The category the detector/validator reported (e.g. 'prompt-injection', 'pii'). */
  category: string;
  /** Whether the tripwire fired on the input (pre-generate) or output (post-generate) side. */
  phase: 'input' | 'output';
  confidence: number;
  detail?: string;
}

/**
 * Thrown by a guardrail hook running in `mode: 'tripwire'` to hard-halt the run
 * immediately, distinct from the default `'validate'` mode (block/warn/sanitize/
 * redact), which substitutes a response and lets the loop continue. Classified by
 * `makeErrorResult`/`classifyErrorFinishReason` into `finishReason: 'tripwire'`,
 * mirroring the `ElicitationDeniedError`/`BudgetExceededError` pattern — the run
 * terminates cleanly (a `RunCompletedEvent` + `RunTripwireEvent`, not a crash).
 */
export class GuardrailTripwireError extends AgentRunError implements GuardrailTripwireDetail {
  readonly guardrailName: string;
  readonly category: string;
  readonly phase: 'input' | 'output';
  readonly confidence: number;
  readonly detail?: string;

  constructor(message: string, info: GuardrailTripwireDetail) {
    super(message, { kind: 'policy', code: 'TRIPWIRE' });
    this.name = 'GuardrailTripwireError';
    this.guardrailName = info.guardrailName;
    this.category = info.category;
    this.phase = info.phase;
    this.confidence = info.confidence;
    if (info.detail !== undefined) this.detail = info.detail;
  }
}

export type ErrorCategory =
  | 'rate-limit'
  | 'timeout'
  | 'authentication'
  | 'server'
  | 'client'
  | 'network'
  | 'model-output'
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  statusCode?: number;
  provider?: string;
  original: unknown;
}

function categorizeStatusCode(statusCode: number): ErrorCategory {
  if (statusCode === 429) return 'rate-limit';
  if (statusCode === 401 || statusCode === 403) return 'authentication';
  if (statusCode >= 500) return 'server';
  if (statusCode >= 400) return 'client';
  return 'unknown';
}

/**
 * Classifies an error into a structured category with retryability info.
 * User-land helper — not called by the loop.
 */
export function classifyError(error: unknown): ClassifiedError {
  const base: ClassifiedError = {
    category: 'unknown',
    retryable: false,
    original: error,
  };

  if (error === null || error === undefined) return base;

  if (isToolCallParseError(error)) {
    base.category = 'model-output';
    base.retryable = false;
    base.provider = error.provider;
    return base;
  }

  const errorObject = error as Record<string, unknown>;

  if (typeof errorObject['provider'] === 'string') {
    base.provider = errorObject['provider'];
  }

  const statusCode =
    typeof errorObject['statusCode'] === 'number'
      ? errorObject['statusCode']
      : typeof errorObject['status'] === 'number'
        ? errorObject['status']
        : undefined;

  if (statusCode !== undefined) {
    base.statusCode = statusCode;
  }

  if (typeof errorObject['retryable'] === 'boolean') {
    base.retryable = errorObject['retryable'];
    if (statusCode !== undefined) {
      base.category = categorizeStatusCode(statusCode);
    }
    return base;
  }

  if (statusCode !== undefined) {
    base.category = categorizeStatusCode(statusCode);
    base.retryable = statusCode === 429 || statusCode >= 500;
    return base;
  }

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message)) {
    base.category = 'network';
    base.retryable = true;
    return base;
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      base.category = 'timeout';
      base.retryable = false;
      return base;
    }
  }

  return base;
}
