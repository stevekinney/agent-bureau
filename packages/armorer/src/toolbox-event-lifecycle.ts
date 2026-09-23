import { CompletableEventTarget } from '@lostgradient/lifecycle';

import type { LoopDetector } from './core/loop-detection';
import type { ToolboxEventMap } from './event-types';
import type { ExecutionLifecycle } from './execution-lifecycle';
import type { ToolboxEventDispatcher, ToolboxEvents, ToolboxEventType } from './toolbox-contracts';
import {
  ToolboxCallEvent,
  ToolboxCompleteEvent,
  ToolboxErrorEvent,
  ToolboxNameResolvedEvent,
  ToolboxNotFoundEvent,
  ToolboxQueryEvent,
  ToolboxSearchEvent,
} from './toolbox-discovery-events';
import {
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
import {
  ToolboxBudgetExceededEvent,
  ToolboxGrantUsedEvent,
  ToolboxLoopBlockedEvent,
  ToolboxLoopWarningEvent,
  ToolboxPolicyDeniedEvent,
} from './toolbox-policy-events';
import {
  ToolboxLogEvent,
  ToolboxOutputChunkEvent,
  ToolboxProgressEvent,
  ToolboxStreamChunkEvent,
  ToolboxStreamEndEvent,
  ToolboxStreamErrorEvent,
  ToolboxStreamStartEvent,
} from './toolbox-stream-events';

type ToolboxEventConstructor = new (detail: any) => Event;

export type ToolboxEventEmitter = {
  emit: {
    <K extends ToolboxEventType>(type: K, detail: ToolboxEvents[K]): boolean;
    (type: string, detail: unknown): boolean;
  };
  addEventListener: <K extends keyof ToolboxEventMap & string>(
    type: K,
    listener: (event: ToolboxEventMap[K]) => void | Promise<void>,
    options?: AddEventListenerOptions,
  ) => () => void;
  dispatchEvent: ToolboxEventDispatcher;
  complete: () => Promise<void>;
};

export function createToolboxEventEmitter(
  emitter: CompletableEventTarget<ToolboxEventMap>,
  loopDetectors: Map<string, LoopDetector>,
  executionLifecycle: ExecutionLifecycle,
): ToolboxEventEmitter {
  const toolboxEventClassMap: Record<string, ToolboxEventConstructor> = {
    [ToolboxCallEvent.type]: ToolboxCallEvent,
    [ToolboxCompleteEvent.type]: ToolboxCompleteEvent,
    [ToolboxErrorEvent.type]: ToolboxErrorEvent,
    [ToolboxNotFoundEvent.type]: ToolboxNotFoundEvent,
    [ToolboxQueryEvent.type]: ToolboxQueryEvent,
    [ToolboxSearchEvent.type]: ToolboxSearchEvent,
    [ToolboxStatusUpdateEvent.type]: ToolboxStatusUpdateEvent,
    [ToolboxExecuteStartEvent.type]: ToolboxExecuteStartEvent,
    [ToolboxValidateSuccessEvent.type]: ToolboxValidateSuccessEvent,
    [ToolboxValidateErrorEvent.type]: ToolboxValidateErrorEvent,
    [ToolboxExecuteSuccessEvent.type]: ToolboxExecuteSuccessEvent,
    [ToolboxExecuteErrorEvent.type]: ToolboxExecuteErrorEvent,
    [ToolboxSettledEvent.type]: ToolboxSettledEvent,
    [ToolboxPolicyDeniedEvent.type]: ToolboxPolicyDeniedEvent,
    [ToolboxToolStartedEvent.type]: ToolboxToolStartedEvent,
    [ToolboxToolFinishedEvent.type]: ToolboxToolFinishedEvent,
    [ToolboxBudgetExceededEvent.type]: ToolboxBudgetExceededEvent,
    [ToolboxProgressEvent.type]: ToolboxProgressEvent,
    [ToolboxStreamStartEvent.type]: ToolboxStreamStartEvent,
    [ToolboxStreamChunkEvent.type]: ToolboxStreamChunkEvent,
    [ToolboxStreamEndEvent.type]: ToolboxStreamEndEvent,
    [ToolboxStreamErrorEvent.type]: ToolboxStreamErrorEvent,
    [ToolboxOutputChunkEvent.type]: ToolboxOutputChunkEvent,
    [ToolboxLogEvent.type]: ToolboxLogEvent,
    [ToolboxCancelledEvent.type]: ToolboxCancelledEvent,
    [ToolboxNameResolvedEvent.type]: ToolboxNameResolvedEvent,
    [ToolboxLoopWarningEvent.type]: ToolboxLoopWarningEvent,
    [ToolboxLoopBlockedEvent.type]: ToolboxLoopBlockedEvent,
    [ToolboxGrantUsedEvent.type]: ToolboxGrantUsedEvent,
  };

  function emit<K extends ToolboxEventType>(type: K, detail: ToolboxEvents[K]): boolean;
  function emit(type: string, detail: unknown): boolean;
  function emit(type: string, detail: unknown): boolean {
    const eventConstructor = toolboxEventClassMap[type];
    if (eventConstructor) return emitter.dispatchEvent(new eventConstructor(detail));
    const event = new Event(type);
    if (detail && typeof detail === 'object') Object.assign(event, detail);
    return emitter.dispatchEvent(event);
  }

  const addEventListener = <K extends keyof ToolboxEventMap & string>(
    type: K,
    listener: (event: ToolboxEventMap[K]) => void | Promise<void>,
    options?: AddEventListenerOptions,
  ): (() => void) => {
    const mergedOptions: AddEventListenerOptions = {
      ...options,
      signal: options?.signal ? AbortSignal.any([options.signal, emitter.signal]) : emitter.signal,
    };
    const wrapped = (event: ToolboxEventMap[K]): void => {
      void listener(event);
    };
    emitter.addEventListener(type, wrapped, mergedOptions);
    return () => emitter.removeEventListener(type, wrapped, options);
  };

  return {
    emit,
    addEventListener,
    dispatchEvent: (event) => emitter.dispatchEvent(event),
    async complete() {
      loopDetectors.clear();
      emitter.complete();
      await executionLifecycle.shutdown();
    },
  };
}

export function completeToolboxOnAbort(signal: AbortSignal, complete: () => Promise<void>): void {
  const onAbort = () => {
    void complete();
    signal.removeEventListener('abort', onAbort);
  };
  if (signal.aborted) {
    void complete();
    return;
  }
  signal.addEventListener('abort', onAbort);
}
