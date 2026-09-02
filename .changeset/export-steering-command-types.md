---
'@lostgradient/operative': minor
---

Exported the AB-67 runtime steering contract's type-only surface: `SteeringCommand`, `SteeringTargetKind`, `SteeringRequestedValue`, `SteeringCommandState`, `SteeringCommandFailure`, `SteeringDesiredState`, and `SteeringEffectiveState` (from `@lostgradient/operative/durable`), alongside AB-42's session-input types. No runtime behavior is attached — `submitSteeringCommand`, the `runStep` boundary read, and `GenerateContext` threading are implemented by later issues.
