---
'@lostgradient/operative': minor
---

Applied AB-67's coordinator amendments (2026-09-02) to the runtime steering types exported from `@lostgradient/operative/durable`:

- `SteeringCommandFailure` gains `readonly supersededBy?: string`, the `id` of the successor command, present exactly when `reason` is `'superseded-by'`.
- Every `SteeringRequestedValue` variant is encoded as an exclusive `policyRef`/`override` pair — `{ target: T; policyRef: string; override?: never } | { target: T; override: V; policyRef?: never }` — instead of two same-discriminant variants, so a literal supplying both fields, or neither, is rejected by the type checker. The runtime admission check that exactly one is present stays as defense in depth.
- `SteeringCommand` gains `readonly runId?: string`, binding a `pause`/`resume` command to a session's non-terminal run; `SteeringCommandFailure.reason` gains `'run-ambiguous'` for when `runId` is absent and the session has zero or more than one non-terminal run.

This narrows and extends an unreleased-in-a-tagged-version export's public type — no published version of `@lostgradient/operative` has shipped the wider `SteeringRequestedValue` shape — but it is still a public type change against the types AB-197 exported, hence the minor bump. Type-only: no runtime behavior is added or changed by this release.
