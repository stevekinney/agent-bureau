---
'armorer': minor
---

Add the reusable-approval-grant type and `GrantStateStore` to `packages/armorer/src/approval-binding.ts` (AB-46, implemented by AB-345).

`ReusableApprovalGrant` (`GRANT_VERSION` currently `1`) carries every field AB-46's decision record names: `principalId`, `tenantId`, `ownerId`, `agentId`, `toolName`, optional `resourcePattern` and `argumentConstraints`, `scope` (`'run' | 'session' | 'principal'`), `issuedAt`, `expiresAt`, `maxUses`, `usesRemaining`, `policyRevision`, `revoked`, `delegationBehavior` (`'inherits-to-children' | 'does-not-propagate'`), and `signature`.

`GrantStateStore` is a new interface parallel to `ApprovalStateStore`, adding `issue`, `revoke`, `get`, `list`, and `decrementUse(id): Promise<{ usesRemaining: number }>`; `createProcessLocalGrantStateStore()` ships as the default in-memory implementation. `issue` always initializes `usesRemaining` to `maxUses`; `decrementUse` is the only method that mutates `usesRemaining`, floored at `0`; `revoke` sets `revoked: true` idempotently, including for an unknown or already-revoked id.

`signGrant`/`verifyGrantSignature` sign and verify a grant's canonical fields (every field but `signature`) using the same HMAC primitive `signPendingApproval` uses internally; `verifyGrantSignature` throws a new `GrantError` (`code: 'invalid-signature'`) when a grant's signature no longer matches its current field values, and `GrantStateStore.decrementUse` throws `GrantError` (`code: 'not-found'`) for an unknown grant id.

Grant matching inside `mergePolicies`'s `beforeExecute`, and Bureau-layer grant CRUD wiring, are out of scope for this change (AB-346).
