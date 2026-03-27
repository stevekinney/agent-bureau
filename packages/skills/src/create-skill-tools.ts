import { createTool } from 'armorer';
import { z } from 'zod';

import { escapeXml } from './create-skill-catalog-hook';
import type { SkillSession } from './skill-session';
import type { SkillProvider } from './types';

// ── Types ────────────────────────────────────────────────────────────

export interface CreateSkillToolsOptions {
  /** Skill provider. */
  provider: SkillProvider;
  /** Session tracker for active skills. */
  session: SkillSession;
}

// ── Tools ────────────────────────────────────────────────────────────

/**
 * Creates a tool that activates a skill by name.
 * Loads the skill content and marks it as active in the session.
 */
export function createActivateSkillTool(options: CreateSkillToolsOptions) {
  const { provider, session } = options;

  return createTool({
    name: 'activate_skill',
    description:
      'Activate a skill by name. Returns the skill instructions and lists available resources.',
    input: z.object({
      name: z.string().describe('The skill name to activate'),
    }),
    async execute(params) {
      if (session.isActive(params.name)) {
        return { alreadyActive: true, name: params.name };
      }

      const enabled = await provider.isEnabled(params.name);
      if (!enabled) {
        return { error: 'Skill is disabled', name: params.name };
      }

      const skill = await provider.loadSkill(params.name);
      if (!skill) {
        return { error: 'Skill not found', name: params.name };
      }

      const resources = await provider.listResources(params.name);
      session.activate(params.name, skill.metadata.toolPolicy);

      const escapedName = escapeXml(params.name);
      let xml = `<skill_content name="${escapedName}">\n${skill.body}`;

      if (resources.length > 0) {
        const resourceElements = resources
          .map((path) => `  <file>${escapeXml(path)}</file>`)
          .join('\n');
        xml += `\n\nSkill resources:\n<skill_resources>\n${resourceElements}\n</skill_resources>`;
      }

      xml += '\n</skill_content>';

      return xml;
    },
  });
}

/**
 * Creates a tool that loads a specific resource from an active skill.
 */
export function createLoadSkillResourceTool(options: CreateSkillToolsOptions) {
  const { provider, session } = options;

  return createTool({
    name: 'load_skill_resource',
    description: 'Load a resource file from an active skill.',
    input: z.object({
      skillName: z.string().describe('The skill name'),
      path: z.string().describe('The resource path within the skill'),
    }),
    async execute(params) {
      if (!session.isActive(params.skillName)) {
        return { error: 'Skill is not active', skillName: params.skillName };
      }

      const content = await provider.loadResource(params.skillName, params.path);
      if (content === undefined) {
        return {
          error: 'Resource not found',
          skillName: params.skillName,
          path: params.path,
        };
      }

      return { content };
    },
  });
}

/**
 * Creates a tool that deactivates a skill.
 */
export function createDeactivateSkillTool(options: CreateSkillToolsOptions) {
  const { session } = options;

  return createTool({
    name: 'deactivate_skill',
    description: 'Deactivate a skill, removing it from the active set.',
    input: z.object({
      name: z.string().describe('The skill name to deactivate'),
    }),
    execute(params) {
      const result: { deactivated: boolean; name: string } = {
        deactivated: false,
        name: params.name,
      };

      if (session.isActive(params.name)) {
        session.deactivate(params.name);
        result.deactivated = true;
      }

      return Promise.resolve(result);
    },
  });
}

/**
 * Creates a tool that lists all available skills with active status.
 */
export function createListSkillsTool(options: CreateSkillToolsOptions) {
  const { provider, session } = options;

  return createTool({
    name: 'list_skills',
    description: 'List all available skills with their active status.',
    input: z.object({}),
    async execute() {
      const entries = await provider.listSkills();
      const skills = entries.map((entry) => ({
        ...entry,
        active: session.isActive(entry.name),
      }));
      return { skills };
    },
  });
}

// ── Convenience Factory ──────────────────────────────────────────────

/**
 * Creates all skill management tools bundled together.
 */
export function createSkillToolbox(options: CreateSkillToolsOptions) {
  return {
    activateSkill: createActivateSkillTool(options),
    loadSkillResource: createLoadSkillResourceTool(options),
    deactivateSkill: createDeactivateSkillTool(options),
    listSkills: createListSkillsTool(options),
  };
}

// ── Predicates ───────────────────────────────────────────────────────

/**
 * Predicate that checks if a message string contains skill content.
 * Used by context compactors to exempt skill content from pruning.
 */
export function isSkillContent(message: string): boolean {
  return message.includes('<skill_content ');
}
