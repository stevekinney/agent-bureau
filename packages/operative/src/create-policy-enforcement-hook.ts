/**
 * Structural interface compatible with ToolPolicy from the skills package.
 * Defined here to avoid a dependency from operative to skills.
 */
export interface ToolPolicyLike {
  allowList?: string[];
  denyList?: string[];
}

export interface ToolLike {
  name: string;
}

export interface CreatePolicyEnforcementHookOptions {
  /** Persona tool policy (static for the run). */
  personaToolPolicy?: ToolPolicyLike;
  /** Returns the currently active skill's tool policy (dynamic, changes during run). */
  getActiveSkillToolPolicy?: () => ToolPolicyLike | undefined;
}

/**
 * Applies a single tool policy to a tool array.
 *
 * Allow list restricts to only named tools. Deny list excludes named tools.
 * When both are present, deny list wins — a tool present in both lists is excluded.
 */
function applyPolicy<T extends ToolLike>(tools: T[], policy: ToolPolicyLike | undefined): T[] {
  if (!policy) return tools;

  const { allowList, denyList } = policy;
  let filtered = tools;

  if (allowList) {
    filtered = filtered.filter((tool) => allowList.includes(tool.name));
  }

  if (denyList) {
    filtered = filtered.filter((tool) => !denyList.includes(tool.name));
  }

  return filtered;
}

/**
 * Creates a tool-filtering function that enforces persona and active skill tool policies.
 *
 * The effective tool set is: `tools intersection persona.toolPolicy intersection skill.toolPolicy`.
 * Deny lists always win over allow lists within each policy layer.
 *
 * The returned function is generic — it preserves the concrete tool type of the input array,
 * requiring only that each element has a `name: string` property.
 */
export function createPolicyEnforcementHook(
  options: CreatePolicyEnforcementHookOptions,
): <T extends ToolLike>(tools: T[]) => T[] {
  const { personaToolPolicy, getActiveSkillToolPolicy } = options;

  return <T extends ToolLike>(tools: T[]): T[] => {
    let filtered = applyPolicy(tools, personaToolPolicy);

    if (getActiveSkillToolPolicy) {
      filtered = applyPolicy(filtered, getActiveSkillToolPolicy());
    }

    return filtered;
  };
}
