import type { IdentityProvider, SoulItem } from './types';

/**
 * Compare two soul items to determine whether the proposed version
 * differs from the current one. Checks all fields that distillation
 * or user edits can change, not just `content`.
 */
function hasSoulItemChanged(current: SoulItem, proposed: SoulItem): boolean {
  return (
    current.content !== proposed.content ||
    current.pinned !== proposed.pinned ||
    current.topic !== proposed.topic ||
    current.reinforcementCount !== proposed.reinforcementCount ||
    JSON.stringify(current.sourceEntryIds ?? []) !== JSON.stringify(proposed.sourceEntryIds ?? [])
  );
}

/**
 * A single entry in a soul diff.
 */
export interface SoulDiffEntry {
  type: 'addition' | 'removal' | 'modification';
  /** The item in its current form (undefined for additions). */
  current?: SoulItem;
  /** The item in its proposed form (undefined for removals). */
  proposed?: SoulItem;
}

/**
 * The structured diff between the current soul and a pending update.
 */
export interface SoulDiff {
  additions: SoulDiffEntry[];
  removals: SoulDiffEntry[];
  modifications: SoulDiffEntry[];
  /** True if there are no changes. */
  empty: boolean;
}

/**
 * Load the current soul and pending update, return a structured diff
 * showing additions, removals, and modifications.
 */
export async function getSoulDiff(provider: IdentityProvider, agentId?: string): Promise<SoulDiff> {
  const current = await provider.loadSoul(agentId);
  const pending = await provider.loadPendingSoulUpdate(agentId);

  if (!pending) {
    return { additions: [], removals: [], modifications: [], empty: true };
  }

  const currentMap = new Map(current.map((item) => [item.id, item]));
  const pendingMap = new Map(pending.map((item) => [item.id, item]));

  const additions: SoulDiffEntry[] = [];
  const removals: SoulDiffEntry[] = [];
  const modifications: SoulDiffEntry[] = [];

  // Find additions and modifications
  for (const [id, proposedItem] of pendingMap) {
    const currentItem = currentMap.get(id);
    if (!currentItem) {
      additions.push({ type: 'addition', proposed: proposedItem });
    } else if (hasSoulItemChanged(currentItem, proposedItem)) {
      modifications.push({ type: 'modification', current: currentItem, proposed: proposedItem });
    }
  }

  // Find removals
  for (const [id, currentItem] of currentMap) {
    if (!pendingMap.has(id)) {
      removals.push({ type: 'removal', current: currentItem });
    }
  }

  return {
    additions,
    removals,
    modifications,
    empty: additions.length === 0 && removals.length === 0 && modifications.length === 0,
  };
}

/**
 * Promote the pending soul update to current. Archives the previous
 * soul in version history and clears the pending update.
 */
export async function acceptSoulUpdate(
  provider: IdentityProvider,
  agentId?: string,
): Promise<{ version: number } | undefined> {
  const pending = await provider.loadPendingSoulUpdate(agentId);
  if (!pending) return undefined;

  // saveSoul handles archiving the current version in history
  await provider.saveSoul(pending, agentId);
  await provider.clearPendingSoulUpdate(agentId);

  const history = await provider.loadSoulHistory(agentId);
  const latestVersion = history.length > 0 ? history[history.length - 1]!.version : 0;

  return { version: latestVersion + 1 };
}

/**
 * Clear the pending soul update without applying changes.
 */
export async function rejectSoulUpdate(
  provider: IdentityProvider,
  agentId?: string,
): Promise<void> {
  await provider.clearPendingSoulUpdate(agentId);
}

/**
 * Set a soul item's `pinned` flag to `true`.
 */
export async function pinSoulItem(
  provider: IdentityProvider,
  itemId: string,
  agentId?: string,
): Promise<boolean> {
  const soul = await provider.loadSoul(agentId);
  const index = soul.findIndex((i) => i.id === itemId);
  if (index === -1) return false;

  // Clone the array and the target item to avoid mutating the provider's
  // internal state before saveSoul archives the current version in history.
  const updatedSoul = soul.map((item, i) =>
    i === index ? { ...item, pinned: true, updatedAt: new Date().toISOString() } : item,
  );

  await provider.saveSoul(updatedSoul, agentId);
  return true;
}

/**
 * Set a soul item's `pinned` flag to `false`.
 */
export async function unpinSoulItem(
  provider: IdentityProvider,
  itemId: string,
  agentId?: string,
): Promise<boolean> {
  const soul = await provider.loadSoul(agentId);
  const index = soul.findIndex((i) => i.id === itemId);
  if (index === -1) return false;

  // Clone the array and the target item to avoid mutating the provider's
  // internal state before saveSoul archives the current version in history.
  const updatedSoul = soul.map((item, i) =>
    i === index ? { ...item, pinned: false, updatedAt: new Date().toISOString() } : item,
  );

  await provider.saveSoul(updatedSoul, agentId);
  return true;
}
