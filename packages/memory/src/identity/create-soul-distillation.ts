import type { Memory, MemorySearchResult } from '../types';
import type { IdentityProvider, SoulBudget, SoulItem } from './types';

/**
 * Options for creating a soul distillation task.
 */
export interface CreateSoulDistillationOptions {
  /** Memory instance to read candidate entries from. */
  memory: Memory;
  /** Identity provider to read/write the soul. */
  provider: IdentityProvider;
  /** Agent ID (omit for orchestrator). */
  agentId?: string;
  /** Namespace to scan for graduation candidates. */
  namespace?: string;
  /** Token budget for the soul. */
  budget: SoulBudget;
  /** Minimum confidence score for graduation candidates. Default: 0.9. */
  graduationConfidence?: number;
  /**
   * Minimum reinforcement count (how many times the memory has been
   * reinforced/merged). Default: 3.
   */
  graduationReinforcement?: number;
  /**
   * Function that generates a new soul document from current items + candidates.
   * Consumer provides the LLM call.
   */
  distill: (
    currentSoul: string,
    candidates: Array<{ content: string; confidence: number; topic?: string }>,
  ) => Promise<string>;
  /**
   * Optional safety filter. Returns true if the proposed soul item is safe
   * to include. Consumer provides this — could be an LLM call checking for
   * bias/discrimination patterns. Informed by "From Personalization to
   * Prejudice" (WSDM 2026).
   */
  safetyFilter?: (item: string) => Promise<boolean>;
  /**
   * Number of entries to process per chunk. Default: 50.
   */
  chunkSize?: number;
}

/**
 * State tracked across distillation chunks.
 */
export interface SoulDistillationState {
  /** Memory entries scanned so far. */
  scanned: number;
  /** Candidates identified for graduation. */
  candidates: Array<{
    content: string;
    confidence: number;
    reinforcementCount: number;
    topic?: string;
    entryId: string;
  }>;
  /** Items proposed for demotion. */
  demotions: string[];
  /** Whether the proposal has been generated and stored. */
  proposalGenerated: boolean;
}

/**
 * Structurally compatible with operative's CreateChunkedTaskOptions<SoulDistillationState>.
 */
export interface SoulDistillationChunkedTaskOptions {
  name: string;
  priority: 'background';
  initialState: SoulDistillationState;
  processChunk: (
    state: SoulDistillationState,
    signal: AbortSignal,
  ) => Promise<{ state: SoulDistillationState; done: boolean }>;
  onComplete?: (finalState: SoulDistillationState) => void | Promise<void>;
  onError?: (error: unknown, state: SoulDistillationState) => void | Promise<void>;
}

function getConfidence(entry: MemorySearchResult): number {
  const conf = entry.metadata['confidence'];
  return typeof conf === 'number' ? conf : 0.5;
}

function getReinforcementCount(entry: MemorySearchResult): number {
  const count = entry.metadata['reinforcementCount'];
  return typeof count === 'number' ? count : 0;
}

function getTopic(entry: MemorySearchResult): string | undefined {
  const topic = entry.metadata['topic'];
  return typeof topic === 'string' ? topic : undefined;
}

/**
 * Creates a background task that reviews accumulated memories and proposes
 * updates to the soul document. This is the graduation/demotion lifecycle.
 *
 * Returns options structurally compatible with operative's createChunkedTask.
 *
 * The distillation pipeline:
 * 1. **Scan** — Query memory for high-confidence, frequently-reinforced entries
 * 2. **Diversity check** — Prevent topic over-concentration (OP-Bench)
 * 3. **Safety filter** — Reject bias/discrimination patterns (WSDM 2026)
 * 4. **Budget check** — Identify demotion candidates for low-value non-pinned items
 * 5. **Generate proposal** — Call consumer's distill function
 * 6. **Store as pending** — Never applied automatically
 */
export function createSoulDistillationTask(
  options: CreateSoulDistillationOptions,
): SoulDistillationChunkedTaskOptions {
  const {
    memory,
    provider,
    agentId,
    namespace,
    budget,
    graduationConfidence = 0.9,
    graduationReinforcement = 3,
    distill,
    safetyFilter,
    chunkSize = 50,
  } = options;

  return {
    name: 'soul-distillation',
    priority: 'background',
    initialState: {
      scanned: 0,
      candidates: [],
      demotions: [],
      proposalGenerated: false,
    },

    async processChunk(
      state: SoulDistillationState,
      signal: AbortSignal,
    ): Promise<{ state: SoulDistillationState; done: boolean }> {
      // If the proposal has already been generated, we're done
      if (state.proposalGenerated) {
        return { state, done: true };
      }

      // ── Stage 1: Scan for graduation candidates ──────────────────
      const entriesToProcess = await memory.list({
        limit: chunkSize,
        offset: state.scanned,
        ...(namespace && { namespace }),
      });

      if (entriesToProcess.length === 0 && state.candidates.length === 0) {
        // No entries at all — nothing to distill
        return { state, done: true };
      }

      const scannedIds = new Set(state.candidates.map((c) => c.entryId));

      const newCandidates = [...state.candidates];

      for (const entry of entriesToProcess) {
        if (signal.aborted) break;

        // Skip entries already identified as candidates in a previous chunk
        if (scannedIds.has(entry.id)) continue;

        const confidence = getConfidence(entry);
        const reinforcement = getReinforcementCount(entry);

        if (confidence >= graduationConfidence && reinforcement >= graduationReinforcement) {
          newCandidates.push({
            content: entry.content,
            confidence,
            reinforcementCount: reinforcement,
            topic: getTopic(entry),
            entryId: entry.id,
          });
        }
      }

      const newScanned = state.scanned + entriesToProcess.length;
      const moreEntries = entriesToProcess.length >= chunkSize;

      if (signal.aborted) {
        return {
          state: { ...state, scanned: newScanned, candidates: newCandidates },
          done: false,
        };
      }

      // If there are more entries to scan, continue scanning
      if (moreEntries) {
        return {
          state: { ...state, scanned: newScanned, candidates: newCandidates },
          done: false,
        };
      }

      // ── All entries scanned. Now filter and generate proposal ────

      if (newCandidates.length === 0) {
        return {
          state: { ...state, scanned: newScanned, candidates: [], proposalGenerated: true },
          done: true,
        };
      }

      // Sort candidates by confidence descending, then recency
      const sortedCandidates = [...newCandidates].sort((a, b) => b.confidence - a.confidence);

      // ── Stage 2: Diversity check ─────────────────────────────────
      const currentSoul = await provider.loadSoul(agentId);
      const topicCounts = new Map<string, number>();

      for (const item of currentSoul) {
        if (item.topic) {
          topicCounts.set(item.topic, (topicCounts.get(item.topic) ?? 0) + 1);
        }
      }

      const diverseFilteredCandidates = sortedCandidates.filter((candidate) => {
        if (!candidate.topic) return true;
        const currentCount = topicCounts.get(candidate.topic) ?? 0;
        if (currentCount >= budget.maxItemsPerTopic) return false;
        // Speculatively increment so subsequent candidates in the same topic are constrained
        topicCounts.set(candidate.topic, currentCount + 1);
        return true;
      });

      // ── Stage 3: Safety filter ───────────────────────────────────
      let safeCandidates = diverseFilteredCandidates;
      if (safetyFilter) {
        const safetyResults = await Promise.all(
          diverseFilteredCandidates.map(async (candidate) => ({
            candidate,
            safe: await safetyFilter(candidate.content),
          })),
        );
        safeCandidates = safetyResults
          .filter((result) => result.safe)
          .map((result) => result.candidate);
      }

      if (safeCandidates.length === 0) {
        return {
          state: {
            ...state,
            scanned: newScanned,
            candidates: newCandidates,
            proposalGenerated: true,
          },
          done: true,
        };
      }

      // ── Stage 4: Budget check / demotion candidates ──────────────
      const currentSoulText = currentSoul.map((item) => item.content).join('\n');
      const candidateText = safeCandidates.map((c) => c.content).join('\n');
      const totalTokens =
        budget.estimateTokens(currentSoulText) + budget.estimateTokens(candidateText);

      const demotions: string[] = [];

      if (totalTokens > budget.maxTokens) {
        // Identify demotion candidates: non-pinned, lowest reinforcement, oldest
        const demotionCandidates = currentSoul
          .filter((item) => !item.pinned)
          .sort((a, b) => {
            if (a.reinforcementCount !== b.reinforcementCount) {
              return a.reinforcementCount - b.reinforcementCount;
            }
            return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          });

        let currentTokens = budget.estimateTokens(currentSoulText);
        const targetBudget = budget.maxTokens - budget.estimateTokens(candidateText);

        for (const candidate of demotionCandidates) {
          if (currentTokens <= targetBudget) break;
          currentTokens -= budget.estimateTokens(candidate.content);
          demotions.push(candidate.id);
        }

        // Store demoted items back in memory (not deleted)
        for (const demotedId of demotions) {
          const demotedItem = currentSoul.find((item) => item.id === demotedId);
          if (demotedItem) {
            await memory.remember(demotedItem.content, {
              ...(namespace && { namespace }),
              source: 'manual' as const,
              tags: ['demoted-soul-item'],
              _demotedFromSoul: true,
              _originalSoulItemId: demotedItem.id,
            });
          }
        }
      }

      // ── Stage 5: Generate proposal ───────────────────────────────
      const proposalText = await distill(currentSoulText, safeCandidates);

      // Parse the proposal into SoulItem[] — one item per non-empty line
      const proposedItems: SoulItem[] = proposalText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => ({
          id: `graduated-${Date.now()}-${index}`,
          content: line,
          source: 'graduated' as const,
          sourceEntryIds: safeCandidates.map((c) => c.entryId),
          pinned: false,
          updatedAt: new Date().toISOString(),
          reinforcementCount: Math.max(...safeCandidates.map((c) => c.reinforcementCount)),
        }));

      // Merge with surviving current items (exclude demoted)
      const demotionSet = new Set(demotions);
      const survivingItems = currentSoul.filter((item) => !demotionSet.has(item.id));
      const finalProposal = [...survivingItems, ...proposedItems];

      // ── Stage 6: Store as pending ────────────────────────────────
      await provider.savePendingSoulUpdate(finalProposal, agentId);

      return {
        state: {
          scanned: newScanned,
          candidates: newCandidates,
          demotions,
          proposalGenerated: true,
        },
        done: true,
      };
    },
  };
}
