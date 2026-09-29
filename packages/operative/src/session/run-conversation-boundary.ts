import type { ConversationHistory, Message } from 'conversationalist';

import type { AgentSession, RunConversationBoundary, RunRef } from '../agent-session';
import { ForkThroughRunError, type ForkThroughRunErrorReason } from './session-handle-types';

/**
 * COR-816: each terminal run persists its immutable conversation boundary on
 * its own `RunRef`. A boundary is stored as the delta from the nearest
 * earlier run whose boundary still reconstructs: the ids after the prefix it
 * shares with that base, and the bodies the base chain cannot supply
 * unchanged. A session of sequential runs therefore stores each message id
 * and body once, not once per run. Boundaries are never rewritten, so a
 * delta's base can never change underneath it.
 */

function sameMessage(left: Message | undefined, right: Message): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

interface ResolvedBoundary {
  readonly conversation: RunConversationBoundary['conversation'];
  readonly ids: readonly string[];
  readonly bodies: ReadonlyMap<string, Message>;
}

/**
 * Run `sequence`'s boundary followed by its base chain, newest first.
 * `undefined` when the run has no boundary or its chain is broken — a
 * missing base, or a base that does not point strictly earlier.
 */
function boundaryChain(
  runs: readonly RunRef[],
  sequence: number,
): RunConversationBoundary[] | undefined {
  const head = runs[sequence]?.conversationBoundary;
  if (head === undefined) return undefined;
  const chain = [head];
  let current = sequence;
  let base = head.baseSequence;
  while (base !== undefined) {
    const boundary = runs[base]?.conversationBoundary;
    if (boundary === undefined || base >= current) return undefined;
    chain.push(boundary);
    current = base;
    base = boundary.baseSequence;
  }
  return chain;
}

/**
 * The chain head's ordered ids. Walking from the head toward the root, each
 * boundary contributes only the part of its own ids that survives into the
 * head, so this costs the head's length plus the chain's, never every
 * boundary's full list. `undefined` when a boundary claims to share more
 * ids than its base holds.
 */
function resolveIds(chain: readonly RunConversationBoundary[]): string[] | undefined {
  let length = 0;
  for (const { baseIdCount = 0, ids } of chain.toReversed()) {
    if (!Number.isInteger(baseIdCount) || baseIdCount < 0 || baseIdCount > length) {
      return undefined;
    }
    length = baseIdCount + ids.length;
  }
  const segments: (readonly string[])[] = [];
  let wanted = length;
  for (const { baseIdCount = 0, ids } of chain) {
    if (wanted > baseIdCount) {
      segments.push(ids.slice(0, wanted - baseIdCount));
      wanted = baseIdCount;
    }
  }
  return segments.toReversed().flat();
}

/**
 * Resolve run `sequence`'s ordered ids and every message body its chain can
 * see, newest boundary winning. `undefined` when the run has no boundary or
 * its chain does not decode.
 */
function resolveBoundary(runs: readonly RunRef[], sequence: number): ResolvedBoundary | undefined {
  const chain = boundaryChain(runs, sequence);
  if (chain === undefined) return undefined;
  const ids = resolveIds(chain);
  if (ids === undefined) return undefined;
  const bodies = new Map<string, Message>();
  for (const boundary of chain.toReversed()) {
    for (const [id, message] of Object.entries(boundary.messages)) bodies.set(id, message);
  }
  return { conversation: chain[0]!.conversation, ids, bodies };
}

function sharedPrefixLength(left: readonly string[], right: readonly string[]): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length++;
  }
  return length;
}

/** The bodies of the listed `ids` that `known` cannot already supply unchanged. */
function unknownBodies(
  ids: readonly string[],
  messages: ConversationHistory['messages'],
  known: ReadonlyMap<string, Message>,
): Record<string, Message> {
  const bodies: Record<string, Message> = {};
  for (const id of ids) {
    const message = messages[id];
    if (message !== undefined && !sameMessage(known.get(id), message)) bodies[id] = message;
  }
  return bodies;
}

/**
 * Encode `transcript` as run `sequence`'s boundary, relative to the nearest
 * earlier run whose boundary reconstructs. Only the ids after the prefix
 * that base shares, and the bodies its chain cannot already resolve
 * unchanged, are stored — decoding resolves through the same chain, so the
 * result is exact. With no usable base the boundary is self-contained.
 */
export function createRunConversationBoundary(
  runs: readonly RunRef[],
  sequence: number,
  transcript: ConversationHistory,
): RunConversationBoundary {
  const { ids, messages, ...conversation } = transcript;
  for (let baseSequence = Math.min(sequence, runs.length) - 1; baseSequence >= 0; baseSequence--) {
    const base = resolveBoundary(runs, baseSequence);
    if (base === undefined) continue;
    const baseIdCount = sharedPrefixLength(base.ids, ids);
    return {
      baseSequence,
      baseIdCount,
      conversation,
      ids: ids.slice(baseIdCount),
      messages: unknownBodies(ids, messages, base.bodies),
    };
  }
  return { conversation, ids: [...ids], messages: unknownBodies(ids, messages, new Map()) };
}

/**
 * Rebuild run `sequence`'s exact boundary history as a fresh deep copy that
 * shares nothing with the stored boundaries. `undefined` when the run has no
 * boundary, its base chain does not decode, or a listed message body is
 * missing.
 */
export function reconstructRunConversation(
  runs: readonly RunRef[],
  sequence: number,
): ConversationHistory | undefined {
  const resolved = resolveBoundary(runs, sequence);
  if (resolved === undefined) return undefined;
  const messages: Record<string, Message> = {};
  for (const id of resolved.ids) {
    const message = resolved.bodies.get(id);
    if (message === undefined) return undefined;
    messages[id] = message;
  }
  return structuredClone({ ...resolved.conversation, ids: resolved.ids, messages });
}

/**
 * The history `fork({ throughRun })` copies: the reconstructed boundary of
 * that terminal run. Rejects every fork point without one with a typed
 * `ForkThroughRunError`.
 */
export function conversationThroughRun(
  session: AgentSession,
  throughRun: number,
): ConversationHistory {
  const reject = (reason: ForkThroughRunErrorReason): never => {
    throw new ForkThroughRunError({
      sessionId: session.id,
      throughRun,
      runCount: session.runs.length,
      reason,
    });
  };
  if (!Number.isInteger(throughRun)) return reject('invalid');
  if (throughRun < 0) return reject('negative');
  // `RunRef.sequence` equals the ref's index in `runs`.
  const runRef = session.runs[throughRun];
  if (runRef === undefined) return reject('out-of-range');
  if (runRef.status === 'running') return reject('non-terminal');
  return reconstructRunConversation(session.runs, throughRun) ?? reject('unavailable');
}
