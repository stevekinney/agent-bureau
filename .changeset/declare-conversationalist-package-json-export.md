---
'conversationalist': minor
---

Declare `./package.json` as a reachable export subpath, so a consumer can read package metadata
(for example the published version, for a compatibility check) without an unexported deep import
that `exports`-map enforcement would otherwise reject.
