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

Combining verdicts from multiple sources should always keep the **most
restrictive** one — `deny` beats `ask` beats `allow`. `combineApprovalStatuses`
is the primitive for that:

```typescript
import { combineApprovalStatuses } from 'armorer';

combineApprovalStatuses('allow', 'ask', 'deny'); // 'deny'
combineApprovalStatuses('allow', 'ask'); // 'ask'
combineApprovalStatuses('allow', 'allow'); // 'allow'
```

In `createToolbox`, this precedence is enforced by evaluation order:

1. The legacy boolean gates (`readOnly` / `allowMutation` / `allowDangerous`)
   run first. Any denial here is terminal — nothing downstream can be more
   restrictive than `deny`, so it's safe to short-circuit immediately.
2. The capability policy runs next. A `deny` is likewise terminal and
   short-circuits immediately. A capability `ask`, however, does **not**
   short-circuit — it's remembered, but registry- and tool-level
   `policy.beforeExecute` hooks still run.
3. The registry-level hook, then the tool-level hook, each run and can deny
   outright, regardless of what the capability policy decided.
4. Only if neither hook denies is the remembered capability `ask` returned.

Step 2 not short-circuiting on `ask` matters specifically for approval
resume: a capability `ask` pauses the call as a `needs_approval` action, and
the _same_ `beforeExecute` chain runs again once a human approves it. If an
`ask` had short-circuited past the registry/tool hooks on that first call,
approving the capability ask would silently skip whatever those hooks might
have denied — a human approving "this tool needs approval because it
mutates" would unknowingly also be approving past a registry policy that
would have denied the call outright. Running the hooks on every evaluation
(not just re-checking the remembered `ask`) closes that gap.

That ordering is what makes composition with persona/skill layers safe: a
persona's tool policy (see `operative`'s `createPolicyEnforcementHook`) can
make a dangerous tool _visible_ to the model by allow-listing its name, but
it can never make armorer _execute_ it — the capability tier's `deny` is
decided before any hook a persona or skill could influence ever runs, and
even a capability `ask` still routes through every other layer before it's
honored.

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
