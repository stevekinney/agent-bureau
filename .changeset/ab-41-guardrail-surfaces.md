---
"armorer": minor
---

Add a shared guardrail detector pipeline: `runDetectorPipeline` and the confidence-gate wrapper `scanContent`, plus the built-in `createPromptInjectionDetector`, `createTopicBoundaryDetector`, and `createInputLengthDetector` (moved from `operative`, same behavior). `DetectorContext` and `GuardrailTriggeredEvent` now carry a `provenance` tag (`'user-input' | 'recalled-memory' | 'ingested-document' | 'skill-resource'`), so the same pipeline can scan retrieved content — not just user input — while recording where it came from. `operative`'s guardrails re-export these from `armorer` so existing imports keep working.
