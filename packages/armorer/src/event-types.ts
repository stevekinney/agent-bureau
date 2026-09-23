import type { ToolConfiguration } from './is-tool';
import type {
  ToolCancelledEvent,
  ToolExecuteErrorEvent,
  ToolExecuteStartEvent,
  ToolExecuteSuccessEvent,
  ToolFinishedEvent,
  ToolPolicyActionRequiredEvent,
  ToolPolicyDeniedEvent,
  ToolSettledEvent,
  ToolStartedEvent,
  ToolStatusUpdateEvent,
  ToolValidateErrorEvent,
  ToolValidateSuccessEvent,
} from './tool-lifecycle-events';
import type {
  ToolLogEvent,
  ToolOutputChunkEvent,
  ToolProgressEvent,
  ToolStreamChunkEvent,
  ToolStreamEndEvent,
  ToolStreamErrorEvent,
  ToolStreamStartEvent,
} from './tool-stream-events';
import type {
  ToolboxCallEvent,
  ToolboxCompleteEvent,
  ToolboxErrorEvent,
  ToolboxNameResolvedEvent,
  ToolboxNotFoundEvent,
  ToolboxQueryEvent,
  ToolboxSearchEvent,
} from './toolbox-discovery-events';
import type {
  ToolboxCancelledEvent,
  ToolboxExecuteErrorEvent,
  ToolboxExecuteStartEvent,
  ToolboxExecuteSuccessEvent,
  ToolboxSettledEvent,
  ToolboxStatusUpdateEvent,
  ToolboxToolFinishedEvent,
  ToolboxToolStartedEvent,
  ToolboxValidateErrorEvent,
  ToolboxValidateSuccessEvent,
} from './toolbox-lifecycle-events';
import type {
  ToolboxBudgetExceededEvent,
  ToolboxGrantUsedEvent,
  ToolboxLoopBlockedEvent,
  ToolboxLoopWarningEvent,
  ToolboxPolicyDeniedEvent,
} from './toolbox-policy-events';
import type {
  ToolboxLogEvent,
  ToolboxOutputChunkEvent,
  ToolboxProgressEvent,
  ToolboxStreamChunkEvent,
  ToolboxStreamEndEvent,
  ToolboxStreamErrorEvent,
  ToolboxStreamStartEvent,
} from './toolbox-stream-events';
import type { ToolCall } from './types';

export type ToolEventDetailContext = { toolCall: ToolCall; configuration: ToolConfiguration };
export type ToolExecutionIdentity = { executionId?: string; ownerId?: string };

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
