---
'@lostgradient/operative': minor
---

Export `SessionInputDeliveryMode`, `SessionInputPayload`, `SessionInputRecord`, `SessionInputAdmissionRequest`, `SessionInputReceipt`, `SessionInputConflict`, `SessionInputAdmissionOutcome`, `SessionInputState`, `SessionInputPromotion`, and `SessionInputFailure` from `@lostgradient/operative/durable`.

These are the request, receipt, and state-transition shapes AB-42's ratified decision record fixes for session-input admission (`submitSessionInput`, illustratively named) — a fourth Bureau session verb alongside `signalSession`, `updateSession`, and `querySession`. This is a type-only addition with no runtime behavior: no `submitSessionInput` implementation ships in this release, and `SessionInputSnapshot` is not exported here (AB-88 owns building it).

`documentation/operative-type-safe-api.md` gains a new "Session input admission" section carrying AB-42's type sketches and contract decisions verbatim, plus the four amendments AB-42's decision record specifies: the "AB-42 is the first exception" paragraph after the idempotency-key discussion, the updated _Not decided_ idempotency-key paragraph, a new classification-table row for session input, and the widened Session-row scope for AB-50's child discovery.
