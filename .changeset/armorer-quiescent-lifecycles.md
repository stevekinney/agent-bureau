---
'armorer': patch
---

Keep tool execution lifecycles accurate through completion and shutdown.

- Cleanup lifecycles stay quiescent before shutdown, and a `failFast` batch parent finalizes when a sibling callback settles after the batch has already rejected.
- Progress reporting stays live while a streamed async-iterable tool result is consumed, whether collected or live, and deactivates when a tool executor throws synchronously. Toolbox progress events carry the tool's checkpoint.
- Toolbox execution accepts `AbortSignal` values from another realm.
