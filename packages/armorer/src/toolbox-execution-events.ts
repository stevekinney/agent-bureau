import type { DefaultToolEvents, Tool } from './is-tool';
import type { ToolCall } from './types';

/**
 * The final status a deferred `paused` settlement is released under, once
 * approval issuance is authoritative (COR-45).
 */
export type DeferredSettlementOutcome = {
  readonly status: 'paused' | 'error';
  readonly result: unknown;
  readonly error: unknown;
};

/**
 * Releases the toolbox-level settlement that was withheld while a paused
 * call's approval was still being bound, signed and issued. Flushing is
 * idempotent and a no-op when the call never paused, so every exit from the
 * invocation can flush without risking a second settlement.
 */
export type DeferredSettlement = {
  readonly flush: (outcome: DeferredSettlementOutcome) => void;
};

export function subscribeToolEvents(
  tool: Tool,
  childExecutionId: string,
  toolCall: ToolCall,
  emit: (type: string, detail: unknown) => boolean,
  cleanup: Array<() => void>,
): DeferredSettlement {
  // Always bubble up events for consistency
  const toolEventTypes: (keyof DefaultToolEvents)[] = [
    'tool.started',
    'tool.finished',
    'execute-start',
    'validate-success',
    'validate-error',
    'execute-success',
    'execute-error',
    'settled',
    'policy-denied',
    'progress',
    'stream-start',
    'stream-chunk',
    'stream-end',
    'stream-error',
    'output-chunk',
    'log',
    'cancelled',
    'status-update',
  ];

  // Tool events and toolbox events use different naming conventions in some cases.
  // Map tool-level event types to toolbox-level event types where they differ.
  const toolToToolboxEventType: Partial<Record<keyof DefaultToolEvents, string>> = {
    'status-update': 'status:update',
  };

  // AB-290/AB-318: every type in `toolEventTypes` now carries
  // `executionId` (armorer's own per-execution id) — AB-290 covered
  // `execute-start`/`progress`/`settled`, AB-318 covers the rest,
  // including the two dispatch-only types (`status-update`,
  // `cancelled`) via `create-tool.ts`'s `contextDispatch` stamping.
  // This same `Tool` instance can have more than one of these bubble
  // subscriptions attached at once — one per concurrent
  // `toolbox.execute()` call — and every one of them is broadcast
  // every tool-level event regardless of which invocation actually
  // produced it. Without this filter, a concurrent call's own event
  // would ALSO bubble out of THIS call's subscription (mislabeled
  // with this call's own `toolCall` below), duplicating the
  // toolbox-level event once per concurrently in-flight call to the
  // same tool.
  // COR-45: a `paused` settlement is only authoritative once the approval
  // has been bound, signed and issued, all of which happen after
  // `tool.execute` resolves. Hold the bubbled detail here and let the
  // invocation release it with its real outcome.
  let deferredSettledDetail: Record<string, unknown> | undefined;

  for (const eventType of toolEventTypes) {
    const unsubscribe = tool.addEventListener(eventType, (toolEvent: Event) => {
      if (readExecutionId(toolEvent) !== childExecutionId) {
        return;
      }
      // Extract event properties (excluding standard Event fields)
      const eventProps: Record<string, unknown> = {};
      for (const key of Object.getOwnPropertyNames(toolEvent)) {
        if (key !== 'type' && key !== 'isTrusted') {
          eventProps[key] = Object.getOwnPropertyDescriptor(toolEvent, key)?.value;
        }
      }
      // Bubble up the event with tool and call context.
      // Include callId and name so that remapped events (e.g. status-update → status:update)
      // carry the identity fields that the toolbox-level Event class expects.
      const bubbledDetail = {
        ...eventProps,
        callId: toolCall.id,
        name: toolCall.name,
        tool,
        call: toolCall,
      };
      if (eventType === 'settled' && eventProps['status'] === 'paused') {
        deferredSettledDetail = bubbledDetail;
        return;
      }
      // Resolve the toolbox-level event type (may differ from the tool-level name)
      const toolboxEventType = toolToToolboxEventType[eventType] ?? eventType;
      // Use emit helper which handles the type conversion
      emit(toolboxEventType, bubbledDetail);
    });
    cleanup.push(unsubscribe);
  }

  return {
    flush(outcome) {
      if (!deferredSettledDetail) return;
      const detail = deferredSettledDetail;
      deferredSettledDetail = undefined;
      emit('settled', { ...detail, ...outcome });
    },
  };
}

function readExecutionId(event: Event): string | undefined {
  if (!('executionId' in event)) return undefined;
  const value = event.executionId;
  return typeof value === 'string' ? value : undefined;
}
