---
"@lostgradient/armorer": patch
---

Add regression test for OpenTelemetry parent context injection: asserts tool spans are created as root spans (no context argument) when no parentContext is supplied to toolbox.execute(), confirming the OTel SDK can use its own ambient context.
