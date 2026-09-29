import type { SessionHandle } from '../session/session-handle-types';
import type { FreshAttemptHandoffArtifact } from './handoff-artifact';

/**
 * COR-1354 (COR-894's decision) — the three ways an attempt may obtain its
 * conversation, each bound to exactly one construction path:
 *
 * - `continue`: this session, its stored history appended to in place
 *   (`SessionHandle.run()`).
 * - `fork-from-baseline`: `SessionHandle.fork()`, a new session holding a
 *   verbatim copy of the history — the latest stored history, or with
 *   `throughRun` the history at that terminal run's recorded boundary. An
 *   unusable fork point rejects with `ForkThroughRunError`.
 * - `fresh-from-artifact`: `SessionHandle.startFreshAttempt()`, a new session
 *   seeded only from approved instructions and a validated artifact.
 *
 * A call site that receives no policy continues, which is what every call
 * site did before policies existed.
 */
export type ConversationPolicy =
  | { readonly kind: 'continue' }
  | { readonly kind: 'fork-from-baseline'; readonly throughRun?: number | undefined }
  | { readonly kind: 'fresh-from-artifact'; readonly artifact: FreshAttemptHandoffArtifact };

export interface ApplyConversationPolicyOptions {
  /** Defaults to `{ kind: 'continue' }`. */
  readonly policy?: ConversationPolicy | undefined;
  /**
   * The approved instructions for the attempt. Only `fresh-from-artifact`
   * seeds them: a continued or forked conversation already carries its own.
   */
  readonly instructions: string;
}

/** Returns the session an attempt should run in under `options.policy`. */
export async function applyConversationPolicy(
  session: SessionHandle,
  options: ApplyConversationPolicyOptions,
): Promise<SessionHandle> {
  const policy = options.policy ?? { kind: 'continue' };
  if (policy.kind === 'fork-from-baseline') {
    const { throughRun } = policy;
    return session.fork(throughRun === undefined ? undefined : { throughRun });
  }
  if (policy.kind === 'fresh-from-artifact') {
    const { artifact } = policy;
    return session.startFreshAttempt({ artifact, instructions: options.instructions });
  }
  return session;
}
