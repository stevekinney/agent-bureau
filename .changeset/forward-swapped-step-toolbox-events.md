---
'@lostgradient/operative': minor
---

Fixed a bug (AB-239, a Codex finding from AB-231's review) where a `selectTools` hook that swapped in a different toolbox for one step silently dropped that step's `toolbox.*` events — `call`, `complete`, `budget-exceeded`, and `loop-blocked`'s companion `error` never reached the run's emitter, because both drivers (`create-run.ts`'s in-memory loop and `durable/active-run-adapter.ts`'s fresh-start, recovered, and reattached durable paths) subscribed once to the run's original toolbox and never re-subscribed to a swapped step toolbox.

The forwarder now additionally subscribes to whichever toolbox a step actually resolves to (`options.toolbox`, or a `selectTools` replacement) at step start, and tears that subscription down again at step end — with no duplicate delivery when a step's resolved toolbox is the original instance.
