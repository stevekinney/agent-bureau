# Sentinel

`sentinel` is the run-state store for Agent Bureau. It tracks active and completed runs, records ordered actions, emits store events, and exposes snapshots that operational surfaces can render or inspect.

## What It Does

- Creates a store with `createStore()`.
- Tracks run state by run identifier and status.
- Records ordered actions for run lifecycle, generation, tool execution, errors, and cleanup.
- Emits typed events when runs are registered, removed, or updated by an action.
- Exposes snapshots for dashboards, tests, and live transports.

## How It Works

The store follows a reducer-style model: callers dispatch actions, the store updates the canonical `StoreState`, and subscribers receive typed events. Runs and actions are kept separate so consumers can read the latest state quickly while still retaining an ordered history of what happened.

`gateway` uses those events to publish live frames and render run state. Tests can also use the store directly to assert the sequence of runtime behavior without depending on browser or HTTP surfaces.

## Project Role

`operative` emits runtime events, but `sentinel` turns those events into queryable state. It is the bridge between agent execution and observability surfaces such as the gateway dashboard, run detail pages, and API responses.

## Public Entry Points

- `createStore()`
- Store event classes: `RunRegisteredEvent`, `RunRemovedEvent`, and `StoreActionEvent`
- Store types such as `Store`, `StoreState`, `RunState`, `RunStatus`, `Action`, and `StoreOptions`

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
