import type { AgentIdentity, PersonaDescriptor, SoulBudget, SoulItem } from './types';

/**
 * Sort soul items by priority: pinned first, then by reinforcementCount descending.
 */
function sortSoulItems(items: SoulItem[]): SoulItem[] {
  return [...items].sort((a, b) => {
    // Pinned items first
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    // Then by reinforcement count descending
    return b.reinforcementCount - a.reinforcementCount;
  });
}

/**
 * Render a PersonaDescriptor as structured text.
 */
function renderPersonaDescriptor(descriptor: PersonaDescriptor): string {
  const parts = [`You are ${descriptor.name}, a ${descriptor.role}`];

  if (descriptor.expertise) {
    parts.push(`with expertise in ${descriptor.expertise}`);
  }

  if (descriptor.domain) {
    parts.push(`operating in the ${descriptor.domain} domain`);
  }

  if (descriptor.taskContext) {
    parts.push(`focused on ${descriptor.taskContext}`);
  }

  return parts.join(' ') + '.';
}

/**
 * Apply token budget enforcement: drop lowest-priority non-pinned items
 * until the soul fits within the budget.
 */
function enforceTokenBudget(items: SoulItem[], budget: SoulBudget): SoulItem[] {
  const sorted = sortSoulItems(items);
  const result: SoulItem[] = [];
  let tokenCount = 0;

  for (const item of sorted) {
    const itemTokens = budget.estimateTokens(item.content);

    if (item.pinned) {
      // Pinned items are never dropped, even if over budget
      result.push(item);
      tokenCount += itemTokens;
    } else if (tokenCount + itemTokens <= budget.maxTokens) {
      result.push(item);
      tokenCount += itemTokens;
    }
    // Non-pinned items that exceed the budget are silently dropped
  }

  return result;
}

/**
 * Resolves an AgentIdentity into a single system prompt string.
 *
 * The resolution merges soul items, persona, and user context into
 * a coherent prompt suitable for injection as a system message.
 *
 * - Soul items are ordered by priority (pinned first, then reinforcement count)
 * - Token budget enforcement drops lowest-priority non-pinned items
 * - Persona text is appended under a `## Role` heading
 * - User context is appended under a `## User Context` heading
 * - Missing sections are omitted (no empty headings)
 */
export function resolveIdentity(identity: AgentIdentity, budget?: SoulBudget): string {
  const sections: string[] = [];

  // Soul section (no heading — it IS the core system prompt)
  let soulItems = sortSoulItems(identity.soul);

  if (budget) {
    soulItems = enforceTokenBudget(identity.soul, budget);
    // Re-sort after budget enforcement to maintain display order
    soulItems = sortSoulItems(soulItems);
  }

  if (soulItems.length > 0) {
    sections.push(soulItems.map((item) => item.content).join('\n'));
  }

  // Persona section
  if (identity.personaText) {
    sections.push(`## Role\n\n${identity.personaText}`);
  } else if (identity.persona) {
    sections.push(`## Role\n\n${renderPersonaDescriptor(identity.persona)}`);
  }

  // User context section
  if (identity.userContext) {
    sections.push(`## User Context\n\n${identity.userContext}`);
  }

  return sections.join('\n\n');
}
