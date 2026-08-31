---
'armorer': patch
'@lostgradient/operative': patch
---

Document that `createTopicBoundaryDetector`'s `allowedTopics`/`blockedKeywords` matching is literal, case-insensitive substring matching, not semantic — a paraphrased, on-topic input that never uses the literal keyword is flagged as off-topic. No behavior change.
