---
'armorer': minor
---

Make `ToolPolicyDecision.allow` optional when `status` is present (fixes #226). A policy hook can now return `{ status: 'needs_approval', reason: '…' }` — the shape the README's Approval Flows example has always shown — and the effective `allow` is derived from the status (`'allow'` → `true`; `'deny'`, `'needs_approval'`, `'needs_input'` → `false`). Decisions that set `allow` explicitly behave exactly as before. The normalizer is exported as `resolveToolPolicyAllow` alongside the new `ResolvedToolPolicyDecision` type.
