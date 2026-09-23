import type { ToolPolicy } from '@lostgradient/tool-protocol';

import type { SkillAdmissionRule } from './events';

/**
 * Whether a deployment permits a caller to activate a named skill.
 *
 * Distinct from the catalog's own trust and availability decisions, and deliberately not folded
 * into them. Availability answers "can this artifact be admitted at all" and is a property of the
 * skill; admission answers "is this caller permitted to activate it" and is a property of the
 * deployment. A skill can be perfectly trustworthy and still refused here, and collapsing the two
 * would lose that distinction along with the host's ability to say which rule fired.
 *
 * The members are skill names rather than tool names, even though the shape is `ToolPolicy`.
 * COR-752's Decision 3 calls for a skill-scoped type; that rename is its own boundary.
 */
export type SkillAdmissionPolicy = ToolPolicy;

/**
 * Which admission rule refuses this skill, or `undefined` when the policy admits it.
 *
 * Deny wins over allow: a name on both lists is refused, because the deny list is the more
 * restrictive statement and a policy that admitted it would be honouring the weaker half of its
 * own configuration.
 */
export function refusedByAdmissionPolicy(
  name: string,
  policy: SkillAdmissionPolicy | undefined,
): SkillAdmissionRule | undefined {
  if (policy === undefined) return undefined;
  if (policy.denyList?.includes(name) === true) return 'deny-list';
  if (policy.allowList !== undefined && !policy.allowList.includes(name)) return 'allow-list';
  return undefined;
}
