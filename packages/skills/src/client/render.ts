import { escapeXml } from '../xml';
import type { ActiveSkill } from './activation';

/**
 * Renders the tier-one catalog a model sees before activation.
 *
 * Name and description only. Anything more here would defeat progressive disclosure at the exact
 * point it is supposed to apply.
 */
export function renderSkillCatalog(
  offered: readonly { readonly name: string; readonly description: string }[],
): string | undefined {
  if (offered.length === 0) return undefined;
  const entries = offered
    .map(
      (entry) => `  <skill name="${escapeXml(entry.name)}">${escapeXml(entry.description)}</skill>`,
    )
    .join('\n');
  return `<available_skills>\n${entries}\n</available_skills>`;
}

/**
 * Renders the instructions of every active skill.
 *
 * This is the whole reason active instructions survive compaction: they are **re-rendered from the
 * client on every step**, not carried as transcript messages that a compaction strategy has to be
 * persuaded to keep. A summarizer that rewrites the entire history cannot lose them, because they
 * were never part of the history it summarized.
 *
 * The digest is rendered alongside each skill so a reader of a transcript — or of a recovered
 * session — can tie the instructions in front of them to the activation record that admitted them.
 */
export function renderActiveSkillInstructions(active: readonly ActiveSkill[]): string | undefined {
  if (active.length === 0) return undefined;

  // Deduplicated by name: the client already refuses a repeat activation, and rendering defends the
  // same invariant at the boundary rather than trusting its caller's array.
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const skill of active) {
    if (seen.has(skill.record.name)) continue;
    seen.add(skill.record.name);
    blocks.push(
      `<skill_content name="${escapeXml(skill.record.name)}" ` +
        `digest="${escapeXml(skill.record.instructionsDigest)}">\n` +
        `${escapeXml(skill.instructions)}\n` +
        `</skill_content>`,
    );
  }

  return blocks.join('\n');
}

/** True when a message carries rendered skill instructions. */
export function isRenderedSkillContent(message: string): boolean {
  return message.includes('<skill_content ');
}
