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

`lifecycle` is the shared substrate for observability and extension. `conversationalist`, `armorer`, `operative`, `sentinel`, and `gateway` all rely on event streams or hooks, and this package keeps those mechanics consistent across the workspace.

## Public Entry Points

- `TypedEventTarget`
- `CompletableEventTarget`
- `eventIterator()`
- `eventObservable()` and `allEventsObservable()`
- `ForwardedEvent` and `forwardEvents()`
- `HookRegistry` and `mergeHookRegistries()`

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
