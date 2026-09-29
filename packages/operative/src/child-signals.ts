/**
 * Typed in-memory parent-child signals (COR-814).
 *
 * A `ChildSignalContract` is the typed signal map a parent hands
 * `dispatchChildRun` alongside the child it starts: `signals` names what the
 * parent may send down, `events` names what the child may emit up, and every
 * entry is a Zod schema both sides validate against. `dispatchChildRun`
 * builds one channel per dispatch from it and splits it into two endpoints:
 *
 * - the parent keeps a {@link ParentSignalEndpoint} on the returned handle
 *   (`handle.signals`), which sends signals and resolves each one to an
 *   explicit acknowledgement or a typed rejection, and observes the child's
 *   events;
 * - the child receives a {@link ChildSignalPort} as
 *   `AgentRunContext.parentSignals`, which a `createAgent` run also threads
 *   into every tool call as `ToolContext.executionContext.parentSignals`.
 *   Code inside the child reaches it with {@link readParentSignals}.
 *
 * Neither endpoint takes a run id: each is bound to exactly one
 * parent-child pair when the channel is built, and every message carries
 * that pair's `parentRunId`/`childRunId`. There is no way to address a
 * sibling, an unrelated run, or a grandchild through one — a child that
 * dispatches its own child gets a new channel only if it supplies its own
 * contract, never its parent's port. That keeps this an orchestrator-
 * mediated, typed parent-child channel (COR-807) rather than a global
 * mailbox.
 *
 * Messages that arrive before their consumer is registered wait in a
 * bounded per-channel buffer and are delivered in order once one is. The
 * channel closes exactly once — on abort, on the child's terminal result,
 * or on disposal — and closing resolves every unsettled send as a
 * `channel-closed` rejection, drops buffered messages, releases every
 * handler and listener, and makes every later send, emit, and registration
 * inert.
 *
 * Everything here is in-memory and process-local by design: no persistence,
 * no restart recovery, and no network transport.
 */

import type { Subscription } from '@lostgradient/lifecycle';
import type { z, ZodType } from 'zod';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** A map of message names to the Zod schema each message's payload must satisfy. */
export type ChildSignalSchemas = Readonly<Record<string, ZodType>>;

/**
 * The typed signal map for one parent-child relationship. `signals` flow
 * parent → child; `events` flow child → parent.
 */
export interface ChildSignalContract<
  Signals extends ChildSignalSchemas = ChildSignalSchemas,
  Events extends ChildSignalSchemas = ChildSignalSchemas,
> {
  readonly signals: Signals;
  readonly events: Events;
}

/**
 * Freezes a signal contract so that neither side can change the schemas
 * the other side validates against, and preserves its literal names and
 * schema types for inference. Share the returned object between the
 * dispatching parent and the child's own code: {@link readParentSignals}
 * matches the port against this exact object.
 */
export function defineChildSignals<
  const Signals extends ChildSignalSchemas,
  const Events extends ChildSignalSchemas,
>(contract: {
  readonly signals: Signals;
  readonly events: Events;
}): ChildSignalContract<Signals, Events> {
  return Object.freeze({
    signals: Object.freeze({ ...contract.signals }),
    events: Object.freeze({ ...contract.events }),
  });
}

type SignalName<C extends ChildSignalContract> = keyof C['signals'] & string;
type EventName<C extends ChildSignalContract> = keyof C['events'] & string;

// ---------------------------------------------------------------------------
// Messages and outcomes
// ---------------------------------------------------------------------------

/** The parent-child pair every message and outcome on a channel is bound to. */
export interface ChildSignalCorrelation {
  readonly parentRunId: string;
  readonly childRunId: string;
}

/**
 * One validated message as its recipient receives it. `payload` is the
 * schema's parsed output, structurally cloned so the sender and recipient
 * never share a reference. `sequence` counts every attempt in one
 * direction, starting at `1`; `id` is `${childRunId}:signal:${sequence}`
 * for signals and `${childRunId}:event:${sequence}` for events.
 */
export interface ChildSignalMessage<
  Name extends string = string,
  Payload = unknown,
> extends ChildSignalCorrelation {
  readonly id: string;
  readonly sequence: number;
  readonly name: Name;
  readonly payload: Payload;
}

/** Why a channel closed. The first reason wins; later closes are no-ops. */
export type ChildSignalCloseReason = 'completed' | 'failed' | 'aborted' | 'disposed';

/**
 * Why a send or emit was refused:
 *
 * - `channel-closed`: the channel closed before the message was
 *   acknowledged (see `closeReason` and `delivered`).
 * - `unknown-name`: the contract declares no message with this name.
 * - `invalid-payload`: the payload failed its schema, the schema threw
 *   while parsing it (a throwing or asynchronous refinement or transform),
 *   or the parsed payload cannot be structurally cloned.
 * - `buffer-full`: no consumer is registered and the channel's buffer for
 *   this direction is at its bound.
 * - `handler-failed`: the child's signal handler threw or rejected.
 */
export type ChildSignalRejectionCode =
  'channel-closed' | 'unknown-name' | 'invalid-payload' | 'buffer-full' | 'handler-failed';

interface ChildSignalAttempt<Name extends string> extends ChildSignalCorrelation {
  readonly id: string;
  readonly sequence: number;
  readonly name: Name;
}

/** The child's handler for this signal settled successfully. */
export interface ChildSignalAcknowledgement<
  Name extends string = string,
> extends ChildSignalAttempt<Name> {
  readonly status: 'acknowledged';
}

/** A send or emit that did not succeed, with a typed reason. */
export interface ChildSignalRejection<
  Name extends string = string,
> extends ChildSignalAttempt<Name> {
  readonly status: 'rejected';
  readonly code: ChildSignalRejectionCode;
  readonly reason: string;
  /** Present only when `code` is `'channel-closed'`. */
  readonly closeReason?: ChildSignalCloseReason;
  /**
   * Whether the recipient had already been handed the message. A
   * `channel-closed` rejection with `delivered: true` means the child's
   * handler was running when the channel closed, so it may have acted on
   * the signal without the parent receiving its acknowledgement.
   */
  readonly delivered: boolean;
}

/** What {@link ParentSignalEndpoint.send} resolves to. It never rejects. */
export type ChildSignalOutcome<Name extends string = string> =
  ChildSignalAcknowledgement<Name> | ChildSignalRejection<Name>;

/** A child event the channel accepted. */
export interface ChildEventEmission<Name extends string = string> extends ChildSignalAttempt<Name> {
  readonly status: 'emitted';
  /** `true` when a parent listener received it now; `false` when it was buffered. */
  readonly delivered: boolean;
}

/** What {@link ChildSignalPort.emit} returns. It never throws. */
export type ChildEventOutcome<Name extends string = string> =
  ChildEventEmission<Name> | ChildSignalRejection<Name>;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** The parent's side of one channel, exposed as `handle.signals`. */
export interface ParentSignalEndpoint<
  C extends ChildSignalContract = ChildSignalContract,
> extends ChildSignalCorrelation {
  /**
   * Sends one signal to this endpoint's child. Resolves to an
   * acknowledgement once the child's handler settles, or to a typed
   * rejection. A signal sent before the child registers a handler for its
   * name waits in the channel's buffer.
   */
  send<Name extends SignalName<C>>(
    name: Name,
    payload: z.input<C['signals'][Name]>,
  ): Promise<ChildSignalOutcome<Name>>;
  /**
   * Observes one event name from this endpoint's child. Events emitted
   * before this call are delivered to `listener` synchronously, in order.
   * One listener per name at a time; a listener that throws never reaches
   * the emitting child.
   *
   * @throws {TypeError} when the contract declares no event named `name`.
   * @throws {Error} when a listener for `name` is already registered.
   */
  on<Name extends EventName<C>>(
    name: Name,
    listener: (message: ChildSignalMessage<Name, z.output<C['events'][Name]>>) => void,
  ): Subscription;
  /** `undefined` while the channel is open. */
  readonly closeReason: ChildSignalCloseReason | undefined;
}

/**
 * A child signal handler. Returning (or resolving) acknowledges the signal;
 * throwing (or rejecting) refuses it with a `handler-failed` rejection whose
 * `reason` is the error's message.
 */
export type ChildSignalHandler<Name extends string, Payload> = (
  message: ChildSignalMessage<Name, Payload>,
) => void | Promise<void>;

/** The child's side of one channel, received as `AgentRunContext.parentSignals`. */
export interface ChildSignalPort<
  C extends ChildSignalContract = ChildSignalContract,
> extends ChildSignalCorrelation {
  /** The contract this channel was built with. */
  readonly contract: C;
  /**
   * Handles one signal name from this port's parent. Signals sent before
   * this call are delivered to `handler` synchronously, in order. One
   * handler per name at a time.
   *
   * @throws {TypeError} when the contract declares no signal named `name`.
   * @throws {Error} when a handler for `name` is already registered.
   */
  onSignal<Name extends SignalName<C>>(
    name: Name,
    handler: ChildSignalHandler<Name, z.output<C['signals'][Name]>>,
  ): Subscription;
  /** Emits one event to this port's parent. */
  emit<Name extends EventName<C>>(
    name: Name,
    payload: z.input<C['events'][Name]>,
  ): ChildEventOutcome<Name>;
  /** `undefined` while the channel is open. */
  readonly closeReason: ChildSignalCloseReason | undefined;
}

/** Both endpoints of one channel plus its single close operation. */
export interface ChildSignalChannel<C extends ChildSignalContract = ChildSignalContract> {
  readonly parent: ParentSignalEndpoint<C>;
  readonly child: ChildSignalPort<C>;
  /** Closes the channel. Idempotent: the first reason is kept. */
  close(reason: ChildSignalCloseReason): void;
}

export interface CreateChildSignalChannelOptions {
  /**
   * The most messages one direction may hold while no consumer is
   * registered for them. Defaults to {@link DEFAULT_CHILD_SIGNAL_BUFFER_LIMIT}.
   * `0` buffers nothing, so a message with no consumer is refused as
   * `buffer-full`. Anything but a non-negative integer throws a `RangeError`.
   */
  bufferLimit?: number | undefined;
}

/** The default per-direction buffer bound for a channel. */
export const DEFAULT_CHILD_SIGNAL_BUFFER_LIMIT = 64;

// ---------------------------------------------------------------------------
// Port lookup
// ---------------------------------------------------------------------------

/**
 * Every port a channel has created. Membership, not shape, is what
 * {@link readParentSignals} trusts, so a structurally identical object
 * built anywhere else is never accepted as a parent port.
 */
const channelPorts = new WeakSet<object>();

/**
 * Reads the child-side port for `contract` from a bag that may carry one:
 * a tool call's `ToolContext.executionContext`, or the `AgentRunContext` a
 * `RunnableAgent.run()` implementation receives. Returns `undefined` when
 * this run has no parent port, or when its port was built from a different
 * contract object — the child only ever sees signals typed by the exact
 * contract it asked for.
 */
export function readParentSignals<C extends ChildSignalContract>(
  source: { readonly parentSignals?: unknown } | undefined,
  contract: C,
): ChildSignalPort<C> | undefined {
  const candidate = source?.parentSignals;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  if (!channelPorts.has(candidate)) return undefined;
  const port = candidate as ChildSignalPort;
  // Identity with `contract` is what makes narrowing to `ChildSignalPort<C>`
  // sound: the channel validates every payload against this same object.
  return port.contract === contract ? (port as unknown as ChildSignalPort<C>) : undefined;
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

interface PendingSignal {
  readonly message: ChildSignalMessage;
  readonly resolve: (outcome: ChildSignalOutcome) => void;
  delivered: boolean;
}

type AnyHandler = (message: ChildSignalMessage) => void | Promise<void>;
type AnyListener = (message: ChildSignalMessage) => void;

const closedSubscription: Subscription = Object.freeze({
  unsubscribe(): void {},
  closed: true,
});

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Validation = { ok: true; payload: unknown } | { ok: false; reason: string };

/**
 * Parses `payload` against `schema`, then clones the parsed value. Never
 * throws. `safeParse` reports schema issues itself, but it rethrows an error
 * thrown inside a refinement or transform, and it throws when the schema has
 * an asynchronous refinement or transform it cannot await; both become an
 * `invalid-payload` reason here instead of escaping into `send` or `emit`.
 */
function validatePayload(schema: ZodType, payload: unknown): Validation {
  let parsed: ReturnType<ZodType['safeParse']>;
  try {
    parsed = schema.safeParse(payload);
  } catch (error) {
    return { ok: false, reason: `The payload schema threw: ${describeError(error)}` };
  }
  if (!parsed.success) return { ok: false, reason: parsed.error.message };
  try {
    return { ok: true, payload: structuredClone(parsed.data) };
  } catch (error) {
    return { ok: false, reason: `The payload cannot be cloned: ${describeError(error)}` };
  }
}

/**
 * Builds one channel bound to `correlation`. `dispatchChildRun` calls this
 * once per dispatch that supplies a contract, and closes it when the child
 * is aborted, settles, or is disposed.
 */
export function createChildSignalChannel<C extends ChildSignalContract>(
  contract: C,
  correlation: ChildSignalCorrelation,
  options: CreateChildSignalChannelOptions = {},
): ChildSignalChannel<C> {
  const { parentRunId, childRunId } = correlation;
  const bufferLimit = options.bufferLimit ?? DEFAULT_CHILD_SIGNAL_BUFFER_LIMIT;
  // `NaN` or `Infinity` would silently make the buffer unbounded.
  if (!Number.isSafeInteger(bufferLimit) || bufferLimit < 0) {
    throw new RangeError(
      `A parent-child signal buffer limit must be a non-negative integer; received ${bufferLimit}.`,
    );
  }

  let closeReason: ChildSignalCloseReason | undefined;
  let signalSequence = 0;
  let eventSequence = 0;

  const handlers = new Map<string, AnyHandler>();
  const signalQueues = new Map<string, PendingSignal[]>();
  let bufferedSignals = 0;
  /** Every signal not yet settled, buffered or in flight. */
  const unsettled = new Set<PendingSignal>();

  const listeners = new Map<string, AnyListener>();
  const eventQueues = new Map<string, ChildSignalMessage[]>();
  let bufferedEvents = 0;

  const activeSubscriptions = new Set<{ release(): void }>();

  function attempt<Name extends string>(
    direction: 'signal' | 'event',
    name: Name,
  ): ChildSignalAttempt<Name> {
    const sequence = direction === 'signal' ? ++signalSequence : ++eventSequence;
    return {
      id: `${childRunId}:${direction}:${sequence}`,
      sequence,
      name,
      parentRunId,
      childRunId,
    };
  }

  function rejection<Name extends string>(
    base: ChildSignalAttempt<Name>,
    code: ChildSignalRejectionCode,
    reason: string,
    delivered = false,
  ): ChildSignalRejection<Name> {
    return { ...base, status: 'rejected', code, reason, delivered };
  }

  function closedRejection<Name extends string>(
    base: ChildSignalAttempt<Name>,
    reason: ChildSignalCloseReason,
    delivered = false,
  ): ChildSignalRejection<Name> {
    return {
      ...rejection(base, 'channel-closed', `The parent-child signal channel closed: ${reason}.`),
      closeReason: reason,
      delivered,
    };
  }

  function attemptOf(message: ChildSignalMessage): ChildSignalAttempt<string> {
    const { payload: _payload, ...base } = message;
    return base;
  }

  function settleSignal(pending: PendingSignal, outcome: ChildSignalOutcome): void {
    // A signal the close already resolved stays resolved as `channel-closed`.
    if (!unsettled.delete(pending)) return;
    pending.resolve(outcome);
  }

  function deliverSignal(pending: PendingSignal, handler: AnyHandler): void {
    pending.delivered = true;
    const base = attemptOf(pending.message);
    // An async wrapper runs `handler` synchronously and turns a synchronous
    // throw into the same rejection an asynchronous failure produces.
    const run = async (): Promise<void> => {
      await handler(pending.message);
    };
    void run().then(
      () => settleSignal(pending, { ...base, status: 'acknowledged' }),
      (error: unknown) =>
        settleSignal(pending, rejection(base, 'handler-failed', describeError(error), true)),
    );
  }

  function invokeListener(listener: AnyListener, message: ChildSignalMessage): void {
    try {
      listener(message);
    } catch {
      // A throwing parent listener is the parent's bug; it never reaches
      // the emitting child or a later event.
    }
  }

  /**
   * Registers `consumer` under `name` and drains that name's buffer to it
   * in order. The queue stays in the map while it drains, so a message
   * sent re-entrantly from inside the consumer joins the back of the queue
   * instead of overtaking the ones still waiting.
   */
  function register<T, Consumer>(registration: {
    readonly direction: 'signal' | 'event';
    readonly consumerKind: 'handler' | 'listener';
    readonly names: ChildSignalSchemas;
    readonly name: string;
    readonly consumers: Map<string, Consumer>;
    readonly queues: Map<string, T[]>;
    readonly consumer: Consumer;
    readonly drain: (item: T) => void;
  }): Subscription {
    const { direction, consumerKind, names, name, consumers, queues, consumer, drain } =
      registration;
    if (!Object.hasOwn(names, name)) {
      throw new TypeError(`The signal contract declares no ${direction} named "${name}".`);
    }
    if (closeReason !== undefined) return closedSubscription;
    if (consumers.has(name)) {
      throw new Error(
        `The ${direction} "${name}" already has a ${consumerKind} on this parent-child signal channel.`,
      );
    }
    consumers.set(name, consumer);

    let released = false;
    const entry = {
      release(): void {
        released = true;
        activeSubscriptions.delete(entry);
      },
    };
    activeSubscriptions.add(entry);

    const queue = queues.get(name) ?? [];
    // Stops early if `drain` unsubscribes this consumer or closes the channel.
    while (consumers.get(name) === consumer) {
      const next = queue.shift();
      if (next === undefined) {
        queues.delete(name);
        break;
      }
      drain(next);
    }

    return {
      unsubscribe(): void {
        if (released) return;
        entry.release();
        if (consumers.get(name) === consumer) consumers.delete(name);
      },
      get closed(): boolean {
        return released;
      },
    };
  }

  const parent: ParentSignalEndpoint<C> = {
    parentRunId,
    childRunId,
    get closeReason() {
      return closeReason;
    },
    send(name, payload) {
      const base = attempt('signal', name);
      if (closeReason !== undefined) return Promise.resolve(closedRejection(base, closeReason));
      const schema = Object.hasOwn(contract.signals, name) ? contract.signals[name] : undefined;
      if (schema === undefined) {
        return Promise.resolve(
          rejection(base, 'unknown-name', `The signal contract declares no signal "${name}".`),
        );
      }
      const validation = validatePayload(schema, payload);
      if (!validation.ok) {
        return Promise.resolve(rejection(base, 'invalid-payload', validation.reason));
      }

      const handler = handlers.get(name);
      const queue = signalQueues.get(name);
      if ((handler === undefined || queue !== undefined) && bufferedSignals >= bufferLimit) {
        return Promise.resolve(
          rejection(base, 'buffer-full', `The signal buffer is full (${bufferLimit}).`),
        );
      }

      const message = Object.freeze({ ...base, payload: validation.payload });
      return new Promise<ChildSignalOutcome>((resolve) => {
        const pending: PendingSignal = { message, resolve, delivered: false };
        unsettled.add(pending);
        if (handler !== undefined && queue === undefined) {
          deliverSignal(pending, handler);
          return;
        }
        bufferedSignals++;
        if (queue === undefined) signalQueues.set(name, [pending]);
        else queue.push(pending);
      }) as Promise<ChildSignalOutcome<typeof name>>;
    },
    on(name, listener) {
      const consumer = listener as AnyListener;
      return register({
        direction: 'event',
        consumerKind: 'listener',
        names: contract.events,
        name,
        consumers: listeners,
        queues: eventQueues,
        consumer,
        drain: (message) => {
          bufferedEvents--;
          invokeListener(consumer, message);
        },
      });
    },
  };

  const child: ChildSignalPort<C> = {
    parentRunId,
    childRunId,
    contract,
    get closeReason() {
      return closeReason;
    },
    onSignal(name, handler) {
      const consumer = handler as AnyHandler;
      return register({
        direction: 'signal',
        consumerKind: 'handler',
        names: contract.signals,
        name,
        consumers: handlers,
        queues: signalQueues,
        consumer,
        drain: (pending) => {
          bufferedSignals--;
          deliverSignal(pending, consumer);
        },
      });
    },
    emit(name, payload) {
      const base = attempt('event', name);
      if (closeReason !== undefined) return closedRejection(base, closeReason);
      const schema = Object.hasOwn(contract.events, name) ? contract.events[name] : undefined;
      if (schema === undefined) {
        return rejection(base, 'unknown-name', `The signal contract declares no event "${name}".`);
      }
      const validation = validatePayload(schema, payload);
      if (!validation.ok) return rejection(base, 'invalid-payload', validation.reason);

      const message = Object.freeze({ ...base, payload: validation.payload });
      const listener = listeners.get(name);
      const queue = eventQueues.get(name);
      if (listener !== undefined && queue === undefined) {
        invokeListener(listener, message);
        return { ...base, status: 'emitted', delivered: true };
      }
      if (bufferedEvents >= bufferLimit) {
        return rejection(base, 'buffer-full', `The event buffer is full (${bufferLimit}).`);
      }
      bufferedEvents++;
      if (queue === undefined) eventQueues.set(name, [message]);
      else queue.push(message);
      return { ...base, status: 'emitted', delivered: false };
    },
  };
  channelPorts.add(child);

  return {
    parent,
    child,
    close(reason) {
      if (closeReason !== undefined) return;
      closeReason = reason;
      const pendingSignals = [...unsettled];
      unsettled.clear();
      signalQueues.clear();
      eventQueues.clear();
      bufferedSignals = 0;
      bufferedEvents = 0;
      handlers.clear();
      listeners.clear();
      // `release` deletes only the entry being visited, which Set iteration allows.
      for (const subscription of activeSubscriptions) subscription.release();
      for (const pending of pendingSignals) {
        pending.resolve(closedRejection(attemptOf(pending.message), reason, pending.delivered));
      }
    },
  };
}
