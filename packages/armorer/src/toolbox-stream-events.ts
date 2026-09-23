import type { ToolCall } from './types';
type Tool = import('./is-tool').Tool;
type ToolExecutionIdentity = { executionId?: string; ownerId?: string };

export class ToolboxProgressEvent extends Event {
  static readonly type = 'progress' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly percent: number | undefined;
  readonly message: string | undefined;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly data: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
