---
'@lostgradient/operative': minor
---

Track and await scheduler, chunked-task, and heartbeat callback promises (AB-208), closing the last unowned-background-work gap from the AB-37 cancellation-and-shutdown decision record.

`Scheduler.stop()` now tracks every `onComplete`/`onPreempted` callback promise a task returns and awaits it in the same `Promise.allSettled` pass it already runs for durable cancellations, instead of firing the callback with `void`. A stopped scheduler is therefore a real boundary for anything the callback closes over (credential-scoped `services`, for example) rather than a best-effort signal. A callback rejection that lands after the owner stopped no longer becomes an unhandled promise rejection: it is captured and reported as its own `task.failed` event.

`createChunkedTask`'s `onComplete`/`onError` callbacks are likewise awaited — before `submitChunkedWork`'s own returned promise resolves on the success path, and before it rejects on the failure path — instead of being fired with `void`.

`createHeartbeat(...).stop()` changes from `stop(): void` to `stop(): Promise<void>` (a breaking type change on this one method) — it now resolves only after the in-flight `tick()`, and its tracked `onTick` callback promise, settle. Calling `stop()` when nothing is in flight (never started, or already stopped) is a no-op that resolves promptly.

`Bureau.dispose()`/`Bureau.shutdown()` awaiting `scheduler.stop()` or `heartbeat.stop()` is a separate, already-tracked follow-up (AB-38's `can-03` slice) — out of scope here.
