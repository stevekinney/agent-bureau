---
'armorer': patch
---

Enforce `ReusableApprovalGrant.scope` in grant matching (AB-364, AB-46, AB-346).

`ReusableApprovalGrant` gains optional `runId`/`sessionId` fields. `findMatchingGrant` now compares them against the request context's run and session identity: a `run`-scoped grant matches only calls from the exact run it names, a `session`-scoped grant matches any run of the session it names, and a `principal`-scoped grant matches as before. A `run`/`session` grant missing its own scoping identifier never matches — it is never an implicit approve. `Toolbox.issueGrant` rejects a `run` scope without `runId` and a `session` scope without `sessionId` with a `GrantError` (code `'invalid-scope'`).

Also fixes a latent defect this change surfaced: `signGrant`/`verifyGrantSignature` previously signed `usesRemaining`, so `decrementUse` (which has no access to the signing secret) silently invalidated a grant's signature on its very first use, making any `maxUses > 1` grant unusable a second time. `usesRemaining` is now excluded from the signed payload alongside `signature`; `maxUses` (the issuance-time ceiling) stays signed.

New public fields: `ReusableApprovalGrant.runId`, `ReusableApprovalGrant.sessionId`, `GrantError.code`'s `'invalid-scope'` member.
