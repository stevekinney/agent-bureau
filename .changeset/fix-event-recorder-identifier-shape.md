---
'@lostgradient/operative': patch
---

Fix `EventRecorder.normalize()`'s identifier-shape detection to recognize `ManualRuntimeServices`' now seed-prefixed identifiers (`${identifierPrefix}-${kind}-${n}`, Coordinator ruling on AB-337).

`IDENTIFIER_SHAPE`'s manual-runtime branch previously matched only `[a-z][a-zA-Z-]*-\d+` — letters and hyphens, no digits — so it recognized the old unprefixed `${kind}-${n}` shape but not the new prefixed one, since `identifierPrefix` is an alphanumeric base-36 string that may contain digits. Without this fix, `normalize()` would stop rewriting manual-runtime identifiers to their portable `identifier-N` positions, breaking every `causalTrace` comparison (including AB-267's reproduction-artifact replay) built against a `ManualRuntimeServices` constructed by this version of `lifecycle` or later.
