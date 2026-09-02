---
'@lostgradient/operative': minor
---

Applied AB-42's coordinator amendments (2026-09-02) to the session-input admission types exported from `@lostgradient/operative/durable`:

- `SessionInputRecord` and `SessionInputAdmissionRequest` now take `TPayload extends SessionInputPayload = SessionInputPayload` (a bounded generic) instead of an unbounded `TPayload = SessionInputPayload`. An explicit type argument can narrow the payload but can no longer widen it past the admissible union.
- `SessionInputPayload` narrows from `string | ReadonlyArray<MultiModalContent>` to `string | ReadonlyArray<UserAdmissibleContent>`, a new exported type excluding every content-block kind a provider adapter cannot safely round-trip as request content (`thinking`, `redacted_thinking`, `server_tool_use`, `web_search_tool_result`, the `ServerToolResultType` discriminants, and `container_upload` — response-only in the Anthropic adapter and silently dropped by the OpenAI/Gemini adapters). Session input represents what a user submits; these kinds are rejected, discarded, or misattributed by provider adapters if replayed as user input.
- `SessionInputConflict.reason` gains `'id-owned-by-other-principal'` for the case where a different principal submits a session-input `id` that already exists in the session.

This narrows an unreleased-in-a-tagged-version export's public type — no published version of `@lostgradient/operative` has shipped the wider `SessionInputPayload` — but it is still a public type change against the types AB-193 exported, hence the minor bump. Type-only: no runtime behavior is added or changed by this release.
