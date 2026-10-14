---
'@lostgradient/tool-protocol': patch
---

Bound async tool-result materialization by cancellation: an already-aborted signal rejects immediately with its reason, and an abandoned iterator is asked to close in the background, so a `return()` that never settles no longer holds an aborted materialization open and one that rejects no longer surfaces as an unhandled rejection.
