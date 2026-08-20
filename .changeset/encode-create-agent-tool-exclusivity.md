---
'@lostgradient/operative': minor
---

`createAgent`'s standalone `CreateAgentOptions` now encodes `tools`/`toolbox`/`permissions` exclusivity at the type level: `tools` + `toolbox`, `toolbox` + `permissions`, and all three together are now compile-time errors, matching the existing runtime guard. `tools`, `permissions`, `tools` + `permissions`, and `toolbox` alone remain valid, as does passing no tool configuration.
