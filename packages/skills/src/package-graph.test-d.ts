// E3 — Confirm skills stays a package (type-level assertions)
//
// This file proves at the type level that:
//   1. SkillProvider (from this package) is a SUPERSET of the SkillProviderLike
//      seam the bureau builder accepts via `.skills(provider)`. Bureau can
//      consume a SkillProvider without importing from the skills package.
//   2. ToolPolicy (from this package) is structurally identical to the
//      ToolPolicyLike interface operative uses — confirming E4's extraction
//      (moving ToolPolicy to a shared package) will work cleanly.
//
// These checks are compile-time only. If SkillProvider drops a method the
// bureau seam requires, or if ToolPolicy diverges from ToolPolicyLike, this
// file will produce a type error during `bun run check-types`.
//
// The seam interfaces are inlined here (not imported from operative/bureau-types)
// to preserve the dependency direction: skills must NOT import from operative.

import type { SkillProvider, ToolPolicy } from './types';

// ── SkillProviderLike — the seam interface bureau uses ────────────────────────
//
// Copied from operative/src/bureau-types.ts (SkillProviderLike).
// Skills must NOT import from operative. This inline copy proves structural
// compatibility without creating a forbidden dependency.
//
// If operative's SkillProviderLike changes, both files must update — this is
// intentional: the seam is the contract, and both sides own it.

type SkillProviderLike = {
  listSkills(): Promise<Array<{ name: string; description: string }>>;
  isEnabled(name: string): Promise<boolean>;
};

// Structural proof: every SkillProvider is a valid SkillProviderLike.
// This assertion fails if SkillProvider removes listSkills() or isEnabled().
type SkillProviderSatisfiesLike = SkillProvider extends SkillProviderLike ? true : false;
declare const _providerCheck: SkillProviderSatisfiesLike;
void (_providerCheck satisfies true);

// ── ToolPolicyLike — the seam interface operative uses ────────────────────────
//
// Copied from operative/src/create-policy-enforcement-hook.ts (ToolPolicyLike).
// Same rationale: skills must NOT import from operative.

type ToolPolicyLike = {
  allowList?: string[];
  denyList?: string[];
};

// Bidirectional structural proof: ToolPolicy === ToolPolicyLike.
// skills' ToolPolicy must extend ToolPolicyLike AND ToolPolicyLike must extend
// ToolPolicy — they are structurally identical, so E4's extraction into a shared
// package is a safe rename with no semantic change.
type ToolPolicyExtendsLike = ToolPolicy extends ToolPolicyLike ? true : false;
type ToolPolicyLikeExtendsPolicy = ToolPolicyLike extends ToolPolicy ? true : false;

declare const _toolPolicyForward: ToolPolicyExtendsLike;
void (_toolPolicyForward satisfies true);

declare const _toolPolicyReverse: ToolPolicyLikeExtendsPolicy;
void (_toolPolicyReverse satisfies true);
