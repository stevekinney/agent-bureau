---
"armorer": patch
---

Add regression test for OpenTelemetry parent context injection: with a single tracer it pins both halves of the contract — a call with no parentContext forwards `undefined` to `startSpan` (so the OTel SDK applies its own ambient/root context) while a sibling call with a sentinel parentContext forwards that exact value by identity, proving the `undefined` path is a genuine "no parent" decision rather than a shallow default.
