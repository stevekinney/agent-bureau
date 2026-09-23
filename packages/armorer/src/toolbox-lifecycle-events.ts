import type { ToolErrorCategory } from './core/errors';
import type { ExecutionSnapshot } from './execution-lifecycle';
import type { ToolCall } from './types';
type ToolCallWithArguments = import('./is-tool').ToolCallWithArguments;
type ToolConfiguration = import('./is-tool').ToolConfiguration;
type Tool = import('./is-tool').Tool;
type ToolSettledEvent = import('./tool-lifecycle-events').ToolSettledEvent;
type ToolExecutionIdentity = { executionId?: string; ownerId?: string };

export class ToolboxStatusUpdateEvent extends Event {
  static readonly type = 'status:update' as const;
  readonly callId: string;
  readonly name: string;
  readonly status: string;
  readonly percent: number | undefined;
  readonly eta: number | undefined;
  readonly message: string | undefined;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      callId: string;
      name: string;
      status: string;
      percent?: number;
      eta?: number;
      message?: string;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxStatusUpdateEvent.type);
    this.callId = detail.callId;
    this.name = detail.name;
    this.status = detail.status;
    this.percent = detail.percent;
    this.eta = detail.eta;
    this.message = detail.message;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxExecuteStartEvent extends Event {
  static readonly type = 'execute-start' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly params: unknown;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId: string | undefined;
  constructor(detail: { tool: Tool; call: ToolCall; params: unknown } & ToolExecutionIdentity) {
    super(ToolboxExecuteStartEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.params = detail.params;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxValidateSuccessEvent extends Event {
  static readonly type = 'validate-success' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly params: unknown;
  readonly parsed: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      params: unknown;
      parsed: unknown;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxValidateSuccessEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.params = detail.params;
    this.parsed = detail.parsed;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxValidateErrorEvent extends Event {
  static readonly type = 'validate-error' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly params: unknown;
  readonly error: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      params: unknown;
      error: unknown;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxValidateErrorEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.params = detail.params;
    this.error = detail.error;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxExecuteSuccessEvent extends Event {
  static readonly type = 'execute-success' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly result: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(detail: { tool: Tool; call: ToolCall; result: unknown } & ToolExecutionIdentity) {
    super(ToolboxExecuteSuccessEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.result = detail.result;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxExecuteErrorEvent extends Event {
  static readonly type = 'execute-error' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly error: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(detail: { tool: Tool; call: ToolCall; error: unknown } & ToolExecutionIdentity) {
    super(ToolboxExecuteErrorEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.error = detail.error;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxSettledEvent extends Event {
  static readonly type = 'settled' as const;
  readonly status: ToolSettledEvent['status'];
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly result: unknown;
  readonly error: unknown;
  /**
   * Settles only when this call's own tool callback has genuinely returned
   * or thrown — distinct from this event itself, which fires as soon as the
   * cancellation race against the execution signal settles. A callback that
   * ignores its abort signal keeps running after this event fires; a
   * consumer that must not treat the call as done (e.g. reporting `closed()`
   * `completed`) awaits this promise instead (AB-289).
   */
  readonly callbackCompletion: Promise<ExecutionSnapshot> | undefined;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      status?: ToolSettledEvent['status'];
      tool: Tool;
      call: ToolCall;
      result?: unknown;
      error?: unknown;
      callbackCompletion?: Promise<ExecutionSnapshot>;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxSettledEvent.type);
    this.status = detail.status ?? (detail.error !== undefined ? 'error' : 'success');
    this.tool = detail.tool;
    this.call = detail.call;
    this.result = detail.result;
    this.error = detail.error;
    this.callbackCompletion = detail.callbackCompletion;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxToolStartedEvent extends Event {
  static readonly type = 'tool.started' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly toolCall: ToolCallWithArguments;
  readonly configuration: ToolConfiguration;
  readonly params: unknown;
  readonly startedAt: number;
  readonly inputDigest: string | undefined;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      toolCall: ToolCallWithArguments;
      configuration: ToolConfiguration;
      params: unknown;
      startedAt: number;
      inputDigest?: string;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxToolStartedEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.params = detail.params;
    this.startedAt = detail.startedAt;
    this.inputDigest = detail.inputDigest;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxToolFinishedEvent extends Event {
  static readonly type = 'tool.finished' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly toolCall: ToolCallWithArguments;
  readonly configuration: ToolConfiguration;
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
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      toolCall: ToolCallWithArguments;
      configuration: ToolConfiguration;
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
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxToolFinishedEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
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
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxCancelledEvent extends Event {
  static readonly type = 'cancelled' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly reason: string | undefined;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
  constructor(detail: { tool: Tool; call: ToolCall; reason?: string } & ToolExecutionIdentity) {
    super(ToolboxCancelledEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.reason = detail.reason;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}
