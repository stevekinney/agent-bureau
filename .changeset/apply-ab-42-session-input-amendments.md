---
'@lostgradient/operative': minor
---

Applied AB-42's coordinator amendments (2026-09-02) to the session-input admission types exported from `@lostgradient/operative/durable`:

- `SessionInputRecord` and `SessionInputAdmissionRequest` now take `TPayload extends SessionInputPayload = SessionInputPayload` (a bounded generic) instead of an unbounded `TPayload = SessionInputPayload`. An explicit type argument can narrow the payload but can no longer widen it past the admissible union.
- `SessionInputPayload` narrows from `string | ReadonlyArray<MultiModalContent>` to `string | ReadonlyArray<UserAdmissibleContent>`, a new exported type that explicitly allowlists `TextContent` (with `citations` structurally forbidden via `citations?: never`, not merely omitted), `ImageContent`, and `DocumentContent` — not an `Exclude<>` blacklist, since `conversationalist` is consumed at a `^` semver range and a blacklist would silently admit any new content-block kind a future compatible release adds. Session input represents what a user submits; every excluded kind (`thinking`, `redacted_thinking`, `server_tool_use`, `web_search_tool_result`, the `ServerToolResultType` discriminants, `container_upload`, and response-only `citations` metadata) is rejected, discarded, or misattributed by provider adapters if replayed as user input.
- `SessionInputConflict.reason` gains `'id-owned-by-other-principal'` for the case where a different principal submits a session-input `id` that already exists in the session.

This narrows an unreleased-in-a-tagged-version export's public type — no published version of `@lostgradient/operative` has shipped the wider `SessionInputPayload` — but it is still a public type change against the types AB-193 exported, hence the minor bump. Type-only: no runtime behavior is added or changed by this release.
