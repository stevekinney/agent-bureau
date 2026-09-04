---
'@lostgradient/operative': minor
---

Add `rejected`/`rejectionReason` to the durable signal continuation input (AB-46, AB-343).

`SignalContinuationInput` gains `readonly rejected: boolean` and `readonly rejectionReason?: string`, siblings to the existing `denied`/`denialReason` fields. A new `isRejectedSignalPayload` type guard narrows an `unknown` signal payload to the AB-46-ratified `human-wait` `reject` sentinel `{ __abRejected: true; reason: string }` — the sentinel bureau's `reject` verb (ab46-01) delivers on the signal channel — requiring `reason` to always be present, unlike the deny sentinel's optional `reason`.

`buildSignalContinuationInput` checks `isRejectedSignalPayload` ahead of `isDeniedSignalPayload` and sets `rejected: true`/`rejectionReason` from the sentinel. `renderSignalContinuation` renders a rejected input as `[signal:{signalName}] rejected: {rejectionReason}`, checked before the `denied` branch. An ordinary delivery or a `denied` payload renders exactly as before.
