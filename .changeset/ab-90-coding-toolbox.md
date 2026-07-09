---
"armorer": minor
---

Add a first-party read-only coding toolbox at the `armorer/coding` subpath: `read-file`, `grep`, and `glob`, all constrained to a caller-supplied root directory via `createRootJail`.

`createRootJail(root)` resolves every requested path against a canonicalized root and rejects absolute paths, `..` traversal, and symlinks (at any path segment, including the leaf) that dereference outside the root, throwing a typed `PathTraversalError`.

- `createReadFileTool` supports `offset`/`limit` line windows and caps the underlying read at `maxBytes` (default 256 KiB).
- `createGrepTool` runs an in-process regular expression (no `child_process`) against files enumerated by `Bun.Glob`, with an optional `glob` scope filter and a `maxMatches` cap.
- `createGlobTool` accepts repository-relative glob patterns only and caps results at `maxResults`.

All three report an explicit `truncated: boolean` marker and carry `metadata: { readOnly: true, mutates: false, dangerous: false }`. `createCodingTools`/`createCodingToolbox` bundle all three under a shared jail. This is a read-only surface — write, edit, and shell tools are intentionally out of scope pending the AB-42 sandbox decision.
