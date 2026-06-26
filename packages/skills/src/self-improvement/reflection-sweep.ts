import type { TextValueStore } from '@lostgradient/weft/storage';

import type { MemoryLike, StepResultLike } from '../skill-memory';
import type { SkillProvider } from '../types';
import type { IdentityProviderLike } from './proposals';
import { isRejectedPattern, saveProposal } from './proposals';

// ── Sink Definitions ────────────────────────────────────────────────────────

/**
 * Writes the reflected insight directly to memory.
 * This is the consolidate/promote path: the run summary is reflected into
 * an experiential insight and stored so future recalls benefit from it.
 */
export interface MemorySink {
  type: 'memory';
  /** Memory instance to store the insight in. */
  memory: MemoryLike;
  /** Namespace for stored entries. Default: 'experiential'. */
  namespace?: string;
}

/**
 * Stores the reflected content as a pending skill proposal.
 * The generated content must be a valid SKILL.md document.
 */
export interface SkillSink {
  type: 'skill';
  /** Weft text-value store for proposal persistence. */
  storage: TextValueStore;
  /** Skill provider — used when the proposal is accepted. */
  skillProvider: SkillProvider;
  /** Optional agent the proposal applies to. */
  agentId?: string;
}

/**
 * Stores the reflected content as a pending soul proposal.
 * The generated content must be a JSON array of soul items.
 */
export interface SoulSink {
  type: 'soul';
  /** Weft text-value store for proposal persistence. */
  storage: TextValueStore;
  /** Identity provider — used when the proposal is accepted. */
  identityProvider: IdentityProviderLike;
  /** Optional agent the proposal applies to. */
  agentId?: string;
}

/**
 * Stores the reflected content as a pending persona proposal.
 * The generated content is free-form persona prose.
 * Requires an `agentId` (a persona must target a specific agent).
 */
export interface PersonaSink {
  type: 'persona';
  /** Weft text-value store for proposal persistence. */
  storage: TextValueStore;
  /** Identity provider — used when the proposal is accepted. */
  identityProvider: IdentityProviderLike;
  /** Agent this persona applies to. Required for persona proposals. */
  agentId: string;
}

/** All four supported reflection sinks. */
export type ReflectionSink = MemorySink | SkillSink | SoulSink | PersonaSink;

// ── Options ──────────────────────────────────────────────────────────────────

export interface ReflectionSweepOptions {
  /**
   * Where to route the reflected content. One of:
   * - `memory` — write insight directly to memory (consolidate/promote path).
   * - `skill`  — create a pending skill proposal.
   * - `soul`   — create a pending soul proposal.
   * - `persona` — create a pending persona proposal.
   */
  sink: ReflectionSink;

  /**
   * LLM-powered reflection function. Receives a run summary and returns the
   * proposed content for the sink:
   * - For `memory`: a free-form insight string.
   * - For `skill`: a SKILL.md-formatted document.
   * - For `soul`: a JSON array of soul items.
   * - For `persona`: free-form persona prose.
   *
   * The consumer provides this function — reflectionSweep does not import any
   * LLM SDK.
   */
  reflect: (runSummary: string) => Promise<string>;

  /**
   * Predicate controlling which runs trigger the sweep.
   * When omitted, every final step triggers the sweep.
   */
  shouldReflect?: (result: StepResultLike) => boolean;

  /**
   * Optional human-readable summary for proposals (sinks other than `memory`).
   * When omitted, a default is derived from the run's final content.
   */
  proposalSummary?: (runSummary: string, content: string) => string;
}

// ── Run Summary ──────────────────────────────────────────────────────────────

/**
 * Produces a structured text summary from a completed run's final step result.
 * Identical in intent to the memory package's `summarizeRun` — defined here to
 * avoid a cross-package dependency.
 */
function summarizeStep(result: StepResultLike): string {
  const messages = result.conversation.getMessages();

  // First user message → initial query
  let initialQuery = '(unknown)';
  for (const message of messages) {
    if (message.role === 'user' && typeof message.content === 'string') {
      initialQuery = message.content;
      break;
    }
  }

  // First few assistant messages → approach
  const assistantMessages: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && typeof message.content === 'string') {
      const truncated =
        message.content.length > 120 ? `${message.content.slice(0, 120)}...` : message.content;
      assistantMessages.push(truncated);
      if (assistantMessages.length >= 3) break;
    }
  }
  const approach = assistantMessages.length > 0 ? assistantMessages.join(' -> ') : '(direct)';

  const outcomeSnippet =
    result.content.length > 200 ? `${result.content.slice(0, 200)}...` : result.content;

  return [
    '## Run Summary',
    `- Initial query: ${initialQuery}`,
    `- Approach: ${approach}`,
    `- Outcome: ${outcomeSnippet}`,
    `- Steps: ${result.step + 1}`,
  ].join('\n');
}

// ── Sink Routing ─────────────────────────────────────────────────────────────

async function routeToMemory(
  sink: MemorySink,
  content: string,
  result: StepResultLike,
): Promise<void> {
  const namespace = sink.namespace ?? 'experiential';
  const agentId = result.metadata?.['agentId'] as string | undefined;
  const finishReason = result.metadata?.['finishReason'] as string | undefined;

  await sink.memory.remember(content, {
    source: 'experiential',
    namespace,
    tags: ['strategy'],
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  });
}

async function routeToProposal(
  storage: TextValueStore,
  type: 'skill' | 'soul' | 'persona',
  content: string,
  agentId: string | undefined,
  result: StepResultLike,
  proposalSummary?: (runSummary: string, content: string) => string,
): Promise<void> {
  // Do not resurrect proposals the human has already rejected.
  // rejectProposal() records the content hash precisely to prevent this.
  if (await isRejectedPattern(storage, content)) return;

  const runSummary = summarizeStep(result);
  const defaultSummary = proposalSummary
    ? proposalSummary(runSummary, content)
    : `${type} proposal from run on step ${result.step + 1}: ${content.slice(0, 80)}`;

  await saveProposal(storage, {
    id: crypto.randomUUID(),
    type,
    summary: defaultSummary,
    content,
    agentId,
    sourceEntryIds: [],
    createdAt: new Date().toISOString(),
    status: 'pending',
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * The unified reflection sweep — one engine, four sinks.
 *
 * Builds on the same pattern as `createReflectionHook` (memory) and
 * `proposals.ts` (skills self-improvement), but unifies them so the same
 * LLM-driven sweep can route to:
 * - `memory`  — insight written directly to memory (consolidate/promote path)
 * - `skill`   — pending SKILL.md proposal (self-improvement path)
 * - `soul`    — pending soul update proposal
 * - `persona` — pending persona text proposal
 *
 * `bureau.reflection()` wires this as an `onStep` hook attached to every agent.
 * `bureau.consolidation({ every })` uses the `memory` sink on a scheduled cadence.
 *
 * The consumer provides the `reflect` LLM call — `reflectionSweep` is
 * brain-less by design (no LLM SDK import). The sink receives the content
 * generated by that call.
 *
 * Resolution of open question #5 (promotion default): the `memory` sink writes
 * directly (no gate); all other sinks create a pending proposal for explicit
 * accept/reject. Ambient consolidation via `bureau.consolidation()` is opt-in.
 *
 * @example
 * // Memory sink — insight flows into the shared pool
 * const hook = reflectionSweep({
 *   sink: { type: 'memory', memory, namespace: 'experiential' },
 *   reflect: async (summary) => llm.complete(`Distil this into one insight:\n${summary}`),
 * });
 *
 * @example
 * // Skill sink — creates a pending SKILL.md proposal
 * const hook = reflectionSweep({
 *   sink: { type: 'skill', storage, skillProvider },
 *   reflect: async (summary) => llm.complete(`Generate a SKILL.md from:\n${summary}`),
 * });
 */
export function reflectionSweep(options: ReflectionSweepOptions): {
  onStep: (result: StepResultLike) => Promise<void>;
} {
  const { sink, reflect, shouldReflect, proposalSummary } = options;

  return {
    async onStep(result: StepResultLike): Promise<void> {
      if (!result.final) return;
      if (shouldReflect && !shouldReflect(result)) return;

      const summary = summarizeStep(result);
      const content = await reflect(summary);

      switch (sink.type) {
        case 'memory': {
          await routeToMemory(sink, content, result);
          return;
        }

        case 'skill': {
          await routeToProposal(
            sink.storage,
            'skill',
            content,
            sink.agentId,
            result,
            proposalSummary,
          );
          return;
        }

        case 'soul': {
          await routeToProposal(
            sink.storage,
            'soul',
            content,
            sink.agentId,
            result,
            proposalSummary,
          );
          return;
        }

        case 'persona': {
          await routeToProposal(
            sink.storage,
            'persona',
            content,
            sink.agentId,
            result,
            proposalSummary,
          );
          return;
        }
      }
    },
  };
}
