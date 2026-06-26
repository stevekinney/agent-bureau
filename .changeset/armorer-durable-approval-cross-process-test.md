---
"armorer": patch
---

Add regression test for durable cross-process approval round-trip: serializes a signed pending-approval descriptor to JSON, deserializes it in a fresh toolbox instance (simulating a separate process), and verifies the resume executes correctly with re-validation.
