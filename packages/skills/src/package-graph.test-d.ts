// E3 — Confirm skills stays a package (type-level assertions)
//
// This file proves at the type level that:
//   ToolPolicy (from this package) is structurally identical to the
//   ToolPolicyLike interface operative uses — confirming E4's extraction
//   (moving ToolPolicy to a shared package) will work cleanly.
//
// The `SkillProvider`/`SkillProviderLike` proof that used to sit here went with
// the seam it described: Bureau no longer consumes a provider, so there is no
// structural contract left for it to satisfy. COR-892 replaced that seam with a
// catalog revision, which Bureau imports as a type rather than duck-types.
//
// These checks are compile-time only. If ToolPolicy diverges from ToolPolicyLike,
// this file will produce a type error during typechecking.
//
// The seam interfaces are inlined here (not imported from operative) to
// preserve the dependency direction: skills must NOT import from operative.

import type { ToolPolicy } from './types';

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

declare const toolPolicyForward: ToolPolicyExtendsLike;
void (toolPolicyForward satisfies true);

declare const toolPolicyReverse: ToolPolicyLikeExtendsPolicy;
void (toolPolicyReverse satisfies true);
