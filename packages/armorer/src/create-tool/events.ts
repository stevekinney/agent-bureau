import {
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
} from '../tool-lifecycle-events';
import {
  ToolLogEvent,
  ToolOutputChunkEvent,
  ToolProgressEvent,
  ToolStreamChunkEvent,
  ToolStreamEndEvent,
  ToolStreamErrorEvent,
  ToolStreamStartEvent,
} from '../tool-stream-events';

export const identityBearingToolEventTypes = new Set<string>([
  ToolStatusUpdateEvent.type,
  ToolExecuteStartEvent.type,
  ToolValidateSuccessEvent.type,
  ToolValidateErrorEvent.type,
  ToolExecuteSuccessEvent.type,
  ToolExecuteErrorEvent.type,
  ToolSettledEvent.type,
  ToolPolicyDeniedEvent.type,
  ToolPolicyActionRequiredEvent.type,
  ToolStartedEvent.type,
  ToolFinishedEvent.type,
  ToolProgressEvent.type,
  ToolStreamStartEvent.type,
  ToolStreamChunkEvent.type,
  ToolStreamEndEvent.type,
  ToolStreamErrorEvent.type,
  ToolOutputChunkEvent.type,
  ToolLogEvent.type,
  ToolCancelledEvent.type,
]);

const eventFactories = new Map<string, (detail: unknown) => Event>([
  [ToolStatusUpdateEvent.type, (detail) => Reflect.construct(ToolStatusUpdateEvent, [detail])],
  [ToolExecuteStartEvent.type, (detail) => Reflect.construct(ToolExecuteStartEvent, [detail])],
  [
    ToolValidateSuccessEvent.type,
    (detail) => Reflect.construct(ToolValidateSuccessEvent, [detail]),
  ],
  [ToolValidateErrorEvent.type, (detail) => Reflect.construct(ToolValidateErrorEvent, [detail])],
  [ToolExecuteSuccessEvent.type, (detail) => Reflect.construct(ToolExecuteSuccessEvent, [detail])],
  [ToolExecuteErrorEvent.type, (detail) => Reflect.construct(ToolExecuteErrorEvent, [detail])],
  [ToolSettledEvent.type, (detail) => Reflect.construct(ToolSettledEvent, [detail])],
  [ToolPolicyDeniedEvent.type, (detail) => Reflect.construct(ToolPolicyDeniedEvent, [detail])],
  [
    ToolPolicyActionRequiredEvent.type,
    (detail) => Reflect.construct(ToolPolicyActionRequiredEvent, [detail]),
  ],
  [ToolStartedEvent.type, (detail) => Reflect.construct(ToolStartedEvent, [detail])],
  [ToolFinishedEvent.type, (detail) => Reflect.construct(ToolFinishedEvent, [detail])],
  [ToolProgressEvent.type, (detail) => Reflect.construct(ToolProgressEvent, [detail])],
  [ToolStreamStartEvent.type, (detail) => Reflect.construct(ToolStreamStartEvent, [detail])],
  [ToolStreamChunkEvent.type, (detail) => Reflect.construct(ToolStreamChunkEvent, [detail])],
  [ToolStreamEndEvent.type, (detail) => Reflect.construct(ToolStreamEndEvent, [detail])],
  [ToolStreamErrorEvent.type, (detail) => Reflect.construct(ToolStreamErrorEvent, [detail])],
  [ToolOutputChunkEvent.type, (detail) => Reflect.construct(ToolOutputChunkEvent, [detail])],
  [ToolLogEvent.type, (detail) => Reflect.construct(ToolLogEvent, [detail])],
  [ToolCancelledEvent.type, (detail) => Reflect.construct(ToolCancelledEvent, [detail])],
]);

export function createKnownToolEvent(type: string, detail: unknown): Event | undefined {
  return eventFactories.get(type)?.(detail);
}
