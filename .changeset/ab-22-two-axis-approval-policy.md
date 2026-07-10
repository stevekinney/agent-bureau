---
'armorer': minor
---

Add a two-axis approval policy (AB-22): capability tier (`read-only` / `mutating` / `dangerous`, derived from existing tool metadata and OpenAPI verb-derived metadata without modification) x approval mode (`never` / `on-mutation` / `always` / `deny`), evaluated with `deny > ask > allow` precedence via `combineApprovalStatuses` and escalating unrecognized tools to `ask` under every mode. New `createToolbox({ approvalPolicy })` option and exports (`createApprovalPolicyHooks`, `evaluateCapabilityApproval`, `resolveCapabilityTier`, `resolveApprovalMode`, `evaluateApprovalStatus`, `combineApprovalStatuses`, `approvalStatusToDecision`). Runs before any registry- or tool-level `policy.beforeExecute` hook, so persona/skill tool policies (`operative`'s `createPolicyEnforcementHook`) can only narrow it, never bypass it. `ask` verdicts surface as the existing `needs_approval` status, so `PendingToolApproval`/`resumeApproval` and `bureau`'s review queue need no changes.
