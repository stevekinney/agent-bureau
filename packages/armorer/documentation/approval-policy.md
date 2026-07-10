# Approval Policy: Two Axes, Not One

Two questions are easy to conflate and shouldn't be:

1. **Capability tier** — what a tool may technically do. Read-only, mutating,
   or dangerous. This is a fact about the tool, derived from its metadata.
2. **Approval mode** — when a human must be asked before that tool runs.
   Never, only on mutation, always, or outright denied. This is a policy
   decision, independent of the tool.

Bolting these together (`allowDangerous: boolean`, `readOnly: boolean`)
collapses two orthogonal questions into one flag per tier, which can't
express "ask before running mutating tools" without also expressing "never
ask about read-only tools" as a separate, uncoordinated setting. The
`approvalPolicy` toolbox option keeps them separate and composes them
explicitly.

## The model

```typescript
import { createToolbox } from 'armorer';

const toolbox = createToolbox(tools, {
  approvalPolicy: {
    // Fallback mode for any tier without an explicit override.
    mode: 'on-mutation',
    // Per-tier overrides.
    tierModes: {
      'read-only': 'never', // never ask
      mutating: 'on-mutation', // ask (on-mutation asks for anything not read-only)
      dangerous: 'deny', // never allowed, full stop
    },
  },
});
```

- **`CapabilityTier`** — `'read-only' | 'mutating' | 'dangerous'`. Resolved
  from a tool's `metadata.readOnly` / `metadata.mutates` / `metadata.dangerous`
  flags (falling back to `dangerous` / `mutating` / `readonly` risk tags).
  This is exactly the metadata armorer's coding toolbox (`read-file`, `grep`,
  `glob`) and the OpenAPI integration's verb-derived metadata (`GET` →
  read-only, `POST`/`PUT` → mutating, `DELETE` → dangerous) already emit — no
  changes were needed to either to feed this axis.
- **`ApprovalMode`** — `'never' | 'on-mutation' | 'always' | 'deny'`. `never`
  allows the tier outright. `always` asks every time. `on-mutation` allows
  `read-only` and asks for anything at or above `mutating`. `deny` blocks the
  tier regardless of anything else.
- **`ApprovalStatus`** — the three-way verdict a check produces:
  `'allow' | 'ask' | 'deny'`.

## Precedence: deny > ask > allow

When multiple policy layers weigh in on the same tool call — the capability
policy, a registry-level `policy.beforeExecute` hook, a tool-level
`policy.beforeExecute` hook, a persona or skill tool policy — the combined
verdict is always the **most restrictive** one. `combineApprovalStatuses`
implements this:

```typescript
import { combineApprovalStatuses } from 'armorer';

combineApprovalStatuses('allow', 'ask', 'deny'); // 'deny'
combineApprovalStatuses('allow', 'ask'); // 'ask'
combineApprovalStatuses('allow', 'allow'); // 'allow'
```

In `createToolbox`, the capability policy runs **before** any registry- or
tool-level `policy.beforeExecute` hook, and before persona/skill tool
filtering ever gets a chance to matter. That ordering is what makes
composition safe: a persona's tool policy (see `operative`'s
`createPolicyEnforcementHook`) can make a dangerous tool _visible_ to the
model by allow-listing its name, but it can never make armorer _execute_ it —
the capability tier's `deny` was already decided first.

## Unrecognized tools escalate to `ask`, never to `allow`

A tool armorer can't classify — no `readOnly`/`mutates`/`dangerous` metadata
and no matching risk tag — is never silently treated as safe. Under every
approval mode, including `never`, an unclassified tool escalates to `ask`:

```typescript
import { evaluateApprovalStatus } from 'armorer';

evaluateApprovalStatus(undefined, 'never'); // 'ask' — not 'allow'
evaluateApprovalStatus('read-only', 'never'); // 'allow'
```

The rationale: `mode: 'never'` is a statement about tools whose tier you've
already reasoned about. A tool with no declared tier hasn't been reasoned
about at all, so the safe default is to ask, not to assume it's read-only.

## Interop with `needs_approval`

`ask` verdicts surface as `ToolPolicyDecision.status: 'needs_approval'`, the
same status armorer's tool-level `policy.beforeExecute` hooks have always
been able to return. That means the existing `PendingToolApproval` /
`Toolbox.resumeApproval` flow — and `bureau`'s review-queue integration on
top of it — needs no changes to handle capability-tier approvals; they flow
through the same mechanism as any other `needs_approval` decision.

## Relationship to `readOnly` / `allowMutation` / `allowDangerous`

The boolean toggles (`readOnly`, `allowMutation`, `allowDangerous`) remain
available as a simpler shorthand for the deny-only case — they can't express
`ask`. When both `approvalPolicy` and the boolean toggles are configured on
the same toolbox, the most restrictive of the two verdicts wins, consistent
with the deny > ask > allow precedence rule above.

## No bundled sandbox

The `dangerous` tier is a **contract**, not an execution guarantee: armorer
records that a tool may do something dangerous and lets policy gate whether
it runs. It does not bundle a sandbox executor to contain what a `dangerous`
tool actually does at runtime — that's a deliberate scope boundary (see
AB-42), left to the host environment.
