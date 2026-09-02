import type { ToolError } from 'armorer';
import { ZodError, type ZodIssue } from 'zod';

import { isToolCallParseError } from './providers/errors.ts';
import type { RunResult } from './types';

export type AgentRunErrorKind =
  'load' | 'contract' | 'generate' | 'tool' | 'abort' | 'output' | 'policy';

export type AsyncDefinitionLoadCode = 'INVALID_EXPORT' | 'LOAD_FAILED';

export type AgentRunErrorCode =
  | AsyncDefinitionLoadCode
  | 'ABORTED'
  | 'BUDGET_EXCEEDED'
  | 'ELICITATION_DENIED'
  | 'INVALID_AGENT_HANDLE'
  | 'INVALID_OUTPUT'
  | 'MAXIMUM_STEPS'
  | 'NON_JSON_OUTPUT'
  | 'OUTPUT_SCHEMA_CONVERSION_FAILED'
  | 'SUBAGENT_RUN_FAILED'
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

export type SerializedAgentRunError = {
  name: string;
  message: string;
  kind: AgentRunErrorKind;
  code: AgentRunErrorCode;
  cause?: unknown;
};

function serializeAgentRunErrorCause(cause: unknown): unknown {
  if (cause === undefined) return undefined;
  if (cause instanceof AgentRunError) return agentRunErrorToJSON(cause);
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  if (
    cause === null ||
    typeof cause === 'string' ||
    typeof cause === 'number' ||
    typeof cause === 'boolean'
  ) {
    return cause;
  }
  if (typeof cause === 'bigint' || typeof cause === 'symbol') return String(cause);
  try {
    return JSON.parse(JSON.stringify(cause));
  } catch {
    return Object.prototype.toString.call(cause);
  }
}

/** Converts an AgentRunError to a stable JSON-safe diagnostic shape. */
export function agentRunErrorToJSON(error: AgentRunError): SerializedAgentRunError {
  const serialized: SerializedAgentRunError = {
    name: error.name,
    message: error.message,
    kind: error.kind,
    code: error.code,
  };
  const cause = serializeAgentRunErrorCause(error.cause);
  if (cause !== undefined) serialized.cause = cause;
  return serialized;
}

/** Serializes an AgentRunError without dropping kind/code/cause metadata. */
export function serializeAgentRunError(error: AgentRunError): string {
  return JSON.stringify(agentRunErrorToJSON(error));
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

/**
 * Narrows an unknown thrown value to an armorer {@link ToolError} carrying
 * `code: 'BUDGET_EXCEEDED'` — the shape `create-toolbox.ts`'s `checkBudget`
 * path throws in `failFast` mode. Armorer's `ToolError` is a plain object
 * (not an `Error` subclass), so this checks the interface's required fields
 * rather than using `instanceof`.
 */
function isBudgetExceededToolError(error: unknown): error is ToolError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'category' in error &&
    'message' in error &&
    'retryable' in error &&
    error.code === 'BUDGET_EXCEEDED'
  );
}

/**
 * Re-classifies a thrown armorer `ToolError` carrying `code: 'BUDGET_EXCEEDED'`
 * as a {@link BudgetExceededError} before it reaches {@link toAgentRunError} /
 * `makeErrorResult`'s `instanceof` classification (AB-231).
 *
 * A toolbox-level, per-call, `failFast` budget rejection
 * (`packages/armorer/src/create-toolbox.ts`'s `checkBudget` path) throws a
 * generic `ToolError` stamped `code: 'BUDGET_EXCEEDED'`, not a
 * `BudgetExceededError` — armorer sits below operative in the dependency
 * graph (operative depends on armorer, never the reverse), so it cannot
 * construct or throw operative's `BudgetExceededError` directly. Without this
 * reclassification, `makeErrorResult`'s `runError instanceof
 * BudgetExceededError` check falls through and `run.completed`'s
 * `finishReason` resolves to `'error'` instead of `'budget-exceeded'`, losing
 * the toolbox rejection's budget semantics at the run boundary. Any other
 * error is returned unchanged.
 */
export function reclassifyToolError(error: unknown): unknown {
  return isBudgetExceededToolError(error) ? new BudgetExceededError(error.message) : error;
}

/** Raised when a lazily loaded agent definition cannot be resolved. */
export class AsyncDefinitionLoadError extends AgentRunError {
  constructor(code: AsyncDefinitionLoadCode, message: string, cause?: unknown) {
    super(message, { kind: 'load', code, cause });
    this.name = 'AsyncDefinitionLoadError';
  }
}

/**
 * Raised (AB-21) when a value that was supposed to be a `RunnableAgent`, or
 * the run handle its `run()` method returned, does not satisfy the contract:
 * a resolved value with no callable `run`, or a handle missing `result`,
 * `abort`, an async iterator, or `[Symbol.dispose]`. Distinct from
 * {@link AsyncDefinitionLoadError} — the loader itself succeeded here; what
 * it produced (or what that agent's `run()` produced) is the wrong shape.
 * Not retried by `createLazyAgent`'s shared load cache: the load itself
 * didn't fail, so there is nothing to reload.
 */
export class AgentContractError extends AgentRunError {
  constructor(message: string, cause?: unknown) {
    super(message, { kind: 'contract', code: 'INVALID_AGENT_HANDLE', cause });
    this.name = 'AgentContractError';
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
 * Raised (AB-18) when a run's `output` Zod schema rejects a candidate that
 * WAS valid JSON — the model returned JSON, but its shape didn't satisfy the
 * schema. Distinct from {@link NonJsonOutputError}, which covers the case
 * where the model's final text wasn't JSON at all. Carries the underlying
 * Zod validation failure as `cause`.
 */
export class OutputValidationError extends AgentRunError {
  /**
   * `cause.issues` when `cause` is a `ZodError` (the ordinary case — `output`
   * only ever accepts a Zod schema), empty otherwise. Exposed as a
   * first-class field so a caller can inspect per-field failures without
   * narrowing `cause` itself.
   */
  readonly issues: readonly ZodIssue[];

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Response failed output schema validation: ${detail}`, {
      kind: 'output',
      code: 'INVALID_OUTPUT',
      cause,
    });
    this.name = 'OutputValidationError';
    this.issues = cause instanceof ZodError ? cause.issues : [];
  }
}

/**
 * Raised (AB-18) in two cases: a run's final text is not valid JSON and —
 * once validated as the raw string against the `output` schema — still
 * fails (a schema of exactly `z.string()` can legitimately accept non-JSON
 * text; this error is reserved for the case where that also fails); or an
 * already-decoded candidate handed directly to `validateOutputValue` fails
 * the recursive JSONValue contract (a cycle, a sparse array, a `Date`, ...).
 * `text` carries the raw model output in the first case, or a best-effort
 * (`JSON.stringify`, falling back to `String()`) description of the
 * offending candidate in the second.
 */
export class NonJsonOutputError extends AgentRunError {
  readonly text: string;

  constructor(text: string, cause?: unknown) {
    super(`Agent response was not valid JSON: ${text.slice(0, 200)}`, {
      kind: 'output',
      code: 'NON_JSON_OUTPUT',
      cause,
    });
    this.name = 'NonJsonOutputError';
    this.text = text;
  }
}

/**
 * Raised (AB-18) synchronously when an `output` Zod schema cannot be
 * converted to a provider-facing JSON Schema via `z.toJSONSchema`. There is
 * no generic-object fallback — an unrepresentable schema is an authoring
 * error the caller must fix, not something silently degraded at runtime.
 */
export class OutputSchemaConversionError extends AgentRunError {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`The output schema could not be converted to a JSON Schema: ${detail}`, {
      kind: 'contract',
      code: 'OUTPUT_SCHEMA_CONVERSION_FAILED',
      cause,
    });
    this.name = 'OutputSchemaConversionError';
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

/**
 * Raised by `createSubagentTool` (AB-19) when a child agent's run does not
 * finish as a clean success — any `finishReason` other than
 * `'stop-condition'` (abort, execution error, tripwire, budget exceeded,
 * elicitation denied, maximum steps), or a `'stop-condition'` finish whose
 * `schemaValidation.success` is `false` (invalid output). Carries the
 * child's full terminal `RunResult` as `.result`, so a caller can inspect
 * `finishReason`, `error`, `schemaValidation`, `usage`, and `steps` directly
 * instead of re-deriving them from a generic message string. `toToolOutput`
 * is never invoked for any terminal this error covers — see
 * `create-subagent-tool.ts`.
 */
export class SubagentRunError extends AgentRunError {
  /** The child agent's name, as supplied to `createSubagentTool({ agentName })`. */
  readonly agentName: string;
  /** The child's full terminal `RunResult` — never a success by construction. */
  readonly result: RunResult;

  constructor(agentName: string, result: RunResult, cause?: unknown) {
    // `SubagentRunError` is only ever constructed for a non-success
    // terminal (see `isSuccessfulRunResult` in `agent-run.ts`); the ONLY
    // way `finishReason` reaches here as `'stop-condition'` is a clean stop
    // whose `output` failed schema validation — `result.finishReason` alone
    // would render that case as the misleading "did not complete
    // successfully: stop-condition". Label it explicitly instead, and fall
    // back to the schema-validation error (rather than the unset
    // `result.error`) as the cause in that same case.
    const label = result.finishReason === 'stop-condition' ? 'invalid-output' : result.finishReason;
    super(`Sub-agent "${agentName}" did not complete successfully: ${label}`, {
      kind: 'tool',
      code: 'SUBAGENT_RUN_FAILED',
      cause: cause ?? result.error ?? result.schemaValidation?.error,
    });
    this.name = 'SubagentRunError';
    this.agentName = agentName;
    this.result = result;
  }
}
