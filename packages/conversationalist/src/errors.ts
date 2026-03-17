/**
 * Error codes for Conversationalist errors (kebab-case with `error:` prefix).
 */
export type ConversationalistErrorCode =
  | 'error:locked'
  | 'error:invalid-input'
  | 'error:invalid-position'
  | 'error:invalid-tool-reference'
  | 'error:duplicate-id'
  | 'error:not-found'
  | 'error:serialization'
  | 'error:validation'
  | 'error:integrity';

/**
 * Base error class for all Conversationalist errors.
 *
 * Provides structured error information with error codes, context data,
 * and cause chains for better debugging.
 */
export class ConversationalistError extends Error {
  /** Structured error code */
  readonly code: ConversationalistErrorCode;

  /** Additional context data */
  readonly context?: Record<string, unknown> | undefined;

  /** Underlying cause (if any) */
  override readonly cause?: Error | undefined;

  constructor(
    code: ConversationalistErrorCode,
    message: string,
    options?: {
      context?: Record<string, unknown> | undefined;
      cause?: Error | undefined;
    },
  ) {
    super(message);
    this.name = 'ConversationalistError';
    this.code = code;
    this.context = options?.context;
    this.cause = options?.cause;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConversationalistError);
    }
  }

  /**
   * Formats the error as a detailed string with code and context.
   */
  toDetailedString(): string {
    const parts = [`[${this.code}] ${this.message}`];

    if (this.context && Object.keys(this.context).length > 0) {
      parts.push(`Context: ${JSON.stringify(this.context, null, 2)}`);
    }

    if (this.cause) {
      parts.push(`Caused by: ${this.cause.message}`);
    }

    return parts.join('\n');
  }
}

/**
 * Creates a lock error (ERR_LOCKED).
 * Thrown when a conversation is already being modified.
 */
export function createLockedError(conversationId: string): ConversationalistError {
  return new ConversationalistError(
    'error:locked',
    `conversation ${conversationId} is locked (concurrent modification detected)`,
    { context: { conversationId } },
  );
}

/**
 * Creates an invalid input error (ERR_INVALID_INPUT).
 * Thrown when message input data is invalid.
 */
export function createInvalidInputError(
  message: string,
  context?: Record<string, unknown>,
): ConversationalistError {
  return new ConversationalistError('error:invalid-input', message, { context });
}

/**
 * Creates an invalid position error (ERR_INVALID_POSITION).
 * Thrown when positions are non-contiguous or invalid.
 */
export function createInvalidPositionError(
  expected: number,
  actual: number,
): ConversationalistError {
  return new ConversationalistError(
    'error:invalid-position',
    `invalid position: expected ${expected}, got ${actual}`,
    { context: { expected, actual } },
  );
}

/**
 * Creates an invalid tool reference error (ERR_INVALID_TOOL_REFERENCE).
 * Thrown when a tool result references a non-existent tool-use message.
 */
export function createInvalidToolReferenceError(callId: string): ConversationalistError {
  return new ConversationalistError(
    'error:invalid-tool-reference',
    `tool result references non-existent tool-use: ${callId}`,
    { context: { callId } },
  );
}

/**
 * Creates a duplicate ID error (ERR_DUPLICATE_ID).
 * Thrown when a conversation with the given ID already exists.
 */
export function createDuplicateIdError(id: string): ConversationalistError {
  return new ConversationalistError(
    'error:duplicate-id',
    `conversation with id ${id} already exists`,
    { context: { id } },
  );
}

/**
 * Creates a not found error (ERR_NOT_FOUND).
 * Thrown when a conversation cannot be found.
 */
export function createNotFoundError(id: string): ConversationalistError {
  return new ConversationalistError(
    'error:not-found',
    `conversation with id ${id} not found`,
    {
      context: { id },
    },
  );
}

/**
 * Creates a serialization error (ERR_SERIALIZATION).
 * Thrown when JSON serialization/deserialization fails.
 */
export function createSerializationError(
  message: string,
  cause?: Error,
): ConversationalistError {
  return new ConversationalistError('error:serialization', message, { cause });
}

/**
 * Creates a validation error (ERR_VALIDATION).
 * Thrown when data validation fails (e.g., Zod schema validation).
 */
export function createValidationError(
  message: string,
  context?: Record<string, unknown>,
  cause?: Error,
): ConversationalistError {
  return new ConversationalistError('error:validation', message, { context, cause });
}

/**
 * Creates an integrity error (ERR_INTEGRITY).
 * Thrown when conversation invariants are violated.
 */
export function createIntegrityError(
  message: string,
  context?: Record<string, unknown>,
): ConversationalistError {
  return new ConversationalistError('error:integrity', message, { context });
}
