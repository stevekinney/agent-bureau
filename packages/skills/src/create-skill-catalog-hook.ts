import type { StepContextLike } from './skill-memory';
import type { SkillCatalogEntry, SkillProvider, ToolPolicy } from './types';

// ── Types ────────────────────────────────────────────────────────────

export interface CreateSkillCatalogHookOptions {
  /** Skill provider to read from. */
  provider: SkillProvider;
  /** Persona skill policy (allow/deny list of skill names). */
  skillPolicy?: ToolPolicy;
}

// ── Implementation ───────────────────────────────────────────────────

/**
 * Creates a prepareStep hook that injects the skill catalog as an
 * `<available_skills>` XML block on step 0. Caches the catalog for the run.
 *
 * Returns the catalog XML string on step 0, undefined on other steps.
 * The consumer is responsible for injecting the string into the conversation.
 */
export function createSkillCatalogHook(options: CreateSkillCatalogHookOptions): {
  prepareStep: (context: StepContextLike) => Promise<string | undefined>;
} {
  const { provider, skillPolicy } = options;
  let cached: string | undefined | null = null; // null = not yet computed

  return {
    async prepareStep(context: StepContextLike): Promise<string | undefined> {
      if (context.step !== 0) {
        return undefined;
      }

      // Return cached result if already computed (even if it was undefined)
      if (cached !== null) {
        return cached;
      }

      try {
        const catalog = await buildCatalog(provider, skillPolicy);
        cached = catalog;
        return catalog;
      } catch {
        // Degrade gracefully — provider errors should not crash the run.
        cached = undefined;
        return undefined;
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

async function buildCatalog(
  provider: SkillProvider,
  skillPolicy: ToolPolicy | undefined,
): Promise<string | undefined> {
  let entries = await provider.listSkills();

  // Filter by enabled status
  const enabledChecks = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      enabled: await provider.isEnabled(entry.name),
    })),
  );
  entries = enabledChecks.filter((check) => check.enabled).map((check) => check.entry);

  // Filter by skill policy
  if (skillPolicy) {
    entries = applySkillPolicy(entries, skillPolicy);
  }

  if (entries.length === 0) {
    return undefined;
  }

  return formatCatalogXml(entries);
}

function applySkillPolicy(entries: SkillCatalogEntry[], policy: ToolPolicy): SkillCatalogEntry[] {
  let filtered = entries;

  if (policy.allowList) {
    const allowSet = new Set(policy.allowList);
    filtered = filtered.filter((entry) => allowSet.has(entry.name));
  }

  if (policy.denyList) {
    const denySet = new Set(policy.denyList);
    filtered = filtered.filter((entry) => !denySet.has(entry.name));
  }

  return filtered;
}

export function escapeXml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  };

  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

function formatCatalogXml(entries: SkillCatalogEntry[]): string {
  const skillElements = entries
    .map(
      (entry) => `<skill name="${escapeXml(entry.name)}">${escapeXml(entry.description)}</skill>`,
    )
    .join('\n');

  return `<available_skills>
You have the following skills available. Use the activate_skill tool to load a skill's full instructions.

${skillElements}
</available_skills>`;
}
