type ToolExecutionIdentity = { executionId?: string; ownerId?: string };

export class ToolProgressEvent extends Event {
  static readonly type = 'progress' as const;
  readonly percent: number | undefined;
  readonly message: string | undefined;
  /** Verbatim checkpoint value; never re-serialized or reconstructed. */
  readonly checkpoint: unknown;
  /** Armorer's own per-execution id (AB-290). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-290). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly data: unknown;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
