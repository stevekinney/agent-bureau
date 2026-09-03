---
'armorer': minor
'@lostgradient/operative': patch
---

Expose real tool-callback completion from armorer's execution lifecycle so `closed()` cannot report `completed` early (AB-289).

Armorer's toolbox `settled` event (`ToolboxSettledEvent`, and the tool-level `ToolSettledEvent` it bubbles from) now carries a new optional `callbackCompletion: Promise<ExecutionSnapshot>` field. `settled` itself fires as soon as the cancellation race against the execution signal settles — a tool callback that ignores its abort signal keeps running after that. `callbackCompletion` is `ExecutionHandle.whenSettled()` for that call: it resolves only once the callback's own returned promise has genuinely settled or thrown, distinct from the event's own firing.

`@lostgradient/operative`'s `ActiveRun.closed()` (in-memory path) now awaits `callbackCompletion` for every run-owned in-flight tool call before reporting `{ status: 'completed' }`, instead of treating the early `settled` event alone as proof the callback was done. A caller holding a `closed({ signal })` bounded by its own deadline still observes `{ status: 'unresolved', reason: 'timed-out' }` if that deadline elapses before the callback returns.
