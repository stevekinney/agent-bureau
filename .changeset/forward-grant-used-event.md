---
'@lostgradient/operative': minor
---

Forward armorer's new `grant.used` toolbox event (AB-46, AB-346's reusable-approval-grant matching) as `toolbox.grant.used` through `CombinedOperativeEventType`/`CombinedOperativeEventClassMap` and `COMBINED_OPERATIVE_EVENT_TYPES`, alongside every other `toolbox.*` forwarded event. This is a mechanical, collateral update: armorer's `ToolboxEvents` gained the new key, and operative's hand-maintained `TOOLBOX_EVENT_KEYS` exhaustiveness list (there is no runtime key array to import from armorer) needed the matching entry to keep compiling.
