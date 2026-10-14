---
'@lostgradient/lifecycle': patch
---

`createManualRuntimeServices` throws a `RangeError` at construction when its `clockOrigin` is not a parsable ISO-8601 timestamp, instead of admitting `NaN` into the virtual wall clock.
