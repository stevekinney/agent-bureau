---
'@lostgradient/operative': minor
---

Adds the five-layer model policy precedence composition (AB-64, implemented by AB-248).

`packages/operative/src/providers/policy.ts` is new and exports `DeploymentInvariants`, `BureauInvariants`, `DelegatedAuthority`, `UserModelConfiguration`, `SelectionExclusionCode`, `PolicyCandidate`, `ComposePolicyInput`, and `composePolicy(input)`. `composePolicy` is a pure, synchronous function of `{ descriptors, deployment, bureau, agent, delegated, user }` that composes five precedence layers — deployment invariants, Bureau invariants, Agent requirements and preferences (`AgentPreferences`, imported from `generation-profile.ts` rather than redefined), delegated authority (AB-52's not-yet-decided grant, consumed as an opaque narrowing input), and user constraints and preferences — top to bottom, where each layer's candidate set is the intersection of its rules with what the layer above allowed.

It returns a frozen array of `{ provider, model, route?, descriptor, eligible, exclusionCode?, exclusionReason? }` entries, one per input descriptor, in input order, never dropping a candidate silently. The first layer to exclude a candidate owns the exclusion code; a later layer never overwrites it, and `BureauInvariants` can add denials but can never remove a deployment denial. `AgentPreferences` expresses needs and preferences only — a missing `requiredCapabilities` entry or a `minimumContextWindowTokens` shortfall excludes with `missing-required-capability`, while `preferredProviders`/`preferredModels` exclude nothing. `DelegatedAuthority` narrows by omission (`grantedProviders`/`grantedModels` absent narrows nothing, present-and-not-naming excludes with `exceeds-delegated-authority`, `policyVersion` traceable in the exclusion reason) and `maximumEffort` above the candidate's supported tier excludes the same way. `UserModelConfiguration`'s allow/deny lists exclude with `denied-by-user`. A descriptor with `availability: 'unavailable'` excludes with `unavailable`; `health: 'unhealthy'` excludes with `unhealthy`.

`exactOverride` is checked only against the four layers above the user's before being honored: a rejected override yields a single-candidate result carrying the denying layer's own exclusion code, never `denied-by-user`; an override naming no matching descriptor yields an empty result.

Pure, side-effect-free, and deterministic: the same input object graph always produces a structurally equal result. No `any` and no `as unknown as`.
