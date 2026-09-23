import type { ToolErrorCategory } from './core/errors';
import type { ExecutionSnapshot } from './execution-lifecycle';
import type { ToolCall } from './types';
type ToolConfiguration = import('./is-tool').ToolConfiguration;
type ToolValidationReport = import('./is-tool').ToolValidationReport;
type ToolRepairHint = import('./is-tool').ToolRepairHint;
type ToolEventDetailContext = { toolCall: ToolCall; configuration: ToolConfiguration };
type ToolExecutionIdentity = { executionId?: string; ownerId?: string };

export class ToolStatusUpdateEvent extends Event {
  static readonly type = 'status-update' as const;
  readonly status: string;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(detail: { status: string } & ToolExecutionIdentity) {
    super(ToolStatusUpdateEvent.type);
    this.status = detail.status;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolExecuteStartEvent extends Event {
  static readonly type = 'execute-start' as const;
  readonly params: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId: string | undefined;
  constructor(detail: { params: unknown } & ToolEventDetailContext & ToolExecutionIdentity) {
    super(ToolExecuteStartEvent.type);
    this.params = detail.params;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolValidateSuccessEvent extends Event {
  static readonly type = 'validate-success' as const;
  readonly params: unknown;
  readonly parsed: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: { params: unknown; parsed: unknown } & ToolEventDetailContext & ToolExecutionIdentity,
  ) {
    super(ToolValidateSuccessEvent.type);
    this.params = detail.params;
    this.parsed = detail.parsed;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolValidateErrorEvent extends Event {
  static readonly type = 'validate-error' as const;
  readonly params: unknown;
  readonly error: unknown;
  readonly report: ToolValidationReport | undefined;
  readonly repairHints: ToolRepairHint[] | undefined;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      params: unknown;
      error: unknown;
      report?: ToolValidationReport;
      repairHints?: ToolRepairHint[];
    } & ToolEventDetailContext &
      ToolExecutionIdentity,
  ) {
    super(ToolValidateErrorEvent.type);
    this.params = detail.params;
    this.error = detail.error;
    this.report = detail.report;
    this.repairHints = detail.repairHints;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolExecuteSuccessEvent extends Event {
  static readonly type = 'execute-success' as const;
  readonly result: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(detail: { result: unknown } & ToolEventDetailContext & ToolExecutionIdentity) {
    super(ToolExecuteSuccessEvent.type);
    this.result = detail.result;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolExecuteErrorEvent extends Event {
  static readonly type = 'execute-error' as const;
  readonly error: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(detail: { error: unknown } & ToolEventDetailContext & ToolExecutionIdentity) {
    super(ToolExecuteErrorEvent.type);
    this.error = detail.error;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolSettledEvent extends Event {
  static readonly type = 'settled' as const;
  readonly status: ToolFinishedEvent['status'];
  readonly result: unknown;
  readonly error: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /**
   * Settles only when this call's own tool callback has genuinely returned
   * or thrown — distinct from this event itself, which fires as soon as the
   * cancellation race against the execution signal settles. A callback that
   * ignores its abort signal keeps running after this event fires; await
   * this promise to observe its real completion (AB-289).
   */
  readonly callbackCompletion: Promise<ExecutionSnapshot> | undefined;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      status?: ToolFinishedEvent['status'];
      result?: unknown;
      error?: unknown;
      callbackCompletion?: Promise<ExecutionSnapshot>;
    } & ToolEventDetailContext &
      ToolExecutionIdentity,
  ) {
    super(ToolSettledEvent.type);
    this.status = detail.status ?? (detail.error !== undefined ? 'error' : 'success');
    this.result = detail.result;
    this.error = detail.error;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.callbackCompletion = detail.callbackCompletion;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolPolicyDeniedEvent extends Event {
  static readonly type = 'policy-denied' as const;
  readonly params: unknown;
  readonly reason: string | undefined;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: { params: unknown; reason?: string } & ToolEventDetailContext & ToolExecutionIdentity,
  ) {
    super(ToolPolicyDeniedEvent.type);
    this.params = detail.params;
    this.reason = detail.reason;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolPolicyActionRequiredEvent extends Event {
  static readonly type = 'policy-action-required' as const;
  readonly params: unknown;
  readonly reason: string | undefined;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  constructor(detail: { params: unknown; reason?: string } & ToolEventDetailContext) {
    super(ToolPolicyActionRequiredEvent.type);
    this.params = detail.params;
    this.reason = detail.reason;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
  }
}

export class ToolStartedEvent extends Event {
  static readonly type = 'tool.started' as const;
  readonly params: unknown;
  readonly startedAt: number;
  readonly inputDigest: string | undefined;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      params: unknown;
      startedAt: number;
      inputDigest?: string;
    } & ToolEventDetailContext &
      ToolExecutionIdentity,
  ) {
    super(ToolStartedEvent.type);
    this.params = detail.params;
    this.startedAt = detail.startedAt;
    this.inputDigest = detail.inputDigest;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolFinishedEvent extends Event {
  static readonly type = 'tool.finished' as const;
  readonly status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused';
  readonly durationMs: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly result: unknown;
  readonly error: unknown;
  readonly reason: string | undefined;
  readonly errorCategory: ToolErrorCategory | undefined;
  readonly inputDigest: string | undefined;
  readonly outputDigest: string | undefined;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      status: 'success' | 'error' | 'denied' | 'cancelled' | 'paused';
      durationMs: number;
      startedAt: number;
      finishedAt: number;
      result?: unknown;
      error?: unknown;
      reason?: string;
      errorCategory?: ToolErrorCategory;
      inputDigest?: string;
      outputDigest?: string;
    } & ToolEventDetailContext &
      ToolExecutionIdentity,
  ) {
    super(ToolFinishedEvent.type);
    this.status = detail.status;
    this.durationMs = detail.durationMs;
    this.startedAt = detail.startedAt;
    this.finishedAt = detail.finishedAt;
    this.result = detail.result;
    this.error = detail.error;
    this.reason = detail.reason;
    this.errorCategory = detail.errorCategory;
    this.inputDigest = detail.inputDigest;
    this.outputDigest = detail.outputDigest;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolCancelledEvent extends Event {
  static readonly type = 'cancelled' as const;
  readonly reason: string | undefined;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(detail: { reason?: string } & ToolExecutionIdentity) {
    super(ToolCancelledEvent.type);
    this.reason = detail.reason;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

// ---------------------------------------------------------------------------
// ToolEventMap — maps type strings to Event subclass instances
// ---------------------------------------------------------------------------
