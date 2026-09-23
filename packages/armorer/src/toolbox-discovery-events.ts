import type {
  Context as OpenTelemetryContext,
  Link as OpenTelemetrySpanLink,
} from '@opentelemetry/api';
import type {
  QuerySelectionResult,
  ToolMatch as RegistryToolMatch,
  ToolQuery,
  ToolSearchOptions,
} from './core/registry';
import type { ToolCall, ToolExecutionResult } from './types';
type Tool = import('./is-tool').Tool;
type ToolMatch = RegistryToolMatch<unknown>;
type ToolExecutionIdentity = { executionId?: string; ownerId?: string };

export class ToolboxCallEvent extends Event {
  static readonly type = 'call' as const;
  readonly tool: Tool;
  readonly call: ToolCall;
  readonly parentContext: OpenTelemetryContext | undefined;
  readonly spanLinks: OpenTelemetrySpanLink[] | undefined;
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
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly tool: Tool | undefined;
  readonly result: ToolExecutionResult;
  /**
   * Armorer's own per-execution id (AB-318). Only the two `error` emits
   * that fire after this call's execution identity has been minted (a
   * failed `tool.execute()`, or an unexpected throw while running it) set
   * this; the admission-path `error` emits — tool unavailable, budget
   * exceeded, loop blocked — fire before that identity exists and leave it
   * `undefined`.
   */
  readonly executionId: string | undefined;
  /** Caller-supplied owner identity, echoed verbatim when supplied (AB-318). */
  readonly ownerId: string | undefined;
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
  readonly arguments: unknown;
  constructor(toolCall: ToolCall) {
    super(ToolboxNotFoundEvent.type);
    this.id = toolCall.id;
    this.name = toolCall.name;
    this.arguments = toolCall['arguments'];
  }
}

export class ToolboxQueryEvent extends Event {
  static readonly type = 'query' as const;
  readonly criteria: ToolQuery | undefined;
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
