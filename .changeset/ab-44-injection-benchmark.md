---
"armorer": minor
---

Export `withMinimumTripwireConfidence` from the guardrails module — a detector wrapper that suppresses a `triggered: true` result below a given confidence threshold. Previously duplicated as a private helper inside `bureau`'s default guardrail preset; now a single shared implementation, reusable for tuning any `InputDetector` before wiring it into `mode: 'tripwire'`.
