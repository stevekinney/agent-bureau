/**
 * Structured persona metadata for multi-agent routing.
 * Informed by SPARK's persona space formalization.
 */
export interface PersonaDescriptor {
  /** The persona's display name (e.g., "Atlas", "Research Agent"). */
  name: string;
  /** What this agent does. */
  role: string;
  /** The agent's domain of expertise. */
  expertise?: string;
  /** The task context this agent is suited for. */
  taskContext?: string;
  /** The knowledge domain. */
  domain?: string;
}

/**
 * A single item in the soul document, with metadata for lifecycle management.
 */
export interface SoulItem {
  /** Unique identifier for this soul item. */
  id: string;
  /** The text content of this soul item. */
  content: string;
  /** Where this item came from. */
  source: 'seed' | 'graduated' | 'user-edit';
  /** If graduated from memory, the memory entry ID(s) it was derived from. */
  sourceEntryIds?: string[];
  /** Whether this item is exempt from demotion. */
  pinned: boolean;
  /** Topic cluster for diversity tracking. */
  topic?: string;
  /** When this item was added or last reinforced (ISO 8601). */
  updatedAt: string;
  /** How many times the backing evidence has been reinforced in memory. */
  reinforcementCount: number;
}

/**
 * The complete identity document for an agent.
 */
export interface AgentIdentity {
  /** The soul document — personality, values, behavioral rules. */
  soul: SoulItem[];
  /** Structured persona metadata. */
  persona?: PersonaDescriptor;
  /** Free-text persona overlay (role-specific behavioral instructions). */
  personaText?: string;
  /** User context — name, timezone, preferences. User-curated, exempt from distillation. */
  userContext?: string;
}

/**
 * Configuration for the soul's token budget and distillation behavior.
 */
export interface SoulBudget {
  /** Maximum tokens for the soul document. Default: 2000. */
  maxTokens: number;
  /** Token estimator function. */
  estimateTokens: (text: string) => number;
  /** Maximum number of items from the same topic cluster. Default: 5. Prevents over-personalization. */
  maxItemsPerTopic: number;
}

export type { KeyValueStore } from 'storage';

/**
 * The interface platform adapters implement for identity persistence.
 * Abstracts storage so the identity system runs on any platform
 * (filesystem, IndexedDB, chrome.storage, remote HTTP).
 */
export interface IdentityProvider {
  /** Load the soul items for a given agent (or the orchestrator if no agentId). */
  loadSoul(agentId?: string): Promise<SoulItem[]>;
  /** Save updated soul items. */
  saveSoul(items: SoulItem[], agentId?: string): Promise<void>;
  /** List all registered persona agent IDs. */
  listPersonas(): Promise<string[]>;
  /** Load the persona descriptor for a subagent. */
  loadPersona(
    agentId: string,
  ): Promise<{ descriptor?: PersonaDescriptor; text?: string } | undefined>;
  /** Save a persona (create or update). */
  savePersona(
    agentId: string,
    persona: { descriptor?: PersonaDescriptor; text?: string },
  ): Promise<void>;
  /** Delete a persona. */
  deletePersona(agentId: string): Promise<void>;
  /** Load user context. */
  loadUserContext(): Promise<string | undefined>;
  /** Save user context. */
  saveUserContext(context: string): Promise<void>;
  /** Load a pending soul update (awaiting user approval). */
  loadPendingSoulUpdate(agentId?: string): Promise<SoulItem[] | undefined>;
  /** Save a pending soul update. */
  savePendingSoulUpdate(items: SoulItem[], agentId?: string): Promise<void>;
  /** Clear the pending soul update (after acceptance or rejection). */
  clearPendingSoulUpdate(agentId?: string): Promise<void>;
  /** Load soul version history. */
  loadSoulHistory(
    agentId?: string,
  ): Promise<{ version: number; items: SoulItem[]; timestamp: string }[]>;
}

/**
 * A single entry in the soul version history.
 */
export interface SoulHistoryEntry {
  version: number;
  items: SoulItem[];
  timestamp: string;
}
