import type {
  Context as OpenTelemetryContext,
  Link as OpenTelemetrySpanLink,
} from '@opentelemetry/api';

import type { ToolErrorCategory } from './core/errors';
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

// ---------------------------------------------------------------------------
// Tool Event Classes
// ---------------------------------------------------------------------------

export class ToolStatusUpdateEvent extends Event {
  static readonly type = 'status-update' as const;
  readonly status: string;
  constructor(detail: { status: string }) {
    super(ToolStatusUpdateEvent.type);
    this.status = detail.status;
  }
}

export class ToolExecuteStartEvent extends Event {
  static readonly type = 'execute-start' as const;
  readonly params: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  constructor(detail: { params: unknown } & ToolEventDetailContext) {
    super(ToolExecuteStartEvent.type);
    this.params = detail.params;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
  }
}

export class ToolValidateSuccessEvent extends Event {
  static readonly type = 'validate-success' as const;
  readonly params: unknown;
  readonly parsed: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  constructor(detail: { params: unknown; parsed: unknown } & ToolEventDetailContext) {
    super(ToolValidateSuccessEvent.type);
    this.params = detail.params;
    this.parsed = detail.parsed;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
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
  constructor(
    detail: {
      params: unknown;
      error: unknown;
      report?: ToolValidationReport;
      repairHints?: ToolRepairHint[];
    } & ToolEventDetailContext,
  ) {
    super(ToolValidateErrorEvent.type);
    this.params = detail.params;
    this.error = detail.error;
    this.report = detail.report;
    this.repairHints = detail.repairHints;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
  }
}

export class ToolExecuteSuccessEvent extends Event {
  static readonly type = 'execute-success' as const;
  readonly result: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  constructor(detail: { result: unknown } & ToolEventDetailContext) {
    super(ToolExecuteSuccessEvent.type);
    this.result = detail.result;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
  }
}

export class ToolExecuteErrorEvent extends Event {
  static readonly type = 'execute-error' as const;
  readonly error: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  constructor(detail: { error: unknown } & ToolEventDetailContext) {
    super(ToolExecuteErrorEvent.type);
    this.error = detail.error;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
  }
}

export class ToolSettledEvent extends Event {
  static readonly type = 'settled' as const;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  constructor(detail: { result?: unknown; error?: unknown } & ToolEventDetailContext) {
    super(ToolSettledEvent.type);
    this.result = detail.result;
    this.error = detail.error;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
  }
}

export class ToolPolicyDeniedEvent extends Event {
  static readonly type = 'policy-denied' as const;
  readonly params: unknown;
  readonly reason?: string;
  readonly toolCall: ToolCall;
  readonly configuration: ToolConfiguration;
  constructor(detail: { params: unknown; reason?: string } & ToolEventDetailContext) {
    super(ToolPolicyDeniedEvent.type);
    this.params = detail.params;
    this.reason = detail.reason;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
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
  constructor(
    detail: {
      params: unknown;
      startedAt: number;
      inputDigest?: string;
    } & ToolEventDetailContext,
  ) {
    super(ToolStartedEvent.type);
    this.params = detail.params;
    this.startedAt = detail.startedAt;
    this.inputDigest = detail.inputDigest;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
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
    } & ToolEventDetailContext,
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
  }
}

export class ToolProgressEvent extends Event {
  static readonly type = 'progress' as const;
  readonly percent?: number;
  readonly message?: string;
  constructor(detail: { percent?: number; message?: string }) {
    super(ToolProgressEvent.type);
    this.percent = detail.percent;
    this.message = detail.message;
  }
}

export class ToolStreamStartEvent extends Event {
  static readonly type = 'stream-start' as const;
  readonly mode: 'stream' | 'collect';
  constructor(detail: { mode: 'stream' | 'collect' }) {
    super(ToolStreamStartEvent.type);
    this.mode = detail.mode;
  }
}

export class ToolStreamChunkEvent extends Event {
  static readonly type = 'stream-chunk' as const;
  readonly chunk: unknown;
  readonly index: number;
  constructor(detail: { chunk: unknown; index: number }) {
    super(ToolStreamChunkEvent.type);
    this.chunk = detail.chunk;
    this.index = detail.index;
  }
}

export class ToolStreamEndEvent extends Event {
  static readonly type = 'stream-end' as const;
  readonly chunks: number;
  readonly completed: boolean;
  constructor(detail: { chunks: number; completed: boolean }) {
    super(ToolStreamEndEvent.type);
    this.chunks = detail.chunks;
    this.completed = detail.completed;
  }
}

export class ToolStreamErrorEvent extends Event {
  static readonly type = 'stream-error' as const;
  readonly error: unknown;
  readonly index: number;
  constructor(detail: { error: unknown; index: number }) {
    super(ToolStreamErrorEvent.type);
    this.error = detail.error;
    this.index = detail.index;
  }
}

export class ToolOutputChunkEvent extends Event {
  static readonly type = 'output-chunk' as const;
  readonly chunk: unknown;
  constructor(detail: { chunk: unknown }) {
    super(ToolOutputChunkEvent.type);
    this.chunk = detail.chunk;
  }
}

export class ToolLogEvent extends Event {
  static readonly type = 'log' as const;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data?: unknown;
  constructor(detail: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    data?: unknown;
  }) {
    super(ToolLogEvent.type);
    this.level = detail.level;
    this.message = detail.message;
    this.data = detail.data;
  }
}

export class ToolCancelledEvent extends Event {
  static readonly type = 'cancelled' as const;
  readonly reason?: string;
  constructor(detail: { reason?: string }) {
    super(ToolCancelledEvent.type);
    this.reason = detail.reason;
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
  constructor(detail: { tool: Tool; result: ToolExecutionResult }) {
    super(ToolboxCompleteEvent.type);
    this.tool = detail.tool;
    this.result = detail.result;
  }
}

export class ToolboxErrorEvent extends Event {
  static readonly type = 'error' as const;
  readonly tool?: Tool;
  readonly result: ToolExecutionResult;
  constructor(detail: { tool?: Tool; result: ToolExecutionResult }) {
    super(ToolboxErrorEvent.type);
    this.tool = detail.tool;
    this.result = detail.result;
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
  constructor(detail: {
    callId: string;
    name: string;
    status: string;
    percent?: number;
    eta?: number;
    message?: string;
  }) {
    super(ToolboxStatusUpdateEvent.type);
    this.callId = detail.callId;
    this.name = detail.name;
    this.status = detail.status;
    this.percent = detail.percent;
    this.eta = detail.eta;
    this.message = detail.message;
  }
}

export class ToolboxExecuteStartEvent extends Event {
  static readonly type = 'execute-start' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly params: unknown;
  constructor(detail: { tool: Tool; call: ToolCall; params: unknown }) {
    super(ToolboxExecuteStartEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.params = detail.params;
  }
}

export class ToolboxValidateSuccessEvent extends Event {
  static readonly type = 'validate-success' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly params: unknown;
  readonly parsed: unknown;
  constructor(detail: { tool: Tool; call: ToolCall; params: unknown; parsed: unknown }) {
    super(ToolboxValidateSuccessEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.params = detail.params;
    this.parsed = detail.parsed;
  }
}

export class ToolboxValidateErrorEvent extends Event {
  static readonly type = 'validate-error' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly params: unknown;
  readonly error: unknown;
  constructor(detail: { tool: Tool; call: ToolCall; params: unknown; error: unknown }) {
    super(ToolboxValidateErrorEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.params = detail.params;
    this.error = detail.error;
  }
}

export class ToolboxExecuteSuccessEvent extends Event {
  static readonly type = 'execute-success' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly result: unknown;
  constructor(detail: { tool: Tool; call: ToolCall; result: unknown }) {
    super(ToolboxExecuteSuccessEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.result = detail.result;
  }
}

export class ToolboxExecuteErrorEvent extends Event {
  static readonly type = 'execute-error' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly error: unknown;
  constructor(detail: { tool: Tool; call: ToolCall; error: unknown }) {
    super(ToolboxExecuteErrorEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.error = detail.error;
  }
}

export class ToolboxSettledEvent extends Event {
  static readonly type = 'settled' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly result?: unknown;
  readonly error?: unknown;
  constructor(detail: { tool: Tool; call: ToolCall; result?: unknown; error?: unknown }) {
    super(ToolboxSettledEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.result = detail.result;
    this.error = detail.error;
  }
}

export class ToolboxPolicyDeniedEvent extends Event {
  static readonly type = 'policy-denied' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly params: unknown;
  readonly reason?: string;
  constructor(detail: { tool: Tool; call: ToolCall; params: unknown; reason?: string }) {
    super(ToolboxPolicyDeniedEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.params = detail.params;
    this.reason = detail.reason;
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
  constructor(detail: {
    tool: Tool;
    call: ToolCall;
    toolCall: ToolCallWithArguments;
    configuration: ToolConfiguration;
    params: unknown;
    startedAt: number;
    inputDigest?: string;
  }) {
    super(ToolboxToolStartedEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.toolCall = detail.toolCall;
    this.configuration = detail.configuration;
    this.params = detail.params;
    this.startedAt = detail.startedAt;
    this.inputDigest = detail.inputDigest;
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
  constructor(detail: {
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
  }) {
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
  constructor(detail: { tool: Tool; call: ToolCall; percent?: number; message?: string }) {
    super(ToolboxProgressEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.percent = detail.percent;
    this.message = detail.message;
  }
}

export class ToolboxStreamStartEvent extends Event {
  static readonly type = 'stream-start' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly mode: 'stream' | 'collect';
  constructor(detail: { tool: Tool; call: ToolCall; mode: 'stream' | 'collect' }) {
    super(ToolboxStreamStartEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.mode = detail.mode;
  }
}

export class ToolboxStreamChunkEvent extends Event {
  static readonly type = 'stream-chunk' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly chunk: unknown;
  readonly index: number;
  constructor(detail: { tool: Tool; call: ToolCall; chunk: unknown; index: number }) {
    super(ToolboxStreamChunkEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.chunk = detail.chunk;
    this.index = detail.index;
  }
}

export class ToolboxStreamEndEvent extends Event {
  static readonly type = 'stream-end' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly chunks: number;
  readonly completed: boolean;
  constructor(detail: { tool: Tool; call: ToolCall; chunks: number; completed: boolean }) {
    super(ToolboxStreamEndEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.chunks = detail.chunks;
    this.completed = detail.completed;
  }
}

export class ToolboxStreamErrorEvent extends Event {
  static readonly type = 'stream-error' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly error: unknown;
  readonly index: number;
  constructor(detail: { tool: Tool; call: ToolCall; error: unknown; index: number }) {
    super(ToolboxStreamErrorEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.error = detail.error;
    this.index = detail.index;
  }
}

export class ToolboxOutputChunkEvent extends Event {
  static readonly type = 'output-chunk' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly chunk: unknown;
  constructor(detail: { tool: Tool; call: ToolCall; chunk: unknown }) {
    super(ToolboxOutputChunkEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.chunk = detail.chunk;
  }
}

export class ToolboxLogEvent extends Event {
  static readonly type = 'log' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data?: unknown;
  constructor(detail: {
    tool: Tool;
    call: ToolCall;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    data?: unknown;
  }) {
    super(ToolboxLogEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.level = detail.level;
    this.message = detail.message;
    this.data = detail.data;
  }
}

export class ToolboxCancelledEvent extends Event {
  static readonly type = 'cancelled' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly reason?: string;
  constructor(detail: { tool: Tool; call: ToolCall; reason?: string }) {
    super(ToolboxCancelledEvent.type);
    this.tool = detail.tool;
    this.call = detail.call;
    this.reason = detail.reason;
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
}
