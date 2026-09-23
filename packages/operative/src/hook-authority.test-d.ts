// Type-level fixture for COR-1269 criterion 8 — no hook context is a channel
// for widening a child's delegated authority. Checked by `tsc --noEmit` only;
// it is not a runtime Bun test (see the convention note in
// create-agent.test-d.ts).

import type { OperativeHookMap } from './hooks';

/**
 * `OperativeHookMap`'s own declared keys, without the index signature it
 * inherits from `HookMap` (`Record<string, (...args: never[]) => unknown>`).
 *
 * Load-bearing, not tidiness. `keyof OperativeHookMap` is `string | number`
 * because of that index signature, so a mapped type over it resolves to the
 * signature's own value type and every `Parameters<…>` below collapses to
 * `never` — which makes any assertion built on it pass for every map, whatever
 * the contexts declare. The first version of this fixture had exactly that bug
 * and was caught by the control below.
 */
type DeclaredHookNames = keyof {
  [
    K in keyof OperativeHookMap as string extends K ? never : number extends K ? never : K
  ]: OperativeHookMap[K];
};

/** Every parameter every declared hook receives. */
type HookParameters = {
  [K in DeclaredHookNames]: Parameters<OperativeHookMap[K]>[number];
}[DeclaredHookNames];

/**
 * `never` when no hook parameter declares `delegatedAuthority` at all, and the
 * offending context types otherwise — including a readonly one, which is
 * deliberate: a context that exposes the grant at all is worth re-deciding, not
 * only one that exposes it mutably.
 *
 * `attenuateDelegatedAuthority` composes a child's grant from the parent's and
 * the dispatching tool's own narrowing, independently of any hook. That holds
 * only while no hook is handed something carrying the grant, so the absence is
 * asserted here rather than left as a property nobody rechecks when a context
 * gains a field.
 */
type DeclaresDelegatedAuthority = Extract<HookParameters, { delegatedAuthority: unknown }>;

// Assigned TO `never`, not FROM it. The reverse compiles for any type at all,
// because `never` is assignable to everything.
//
// Control, run rather than assumed: pointing the `Extract` at `{ step: unknown }`
// — a property `StepContext` really does declare — makes this line fail, and
// pointing it back makes it pass. Both halves were checked; without the first,
// a green here means nothing.
declare const declared: DeclaresDelegatedAuthority;
const noHookContextCarriesTheGrant: never = declared;
void noHookContextCarriesTheGrant;
