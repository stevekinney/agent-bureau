import { parseSkillMarkdown, SkillParseError } from '../parse-skill-markdown';
import type { SkillProvider } from '../types';

export interface FetchFromRegistryOptions {
  /** Base URL of the skill registry. */
  baseUrl: string;
  /** Skill names to fetch. */
  names: string[];
  /** Skill provider to save fetched skills to. */
  provider: SkillProvider;
  /** Custom fetch function (for testing). Defaults to global fetch. */
  fetchFunction?: typeof fetch;
}

export interface FetchResult {
  /** Skills successfully fetched and saved. */
  loaded: string[];
  /** Errors encountered. */
  errors: Array<{ name: string; error: string }>;
}

/**
 * Fetches skills from a remote registry and saves them to the provider.
 * The registry is expected to serve SKILL.md content at `{baseUrl}/{name}/SKILL.md`.
 */
export async function fetchFromRegistry(options: FetchFromRegistryOptions): Promise<FetchResult> {
  const { baseUrl, names, provider, fetchFunction = globalThis.fetch } = options;

  const result: FetchResult = {
    loaded: [],
    errors: [],
  };

  for (const name of names) {
    const url = `${baseUrl}/${name}/SKILL.md`;

    try {
      const response = await fetchFunction(url);

      if (!response.ok) {
        result.errors.push({
          name,
          error: `Registry returned ${response.status} for skill "${name}"`,
        });
        continue;
      }

      const text = await response.text();
      const parsed = parseSkillMarkdown(text);

      await provider.saveSkill(parsed.metadata.name, parsed);
      result.loaded.push(name);
    } catch (error) {
      const message =
        error instanceof SkillParseError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      result.errors.push({ name, error: message });
    }
  }

  return result;
}
