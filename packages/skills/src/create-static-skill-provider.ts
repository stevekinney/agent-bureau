import { isValidSkillName, SkillParseError } from './parse-skill-markdown';
import type { SkillCatalogEntry, SkillContent, SkillProvider } from './types';

/**
 * Creates an in-memory skill provider backed by Maps.
 *
 * Useful for testing, browser-bundled skills, and scenarios where persistence
 * is not needed. Supports full CRUD for skills, resources, and enabled state.
 */
export function createStaticSkillProvider(initialSkills: SkillContent[] = []): SkillProvider {
  const skills = new Map<string, SkillContent>();
  const resources = new Map<string, string>();
  const enabled = new Map<string, boolean>();

  for (const skill of initialSkills) {
    skills.set(skill.metadata.name, skill);
  }

  return {
    listSkills(): Promise<SkillCatalogEntry[]> {
      return Promise.resolve(
        [...skills.values()].map((skill) => ({
          name: skill.metadata.name,
          description: skill.metadata.description,
        })),
      );
    },

    loadSkill(name: string): Promise<SkillContent | undefined> {
      return Promise.resolve(skills.get(name));
    },

    saveSkill(name: string, content: SkillContent): Promise<void> {
      if (!isValidSkillName(name)) {
        return Promise.reject(new SkillParseError(`Skill name "${name}" is not valid kebab-case.`));
      }
      if (content.metadata.name !== name) {
        return Promise.reject(
          new SkillParseError(
            `Skill name mismatch: parameter "${name}" does not match content metadata name "${content.metadata.name}".`,
          ),
        );
      }
      skills.set(name, content);
      return Promise.resolve();
    },

    deleteSkill(name: string): Promise<void> {
      skills.delete(name);
      enabled.delete(name);

      const prefix = `${name}:`;
      for (const key of resources.keys()) {
        if (key.startsWith(prefix)) {
          resources.delete(key);
        }
      }
      return Promise.resolve();
    },

    listResources(name: string): Promise<string[]> {
      const prefix = `${name}:`;
      return Promise.resolve(
        [...resources.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length)),
      );
    },

    loadResource(name: string, path: string): Promise<string | undefined> {
      return Promise.resolve(resources.get(`${name}:${path}`));
    },

    saveResource(name: string, path: string, content: string): Promise<void> {
      resources.set(`${name}:${path}`, content);
      return Promise.resolve();
    },

    isEnabled(name: string): Promise<boolean> {
      return Promise.resolve(enabled.get(name) ?? true);
    },

    setEnabled(name: string, value: boolean): Promise<void> {
      enabled.set(name, value);
      return Promise.resolve();
    },
  };
}
