# Lifecycle

`lifecycle` contains the shared event and hook primitives used across Agent Bureau. It has no agent-domain behavior of its own; it provides the typed infrastructure that other packages use to publish state, expose observables, and compose hooks.

## What It Does

- Provides `TypedEventTarget` for strongly typed DOM-style events.
- Adds `CompletableEventTarget` for event sources that can close cleanly.
- Converts events into async iterators and observable-like subscriptions.
- Forwards events between sources while preserving type information.
- Provides `HookRegistry` and `mergeHookRegistries()` for package-level extension points.

## How It Works

The package wraps standard `EventTarget` behavior in TypeScript types rather than inventing a separate event system. Runtime packages dispatch events through these primitives, and consumers can choose the most convenient consumption style: listener callbacks, async iteration, or observable subscriptions.

Hooks are stored in registries keyed by hook maps. Packages such as `operative` use that pattern to expose lifecycle customization without hard-coding every integration into the run loop.

## Project Role

`lifecycle` is the shared substrate for observability and extension. `conversationalist`, `armorer`, `operative`, `@lostgradient/operative/store`, and `gateway` all rely on event streams or hooks, and this package keeps those mechanics consistent across the workspace.

## Public API

### `TypedEventTarget`

**Signature:** `class TypedEventTarget<M extends EventMap> extends EventTarget`

A type-safe wrapper around the native `EventTarget`. `M` is a record mapping event-type strings to their `Event` subclasses. `addEventListener`, `removeEventListener`, and the added `dispatch()` method all enforce that the event type exists in `M` and that the listener receives the correct event subclass.

**`dispatch(event)`** is the primary addition over the native API—it accepts only events whose `type` key is present in `M`, so typos in event names become compile errors.

```typescript
import { TypedEventTarget } from 'lifecycle';

class ProgressEvent extends Event {
  constructor(public readonly percent: number) {
    super('progress');
  }
}

class DoneEvent extends Event {
  constructor() {
    super('done');
  }
}

type WorkEvents = {
  progress: ProgressEvent;
  done: DoneEvent;
};

class Worker extends TypedEventTarget<WorkEvents> {
  run() {
    this.dispatch(new ProgressEvent(50));
    this.dispatch(new DoneEvent());
  }
}

const worker = new Worker();

worker.addEventListener('progress', (event) => {
  // event is typed as ProgressEvent
  console.log(event.percent);
});

worker.run();
```

---

### `CompletableEventTarget`

**Signature:** `class CompletableEventTarget<M extends EventMap> extends TypedEventTarget<M>`

Extends `TypedEventTarget` with lifecycle management and convenience consumption methods. Internally it holds an `AbortController`; calling `complete()` aborts it, which signals all async iterators and observable subscriptions created through this instance to stop cleanly.

**Properties and methods:**

- **`completed`**: `boolean`—`true` once `complete()` has been called.
- **`signal`**: `AbortSignal`—the underlying signal; pass it to external listeners for coordinated teardown.
- **`complete()`**: Marks the target as done and terminates all active subscriptions and iterators tied to it.
- **`on(type, options?)`**: Returns an `ObservableLike<M[K]>` for a single event type, automatically wired to the target's completion signal.
- **`once(type, listener)`**: Registers a one-shot listener with `{ once: true }` tied to the completion signal so it is removed on `complete()` if the event never fires.
- **`subscribe(type, observerOrNext?, error?, complete?)`**: Shorthand for `this.on(type).subscribe(...)`.
- **`toObservable()`**: Returns an `ObservableLike` that emits _every_ event dispatched on this target and completes when `complete()` is called. This is the integration point used by `forwardEvents()`.
- **`events(type, options?)`**: Returns an `AsyncIterableIterator<M[K]>` for the given event type, terminated by the target's signal.

```typescript
import { CompletableEventTarget } from 'lifecycle';

type StreamEvents = {
  data: MessageEvent;
  end: Event;
};

class DataStream extends CompletableEventTarget<StreamEvents> {
  async produce() {
    for (let i = 0; i < 3; i++) {
      this.dispatch(
        new MessageEvent('data', { data: `chunk-${i}` }) as MessageEvent & { type: 'data' },
      );
    }
    this.dispatch(new Event('end') as Event & { type: 'end' });
    this.complete();
  }
}

const stream = new DataStream();

// Async iteration
(async () => {
  for await (const event of stream.events('data')) {
    console.log(event.data); // 'chunk-0', 'chunk-1', 'chunk-2'
  }
})();

// Observable subscription
stream.on('data').subscribe({
  next(event) {
    console.log('rx', event.data);
  },
  complete() {
    console.log('done');
  },
});

stream.produce();
```

---

### `eventIterator()`

**Signature:**

```typescript
function eventIterator<E extends Event>(
  target: EventTarget,
  type: string,
  options?: EventIteratorOptions,
): AsyncIterableIterator<E>;
```

Adapts any `EventTarget` into an `AsyncIterableIterator`. Events are buffered in a pull-based queue (default capacity: 256 events). The iterator terminates when the provided `AbortSignal` fires or when the caller calls `iterator.return()`.

`EventIteratorOptions`:

- **`signal`**: `AbortSignal`—when aborted, the iterator yields `done: true` on the next `next()` call and removes its listener.
- **`bufferSize`**: `number`—maximum number of unconsumed events to buffer before dropping new ones (default `256`).

```typescript
import { eventIterator } from 'lifecycle';

const controller = new AbortController();
const target = new EventTarget();

const iterator = eventIterator<MessageEvent>(target, 'message', {
  signal: controller.signal,
});

// Consume with for-await
(async () => {
  for await (const event of iterator) {
    console.log(event.data);
    if (event.data === 'stop') break; // calls iterator.return() internally
  }
})();

target.dispatchEvent(new MessageEvent('message', { data: 'hello' }));
target.dispatchEvent(new MessageEvent('message', { data: 'stop' }));

// Or terminate from outside
controller.abort();
```

---

### `eventObservable()`

**Signature:**

```typescript
function eventObservable<E extends Event>(
  target: EventTarget,
  type: string,
  options?: EventObservableOptions,
): ObservableLike<E>;
```

Returns a TC39-style `ObservableLike` for a single event type on any `EventTarget`. The observable completes when the optional `AbortSignal` fires or when `subscription.unsubscribe()` is called.

`EventObservableOptions`:

- **`signal`**: `AbortSignal`—combined with the subscription's own controller via `AbortSignal.any()`.

```typescript
import { eventObservable } from 'lifecycle';

const target = new EventTarget();
const controller = new AbortController();

const subscription = eventObservable<MouseEvent>(target, 'click', {
  signal: controller.signal,
}).subscribe({
  next(event) {
    console.log('clicked at', event.clientX, event.clientY);
  },
  complete() {
    console.log('stream closed');
  },
});

// Stop listening
subscription.unsubscribe();

// Or let the AbortSignal close it
controller.abort();
```

---

### `allEventsObservable()`

**Signature:**

```typescript
function allEventsObservable<E extends Event>(
  target: EventTarget,
  eventTypes: readonly string[],
  options?: EventObservableOptions,
): ObservableLike<E>;
```

Like `eventObservable()`, but subscribes to multiple event types at once and merges them into a single stream. All event types share one subscription and one `unsubscribe()` call.

```typescript
import { allEventsObservable } from 'lifecycle';

const target = new EventTarget();

const subscription = allEventsObservable<Event>(target, [
  'mousedown',
  'mouseup',
  'click',
]).subscribe((event) => {
  console.log(event.type); // 'mousedown' | 'mouseup' | 'click'
});

// One call cleans up all three listeners
subscription.unsubscribe();
```

---

### `ForwardedEvent` and `forwardEvents()`

**`ForwardedEvent`**

**Signature:** `class ForwardedEvent<TOriginal extends Event = Event> extends Event`

A wrapper event that carries an original event under a new prefixed type string. `originalEvent` holds a reference to the unwrapped event.

```typescript
constructor(type: string, originalEvent: TOriginal)
readonly originalEvent: TOriginal
```

**`forwardEvents()`**

**Signature:**

```typescript
function forwardEvents(
  source: ForwardableSource,
  target: EventTarget,
  prefix: string,
  options?: { signal?: AbortSignal },
): { stop(): void };
```

Subscribes to every event on `source` (via `source.toObservable()`) and re-dispatches each one as a `ForwardedEvent` on `target` with the event type prefixed as `"${prefix}.${event.type}"`. Returns a handle with a `stop()` method to cancel forwarding.

`ForwardableSource`:

```typescript
interface ForwardableSource {
  toObservable(): ObservableLike<Event>;
}
```

`CompletableEventTarget` implements `ForwardableSource` via its `toObservable()` method, making it the natural source for this function.

```typescript
import { CompletableEventTarget, ForwardedEvent, forwardEvents } from 'lifecycle';

type ChildEvents = { data: MessageEvent; error: ErrorEvent };

const child = new CompletableEventTarget<ChildEvents>();
const hub = new EventTarget();

// hub will receive 'child.data' and 'child.error' events
const forwarding = forwardEvents(child, hub, 'child');

hub.addEventListener('child.data', (raw) => {
  const event = raw as ForwardedEvent<MessageEvent>;
  console.log('forwarded:', event.originalEvent.data);
});

child.dispatch(new MessageEvent('data', { data: 'hello' }) as MessageEvent & { type: 'data' });

// Stop forwarding
forwarding.stop();
```

---

### `HookRegistry`

**Signature:** `class HookRegistry<M extends HookMap>`

A priority-ordered registry for named async hooks. `M` maps hook names to their handler function signatures. Handlers registered with a higher `priority` number run first. When a handler returns a non-`undefined` value, that value replaces the first argument passed to all subsequent handlers—enabling a pipeline pattern where each hook can transform the input.

**Methods:**

- **`on(hookName, handler, options?)`**: Registers a handler. Returns an unsubscribe function.
- **`run(hookName, ...args)`**: Executes all handlers for the hook in priority order and returns the final transformed value (or `undefined` if no handler returned one).
- **`has(hookName)`**: Returns `true` if at least one handler is registered for the hook.
- **`clear(hookName?)`**: Removes all handlers for the named hook, or all handlers across every hook when called without arguments.
- **`getHandlers(hookName)`**: Returns registered handlers sorted by priority descending—used internally by `mergeHookRegistries`.
- **`getHookNames()`**: Returns all hook names that have at least one registered handler.

`HookRegistrationOptions`:

- **`priority`**: `number`—higher runs first (default `0`).
- **`onError`**: `HookErrorHandler`—called when the handler throws; return `'continue'` to skip to the next handler or `'abort'` to rethrow.
- **`replay`**: `HookReplayPolicy`—documentation-only classification (`'safe'` | `'effectful'`) for durable-recovery replay semantics; never gates execution at runtime.

`HookRegistryOptions`:

- **`onError`**: `HookErrorHandler`—registry-wide error fallback used when a handler's own `onError` is not set.

```typescript
import { HookRegistry } from 'lifecycle';

type BuildHooks = {
  'before-compile': (source: string) => string | undefined;
  'after-compile': (output: string) => void;
};

const hooks = new HookRegistry<BuildHooks>({
  onError: (error, { hookName }) => {
    console.warn(`Hook ${hookName} threw, continuing`, error);
    return 'continue';
  },
});

// Register handlers
const unsubscribe = hooks.on('before-compile', (source) => source.trim(), { priority: 10 });

hooks.on('before-compile', (source) => `/* generated */\n${source}`);

// Run the pipeline
const result = await hooks.run('before-compile', '  let x = 1;  ');
// result => '/* generated */\nlet x = 1;'

// Remove a specific handler
unsubscribe();

// Check and clear
console.log(hooks.has('before-compile')); // true (one handler remains)
hooks.clear('before-compile');
console.log(hooks.has('before-compile')); // false
```

---

### `mergeHookRegistries()`

**Signature:**

```typescript
function mergeHookRegistries<M extends HookMap>(
  ...registries: (HookRegistry<M> | undefined)[]
): HookRegistry<M>;
```

Combines multiple `HookRegistry` instances into a new registry. Registries listed earlier receive a higher priority offset (increments of 1000 per position), so handlers from the first registry run before those from later ones at equal declared priority. `undefined` entries are silently skipped, making it safe to spread optional hook sources.

```typescript
import { HookRegistry, mergeHookRegistries } from 'lifecycle';

type AppHooks = {
  'on-request': (url: string) => string | undefined;
};

const coreHooks = new HookRegistry<AppHooks>();
coreHooks.on('on-request', (url) => url.toLowerCase());

const pluginHooks = new HookRegistry<AppHooks>();
pluginHooks.on('on-request', (url) => `${url}?plugin=true`);

const optionalHooks: HookRegistry<AppHooks> | undefined = undefined;

const merged = mergeHookRegistries(coreHooks, pluginHooks, optionalHooks);

const result = await merged.run('on-request', 'https://Example.com/API');
// coreHooks handler runs first (higher offset): 'https://example.com/api'
// pluginHooks handler runs second: 'https://example.com/api?plugin=true'
console.log(result); // 'https://example.com/api?plugin=true'
```

---

## Supporting Types

These types are re-exported from the package root for use in consuming packages.

- **`EventMap`**: `Record<string, Event>`—the constraint for event-map type parameters.
- **`ObservableLike<T>`**: The `subscribe()` interface returned by `eventObservable()`, `allEventsObservable()`, `CompletableEventTarget#on()`, and `CompletableEventTarget#toObservable()`.
- **`Observer<T>`**: `{ start?, next?, error?, complete? }`—the observer object accepted by `ObservableLike#subscribe()`.
- **`Subscription`**: `{ unsubscribe(): void; readonly closed: boolean }`—the handle returned by `ObservableLike#subscribe()`.
- **`EventIteratorOptions`**: Options for `eventIterator()` (`signal`, `bufferSize`).
- **`EventObservableOptions`**: Options for `eventObservable()` and `allEventsObservable()` (`signal`).
- **`ForwardableSource`**: `{ toObservable(): ObservableLike<Event> }`—the interface required by `forwardEvents()`.
- **`HookMap`**: `Record<string, (...args: never[]) => unknown>`—the constraint for hook-map type parameters.
- **`HookErrorHandler`**: `(error: unknown, context: { hookName: string; handlerIndex: number }) => 'continue' | 'abort'`—the error handler type for hooks.
- **`HookRegistrationOptions`**: Per-handler options (`priority`, `onError`, `replay`).
- **`HookRegistryOptions`**: Registry-wide options (`onError`).
- **`HookReplayPolicy`**: `'safe' | 'effectful'`—metadata-only classification for durable-recovery replay documentation.

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
