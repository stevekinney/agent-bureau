import type { ToolPolicy } from './types';

// ── Types ────────────────────────────────────────────────────────────

export interface SkillSession {
  /** Get all currently active skill names. */
  getActiveSkills(): string[];
  /** Check if a skill is active. */
  isActive(name: string): boolean;
  /** Mark a skill as active and store its tool policy. */
  activate(name: string, toolPolicy?: ToolPolicy): void;
  /** Mark a skill as inactive. */
  deactivate(name: string): void;
  /** Get the combined tool policy of all active skills. Returns undefined if no active skills have policies. */
  getActiveToolPolicy(): ToolPolicy | undefined;
}

// ── Implementation ───────────────────────────────────────────────────

/** Creates a new skill session for tracking active skills within a run. */
export function createSkillSession(): SkillSession {
  const activeSkills = new Map<string, ToolPolicy | undefined>();

  return {
    getActiveSkills() {
      return [...activeSkills.keys()];
    },

    isActive(name: string) {
      return activeSkills.has(name);
    },

    activate(name: string, toolPolicy?: ToolPolicy) {
      activeSkills.set(name, toolPolicy);
    },

    deactivate(name: string) {
      activeSkills.delete(name);
    },

    getActiveToolPolicy() {
      const policies: ToolPolicy[] = [];

      for (const policy of activeSkills.values()) {
        if (policy) {
          policies.push(policy);
        }
      }

      if (policies.length === 0) {
        return undefined;
      }

      // Merge: intersection of allow lists, union of deny lists.
      let mergedAllowList: string[] | undefined;
      let mergedDenyList: string[] | undefined;

      for (const policy of policies) {
        if (policy.allowList) {
          if (mergedAllowList === undefined) {
            mergedAllowList = [...policy.allowList];
          } else {
            const allowSet = new Set(policy.allowList);
            mergedAllowList = mergedAllowList.filter((tool) => allowSet.has(tool));
          }
        }

        if (policy.denyList) {
          if (mergedDenyList === undefined) {
            mergedDenyList = [...policy.denyList];
          } else {
            const existingSet = new Set(mergedDenyList);
            for (const tool of policy.denyList) {
              if (!existingSet.has(tool)) {
                mergedDenyList.push(tool);
              }
            }
          }
        }
      }

      return {
        ...(mergedAllowList ? { allowList: mergedAllowList } : {}),
        ...(mergedDenyList ? { denyList: mergedDenyList } : {}),
      };
    },
  };
}
