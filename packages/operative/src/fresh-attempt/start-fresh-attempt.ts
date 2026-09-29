import type { RuntimeServices } from '@lostgradient/lifecycle';
import { Conversation, createConversationHistory } from 'conversationalist';

import type { AgentSession } from '../agent-session';
import { createAgentSession } from '../agent-session';
import { renderFreshAttemptHandoff } from './render';
import type { FreshAttemptSourceResolver } from './validate';
import { validateFreshAttemptArtifact } from './validate';

export interface CreateFreshAttemptSessionOptions {
  /** Validated here, before anything is minted or constructed. */
  readonly artifact: unknown;
  /** The approved instructions the fresh conversation starts from. */
  readonly instructions: string;
  readonly agentName: string;
  readonly runtime: RuntimeServices;
  readonly resolveSource: FreshAttemptSourceResolver;
}

/**
 * COR-1354 — builds, but does not persist, the session a `fresh-from-artifact`
 * policy starts. The id is minted the way `fork()` mints one, but where a fork
 * copies the source history verbatim, this starts from an empty history seeded
 * with exactly two messages: the approved instructions and one rendering of
 * the validated artifact. No source `Message` is read, so none can be copied.
 */
export async function createFreshAttemptSession(
  options: CreateFreshAttemptSessionOptions,
): Promise<AgentSession> {
  const { runtime } = options;
  const validated = await validateFreshAttemptArtifact(options.artifact, {
    resolveSource: options.resolveSource,
    now: runtime.clock.now(),
  });
  const { artifact } = validated;

  const conversation = new Conversation(createConversationHistory(undefined, { runtime }), {
    runtime,
  });
  conversation.appendSystemMessage(options.instructions);
  conversation.appendUserMessage(renderFreshAttemptHandoff(validated), {
    freshAttemptArtifactId: artifact.artifactId,
    freshAttemptArtifactRevision: artifact.revision,
  });

  return createAgentSession({
    agentName: options.agentName,
    conversationHistory: conversation.current,
    id: runtime.identifiers.next('session'),
    runs: [],
    metadata: {
      freshAttempt: {
        artifactId: artifact.artifactId,
        revision: artifact.revision,
        digest: artifact.digest.value,
        sourceSessionId: artifact.sourceRunOrAttempt.sessionId,
        sourceRunId: artifact.sourceRunOrAttempt.runId,
      },
    },
    runtime,
  });
}
