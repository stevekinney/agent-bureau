import type { ToolCall } from './types';
type Tool = import('./is-tool').Tool;
type ToolExecutionIdentity = { executionId?: string; ownerId?: string };

export class ToolboxPolicyDeniedEvent extends Event {
  static readonly type = 'policy-denied' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly params: unknown;
  readonly reason: string | undefined;
  /** Armorer's own per-execution id (AB-318). */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly runId: string | undefined;
  /** The consuming call's `requestContext.agentId`, when supplied. */
  readonly agentId: string | undefined;
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
