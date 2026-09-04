import type {
  Context as OpenTelemetryContext,
  Link as OpenTelemetrySpanLink,
} from '@opentelemetry/api';

import type { ToolErrorCategory } from './core/errors';
import type { ExecutionSnapshot } from './execution-lifecycle';
import type { ToolCall, ToolExecutionResult } from './types';

// Forward reference types to avoid circular imports.
// These are defined in is-tool.ts and create-toolbox.ts.
type ToolConfiguration = import('./is-tool').ToolConfiguration;
type ToolCallWithArguments = import('./is-tool').ToolCallWithArguments;
type ToolValidationReport = import('./is-tool').ToolValidationReport;
type ToolRepairHint = import('./is-tool').ToolRepairHint;
type Tool = import('./is-tool').Tool;
type QuerySelectionResult = import('./core/registry').QuerySelectionResult;
type ToolQuery = import('./core/registry').ToolQuery;
type ToolMatch = import('./core/registry').ToolMatch<unknown>;
type ToolSearchOptions = import('./core/registry').ToolSearchOptions;

// ---------------------------------------------------------------------------
// Shared detail context used by many tool events.
// ---------------------------------------------------------------------------

type ToolEventDetailContext = {
  toolCall: ToolCall;
  configuration: ToolConfiguration;
};

/**
 * Run-identity fields echoed on the toolbox events a shared `Toolbox` needs
 * to scope per owning run (AB-290). `executionId` is armorer's own id,
 * minted per execution regardless of caller. `ownerId` is optional and
 * carries only the caller-supplied identity (e.g. operative's run id) —
 * never a fabricated default — so a consumer can tell "not supplied" apart
 * from any real owner value.
 */
export type ToolExecutionIdentity = {
  executionId?: string;
  ownerId?: string;
};

// ---------------------------------------------------------------------------
// Tool Event Classes
// ---------------------------------------------------------------------------

export class ToolStatusUpdateEvent extends Event {
  static readonly type = 'status-update' as const;
  readonly status: string;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId?: string;
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
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly report?: ToolValidationReport;
  readonly repairHints?: ToolRepairHint[];
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly result?: unknown;
  readonly error?: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /**
   * Settles only when this call's own tool callback has genuinely returned
   * or thrown — distinct from this event itself, which fires as soon as the
   * cancellation race against the execution signal settles. A callback that
   * ignores its abort signal keeps running after this event fires; await
   * this promise to observe its real completion (AB-289).
   */
  readonly callbackCompletion?: Promise<ExecutionSnapshot>;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId?: string;
  constructor(
    detail: {
      result?: unknown;
      error?: unknown;
      callbackCompletion?: Promise<ExecutionSnapshot>;
    } & ToolEventDetailContext &
      ToolExecutionIdentity,
  ) {
    super(ToolSettledEvent.type);
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
  readonly reason?: string;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly reason?: string;
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
  readonly inputDigest?: string;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly result?: unknown;
  readonly error?: unknown;
  readonly reason?: string;
  readonly errorCategory?: ToolErrorCategory;
  readonly inputDigest?: string;
  readonly outputDigest?: string;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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

export class ToolProgressEvent extends Event {
  static readonly type = 'progress' as const;
  readonly percent?: number;
  readonly message?: string;
  /** Verbatim checkpoint value; never re-serialized or reconstructed. */
  readonly checkpoint?: unknown;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId?: string;
  constructor(
    detail: {
      percent?: number;
      message?: string;
      checkpoint?: unknown;
    } & ToolExecutionIdentity,
  ) {
    super(ToolProgressEvent.type);
    this.percent = detail.percent;
    this.message = detail.message;
    this.checkpoint = detail.checkpoint;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolStreamStartEvent extends Event {
  static readonly type = 'stream-start' as const;
  readonly mode: 'stream' | 'collect';
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(detail: { mode: 'stream' | 'collect' } & ToolExecutionIdentity) {
    super(ToolStreamStartEvent.type);
    this.mode = detail.mode;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolStreamChunkEvent extends Event {
  static readonly type = 'stream-chunk' as const;
  readonly chunk: unknown;
  readonly index: number;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(detail: { chunk: unknown; index: number } & ToolExecutionIdentity) {
    super(ToolStreamChunkEvent.type);
    this.chunk = detail.chunk;
    this.index = detail.index;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolStreamEndEvent extends Event {
  static readonly type = 'stream-end' as const;
  readonly chunks: number;
  readonly completed: boolean;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(detail: { chunks: number; completed: boolean } & ToolExecutionIdentity) {
    super(ToolStreamEndEvent.type);
    this.chunks = detail.chunks;
    this.completed = detail.completed;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolStreamErrorEvent extends Event {
  static readonly type = 'stream-error' as const;
  readonly error: unknown;
  readonly index: number;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(detail: { error: unknown; index: number } & ToolExecutionIdentity) {
    super(ToolStreamErrorEvent.type);
    this.error = detail.error;
    this.index = detail.index;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolOutputChunkEvent extends Event {
  static readonly type = 'output-chunk' as const;
  readonly chunk: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(detail: { chunk: unknown } & ToolExecutionIdentity) {
    super(ToolOutputChunkEvent.type);
    this.chunk = detail.chunk;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolLogEvent extends Event {
  static readonly type = 'log' as const;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data?: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(
    detail: {
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      data?: unknown;
    } & ToolExecutionIdentity,
  ) {
    super(ToolLogEvent.type);
    this.level = detail.level;
    this.message = detail.message;
    this.data = detail.data;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolCancelledEvent extends Event {
  static readonly type = 'cancelled' as const;
  readonly reason?: string;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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

export interface ToolEventMap {
  [key: string]: Event;
  'status-update': ToolStatusUpdateEvent;
  'execute-start': ToolExecuteStartEvent;
  'validate-success': ToolValidateSuccessEvent;
  'validate-error': ToolValidateErrorEvent;
  'execute-success': ToolExecuteSuccessEvent;
  'execute-error': ToolExecuteErrorEvent;
  settled: ToolSettledEvent;
  'policy-denied': ToolPolicyDeniedEvent;
  'policy-action-required': ToolPolicyActionRequiredEvent;
  'tool.started': ToolStartedEvent;
  'tool.finished': ToolFinishedEvent;
  progress: ToolProgressEvent;
  'stream-start': ToolStreamStartEvent;
  'stream-chunk': ToolStreamChunkEvent;
  'stream-end': ToolStreamEndEvent;
  'stream-error': ToolStreamErrorEvent;
  'output-chunk': ToolOutputChunkEvent;
  log: ToolLogEvent;
  cancelled: ToolCancelledEvent;
}

// ---------------------------------------------------------------------------
// Toolbox Event Classes
// ---------------------------------------------------------------------------

export class ToolboxCallEvent extends Event {
  static readonly type = 'call' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly parentContext?: OpenTelemetryContext;
  readonly spanLinks?: OpenTelemetrySpanLink[];
  constructor(detail: {
    tool: Tool;
    call: ToolCall;
    parentContext?: OpenTelemetryContext;
    spanLinks?: OpenTelemetrySpanLink[];
  }) {
    super(ToolboxCallEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.parentContext = detail.parentContext;
    this.spanLinks = detail.spanLinks;
  }
}

export class ToolboxCompleteEvent extends Event {
  static readonly type = 'complete' as const;
  readonly tool: Tool;
  readonly result: ToolExecutionResult;
  /**
   * Armorer's own per-execution id (AB-318). Set only once this call's
   * execution identity has actually been minted — `complete` always fires
   * after that point, so this is always present here.
   */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(detail: { tool: Tool; result: ToolExecutionResult } & ToolExecutionIdentity) {
    super(ToolboxCompleteEvent.type);
    this.tool = detail.tool;
    this.result = detail.result;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxErrorEvent extends Event {
  static readonly type = 'error' as const;
  readonly tool?: Tool;
  readonly result: ToolExecutionResult;
  /**
   * Armorer's own per-execution id (AB-318). Only the two `error` emits
   * that fire after this call's execution identity has been minted (a
   * failed `tool.execute()`, or an unexpected throw while running it) set
   * this; the admission-path `error` emits — tool unavailable, budget
   * exceeded, loop blocked — fire before that identity exists and leave it
   * `undefined`.
   */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(detail: { tool?: Tool; result: ToolExecutionResult } & ToolExecutionIdentity) {
    super(ToolboxErrorEvent.type);
    this.tool = detail.tool;
    this.result = detail.result;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxNotFoundEvent extends Event {
  static readonly type = 'not-found' as const;
  readonly id: string;
  readonly name: string;
  readonly arguments?: unknown;
  constructor(toolCall: ToolCall) {
    super(ToolboxNotFoundEvent.type);
    this.id = toolCall.id;
    this.name = toolCall.name;
    this.arguments = (toolCall as unknown as Record<string, unknown>)['arguments'];
  }
}

export class ToolboxQueryEvent extends Event {
  static readonly type = 'query' as const;
  readonly criteria?: ToolQuery;
  readonly results: QuerySelectionResult;
  constructor(detail: { criteria?: ToolQuery; results: QuerySelectionResult }) {
    super(ToolboxQueryEvent.type);
    this.criteria = detail.criteria;
    this.results = detail.results;
  }
}

export class ToolboxSearchEvent extends Event {
  static readonly type = 'search' as const;
  readonly options: ToolSearchOptions;
  readonly results: ToolMatch[];
  constructor(detail: { options: ToolSearchOptions; results: ToolMatch[] }) {
    super(ToolboxSearchEvent.type);
    this.options = detail.options;
    this.results = detail.results;
  }
}

export class ToolboxStatusUpdateEvent extends Event {
  static readonly type = 'status:update' as const;
  readonly callId: string;
  readonly name: string;
  readonly status: string;
  readonly percent?: number;
  readonly eta?: number;
  readonly message?: string;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId?: string;
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
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly result?: unknown;
  readonly error?: unknown;
  /**
   * Settles only when this call's own tool callback has genuinely returned
   * or thrown — distinct from this event itself, which fires as soon as the
   * cancellation race against the execution signal settles. A callback that
   * ignores its abort signal keeps running after this event fires; a
   * consumer that must not treat the call as done (e.g. reporting `closed()`
   * `completed`) awaits this promise instead (AB-289).
   */
  readonly callbackCompletion?: Promise<ExecutionSnapshot>;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId?: string;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      result?: unknown;
      error?: unknown;
      callbackCompletion?: Promise<ExecutionSnapshot>;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxSettledEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.result = detail.result;
    this.error = detail.error;
    this.callbackCompletion = detail.callbackCompletion;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxPolicyDeniedEvent extends Event {
  static readonly type = 'policy-denied' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly params: unknown;
  readonly reason?: string;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      params: unknown;
      reason?: string;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxPolicyDeniedEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.params = detail.params;
    this.reason = detail.reason;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

/**
 * A reusable approval grant (AB-46, AB-346) matched an incoming tool call
 * ahead of `evaluateCapabilityApproval`'s `ask` outcome: the call executed
 * without prompting for approval, `usesRemaining` was decremented by one,
 * and this event is the audit entry the decision record calls for —
 * `grantId`, the matched tool call, the deciding principal, and the grant's
 * remaining uses after this consumption.
 */
export class ToolboxGrantUsedEvent extends Event {
  static readonly type = 'grant.used' as const;
  readonly grantId: string;
  readonly toolName: string;
  readonly call: ToolCall;
  readonly principalId: string;
  readonly usesRemaining: number;
  /** The consuming call's `requestContext.runId`, when supplied. */
  readonly runId?: string;
  /** The consuming call's `requestContext.agentId`, when supplied. */
  readonly agentId?: string;
  constructor(detail: {
    grantId: string;
    toolName: string;
    call: ToolCall;
    principalId: string;
    usesRemaining: number;
    runId?: string;
    agentId?: string;
  }) {
    super(ToolboxGrantUsedEvent.type);
    this.grantId = detail.grantId;
    this.toolName = detail.toolName;
    this.call = detail.call;
    this.principalId = detail.principalId;
    this.usesRemaining = detail.usesRemaining;
    this.runId = detail.runId;
    this.agentId = detail.agentId;
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
  readonly inputDigest?: string;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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
  readonly result?: unknown;
  readonly error?: unknown;
  readonly reason?: string;
  readonly errorCategory?: ToolErrorCategory;
  readonly inputDigest?: string;
  readonly outputDigest?: string;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
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

export class ToolboxBudgetExceededEvent extends Event {
  static readonly type = 'budget-exceeded' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly reason: string;
  constructor(detail: { tool: Tool; call: ToolCall; reason: string }) {
    super(ToolboxBudgetExceededEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.reason = detail.reason;
  }
}

export class ToolboxProgressEvent extends Event {
  static readonly type = 'progress' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly percent?: number;
  readonly message?: string;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId?: string;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      percent?: number;
      message?: string;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxProgressEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.percent = detail.percent;
    this.message = detail.message;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxStreamStartEvent extends Event {
  static readonly type = 'stream-start' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly mode: 'stream' | 'collect';
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      mode: 'stream' | 'collect';
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxStreamStartEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.mode = detail.mode;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxStreamChunkEvent extends Event {
  static readonly type = 'stream-chunk' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly chunk: unknown;
  readonly index: number;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      chunk: unknown;
      index: number;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxStreamChunkEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.chunk = detail.chunk;
    this.index = detail.index;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxStreamEndEvent extends Event {
  static readonly type = 'stream-end' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly chunks: number;
  readonly completed: boolean;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      chunks: number;
      completed: boolean;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxStreamEndEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.chunks = detail.chunks;
    this.completed = detail.completed;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxStreamErrorEvent extends Event {
  static readonly type = 'stream-error' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly error: unknown;
  readonly index: number;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      error: unknown;
      index: number;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxStreamErrorEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.error = detail.error;
    this.index = detail.index;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxOutputChunkEvent extends Event {
  static readonly type = 'output-chunk' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly chunk: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(detail: { tool: Tool; call: ToolCall; chunk: unknown } & ToolExecutionIdentity) {
    super(ToolboxOutputChunkEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.chunk = detail.chunk;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxLogEvent extends Event {
  static readonly type = 'log' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data?: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(
    detail: {
      tool: Tool;
      call: ToolCall;
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      data?: unknown;
    } & ToolExecutionIdentity,
  ) {
    super(ToolboxLogEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.level = detail.level;
    this.message = detail.message;
    this.data = detail.data;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxCancelledEvent extends Event {
  static readonly type = 'cancelled' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly reason?: string;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId?: string;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId?: string;
  constructor(detail: { tool: Tool; call: ToolCall; reason?: string } & ToolExecutionIdentity) {
    super(ToolboxCancelledEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.reason = detail.reason;
    this.executionId = detail.executionId;
    this.ownerId = detail.ownerId;
  }
}

export class ToolboxNameResolvedEvent extends Event {
  static readonly type = 'name-resolved' as const;
  readonly originalName: string;
  readonly resolvedName: string;
  readonly tier: string;
  constructor(detail: { originalName: string; resolvedName: string; tier: string }) {
    super(ToolboxNameResolvedEvent.type);
    this.originalName = detail.originalName;
    this.resolvedName = detail.resolvedName;
    this.tier = detail.tier;
  }
}

export class ToolboxLoopWarningEvent extends Event {
  static readonly type = 'loop-warning' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly detector: string;
  readonly count: number;
  readonly message: string;
  constructor(detail: {
    tool: Tool;
    call: ToolCall;
    detector: string;
    count: number;
    message: string;
  }) {
    super(ToolboxLoopWarningEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.detector = detail.detector;
    this.count = detail.count;
    this.message = detail.message;
  }
}

export class ToolboxLoopBlockedEvent extends Event {
  static readonly type = 'loop-blocked' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly detector: string;
  readonly count: number;
  readonly message: string;
  constructor(detail: {
    tool: Tool;
    call: ToolCall;
    detector: string;
    count: number;
    message: string;
  }) {
    super(ToolboxLoopBlockedEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.detector = detail.detector;
    this.count = detail.count;
    this.message = detail.message;
  }
}

// ---------------------------------------------------------------------------
// ToolboxEventMap — maps type strings to Event subclass instances
// ---------------------------------------------------------------------------

export interface ToolboxEventMap {
  [key: string]: Event;
  call: ToolboxCallEvent;
  complete: ToolboxCompleteEvent;
  error: ToolboxErrorEvent;
  'not-found': ToolboxNotFoundEvent;
  query: ToolboxQueryEvent;
  search: ToolboxSearchEvent;
  'status:update': ToolboxStatusUpdateEvent;
  'execute-start': ToolboxExecuteStartEvent;
  'validate-success': ToolboxValidateSuccessEvent;
  'validate-error': ToolboxValidateErrorEvent;
  'execute-success': ToolboxExecuteSuccessEvent;
  'execute-error': ToolboxExecuteErrorEvent;
  settled: ToolboxSettledEvent;
  'policy-denied': ToolboxPolicyDeniedEvent;
  'tool.started': ToolboxToolStartedEvent;
  'tool.finished': ToolboxToolFinishedEvent;
  'budget-exceeded': ToolboxBudgetExceededEvent;
  progress: ToolboxProgressEvent;
  'stream-start': ToolboxStreamStartEvent;
  'stream-chunk': ToolboxStreamChunkEvent;
  'stream-end': ToolboxStreamEndEvent;
  'stream-error': ToolboxStreamErrorEvent;
  'output-chunk': ToolboxOutputChunkEvent;
  log: ToolboxLogEvent;
  cancelled: ToolboxCancelledEvent;
  'name-resolved': ToolboxNameResolvedEvent;
  'loop-warning': ToolboxLoopWarningEvent;
  'loop-blocked': ToolboxLoopBlockedEvent;
  'grant.used': ToolboxGrantUsedEvent;
}
