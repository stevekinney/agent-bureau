/**
 * COR-851 — the conversations a durable goal's attempts run in.
 *
 * COR-638 gives a goal exactly one conversation policy, and the in-memory
 * controller honors it by driving a live `SessionHandle`. A durable goal has no
 * live handle that outlives a process, so Bureau keeps the same conversation in
 * the operative `SessionStore` instead, and each attempt is still a durable
 * catalog run under a deterministic run id. What the session adds is the seed:
 * an attempt after the first starts from `{ conversation }` rather than from a
 * bare prompt.
 *
 * - `continue`: every attempt runs in one session, the goal's trunk. A retry's
 *   seed is the trunk's history with the validator's feedback appended as the
 *   next user turn.
 * - `fork-from-baseline`: attempt 0 runs in the trunk. Before each retry a new
 *   session is forked from the trunk through the goal-declared baseline run
 *   (`throughRun`), never from the last attempt, so a retry sees the baseline
 *   transcript and the prompt with the feedback, and nothing a later attempt
 *   added.
 * - `fresh-from-artifact`: attempt 0 runs in the trunk. Every retry starts a
 *   brand-new session built from the approved instructions and the validated
 *   COR-894 handoff artifact, so it inherits no transcript.
 *
 * The turn each attempt receives is `goalAttemptInput` from operative, shared
 * with the in-memory controller so the two cannot drift.
 *
 * Session ids are deterministic (`goalSessionId`), and the run each attempt
 * adds to its session is keyed by the attempt's own deterministic run id, so
 * every step here is safe to repeat after a crash:
 *
 * - A fork or fresh session is created only when absent, from the same trunk
 *   (or artifact) every time, so a repeat reads back the session the first try
 *   wrote rather than writing a second.
 * - A run's seed is derived from stored sessions, never from the clock or a
 *   minted id, apart from the user turn's own message id. That id differs
 *   between two derivations of one seed, but only a seed that reaches a started
 *   workflow is ever used, and a started workflow is adopted, never re-seeded.
 * - `recordStart` upserts one `RunRef` per attempt run id, so a crash between
 *   the engine's start and this write, or the reverse, leaves at most one ref.
 * - `settle` commits a terminal run's transcript from the engine's checkpoint
 *   through operative's own `reconcileTerminalRunRef`, which does nothing for a
 *   ref that is already terminal. This is what writes the conversation
 *   boundary a later fork reads.
 *
 * A goal's sessions carry the goal's principal as their recorded authority, so
 * another principal cannot read or continue a goal's transcript through the
 * session verbs.
 *
 * Limits: a durable goal does not take a caller's existing session as its
 * baseline, so the trunk holds attempt 0 and nothing before it. For
 * `fork-from-baseline` the only run a retry can fork through is therefore run
 * 0, and `goals.create` rejects any other `throughRun` as
 * `invalid-configuration` rather than spend an attempt on a goal that could
 * never retry.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type AgentInput,
  type AgentSession,
  ATTEMPT_RUN_FAILURE_DETAIL,
  conversationThroughRun,
  createAgentSession,
  createFreshAttemptSession,
  type DurableActiveRunContext,
  ForkThroughRunError,
  FreshAttemptArtifactError,
  type FreshAttemptSourceResolver,
  goalAttemptInput,
  type JSONValue,
  reconcileTerminalRunRef,
  type RunRef,
  type SessionStore,
} from '@lostgradient/operative';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
} from 'conversationalist';

import { attemptSessionId, goalAttemptRunId, goalSessionId, type GoalState } from './goal-state';

/** A session the goal depends on is not in the state its own earlier writes left it in. */
export class GoalConversationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalConversationError';
  }
}

export interface GoalConversationDependencies {
  readonly sessionStore: SessionStore;
  readonly runtime: RuntimeServices;
  readonly getDurable: () => DurableActiveRunContext | undefined;
  /** Without one, a `fresh-from-artifact` attempt cannot authorize its artifact and the goal ends. */
  readonly resolveFreshAttemptSource: FreshAttemptSourceResolver | undefined;
}

export interface AttemptSeatRequest {
  readonly attemptIndex: number;
  readonly runId: string;
  /** The validator's feedback from the attempt before; absent for attempt 0. */
  readonly feedback?: string | undefined;
}

export type AttemptSeat =
  | { readonly status: 'seated'; readonly sessionId: string; readonly input: AgentInput }
  /** The policy could not seed this attempt; the goal ends with this `failureDetail`. */
  | { readonly status: 'failed'; readonly detail: string };

export interface GoalConversations {
  /** Resolves the session and the input for one attempt, creating the session when a retry needs a new one. */
  seat(record: GoalState, request: AttemptSeatRequest): Promise<AttemptSeat>;
  /**
   * Whether the session this attempt runs in, if one already exists, is the
   * goal's own. Answers why not when it is not, and `undefined` when the
   * session is absent or the goal's.
   */
  verify(record: GoalState, attemptIndex: number): Promise<string | undefined>;
  /** Records the attempt's run in its session. Idempotent per run id. */
  recordStart(record: GoalState, request: AttemptSeatRequest): Promise<void>;
  /** Commits a terminal attempt's transcript to its session. A no-op for a run that has not ended. */
  settle(record: GoalState, attemptIndex: number, runId: string): Promise<void>;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Why a session found under one of the goal's deterministic ids is not the
 * goal's, or `undefined` when it is. A session id is a function of a
 * caller-chosen goal id, so another caller's session can already hold it. The
 * goal's own writes record its `goalRunId` and its principal's authority in the
 * session, and only the goal's own attempt runs in it.
 */
export function foreignSessionReason(record: GoalState, session: AgentSession): string | undefined {
  const refuse = (why: string): string =>
    `Session "${session.id}" ${why}, so goal "${record.goalRunId}" will not use it.`;
  if (session.metadata['goalRunId'] !== record.goalRunId) {
    return refuse('was not created for this goal');
  }
  const authority = session.metadata['lastRequestAuthority'];
  const principalId =
    typeof authority === 'object' && authority !== null && !Array.isArray(authority)
      ? (authority as Record<string, unknown>)['principalId']
      : undefined;
  if (principalId !== record.principal) return refuse('belongs to a different principal');
  // A goal runs one agent, and its session carries that agent's name. A session
  // under the goal's id for any other agent is not the goal's conversation.
  if (session.agentName !== record.objective.agentName) {
    return refuse('belongs to a different agent');
  }
  // The exact id the goal derives for an attempt it can have, never a pattern
  // that merely resembles one: `goal-g1-a00` and an index past `maximumAttempts`
  // are ids the goal never mints.
  const runPrefix = goalAttemptRunId(record.goalRunId, 0).slice(0, -1);
  const isAttemptRun = (runId: string): boolean => {
    if (!runId.startsWith(runPrefix)) return false;
    const suffix = runId.slice(runPrefix.length);
    if (!/^\d+$/.test(suffix)) return false;
    const attemptIndex = Number(suffix);
    return (
      attemptIndex < record.bounds.maximumAttempts &&
      goalAttemptRunId(record.goalRunId, attemptIndex) === runId
    );
  };
  if (!session.runs.every((ref) => isAttemptRun(ref.runId))) {
    return refuse("holds a run that is not one of this goal's attempts");
  }
  // Each of those runs is the goal's own agent's too: a ref the goal's start
  // wrote carries the agent it ran, and one for any other agent is not its.
  if (!session.runs.every((ref) => ref.agentName === record.objective.agentName)) {
    return refuse('holds a run of a different agent');
  }
  return undefined;
}

/**
 * The metadata every session of a goal carries: the goal that created it, which
 * is what lets the goal recognize it again, and the authority that keeps the
 * transcript with the goal's principal.
 */
export function goalSessionMetadata(record: GoalState): Record<string, JSONValue> {
  return {
    goalRunId: record.goalRunId,
    ...(record.principal === undefined
      ? {}
      : {
          lastRequestAuthority: {
            principalId: record.principal,
            tenantId: 'bureau',
            ownerId: record.objective.agentName,
            capabilities: ['tools:execute'],
            authorizationRevision: 'bureau:1',
          },
        }),
  };
}

export function createGoalConversations(
  dependencies: GoalConversationDependencies,
): GoalConversations {
  const { sessionStore, runtime, getDurable, resolveFreshAttemptSource } = dependencies;

  function emptySession(record: GoalState, sessionId: string): AgentSession {
    return createAgentSession({
      agentName: record.objective.agentName,
      conversationHistory: createConversationHistory(undefined, { runtime }),
      id: sessionId,
      metadata: goalSessionMetadata(record),
      runtime,
    });
  }

  /** Writes `candidate` under its id only when nothing is there, and answers what is stored. */
  async function createOnce(record: GoalState, candidate: AgentSession): Promise<AgentSession> {
    const stored = await sessionStore.update(candidate.id, (existing) =>
      existing === undefined ? candidate : undefined,
    );
    const session = stored ?? (await sessionStore.load(candidate.id));
    if (session === undefined) {
      // Neither written nor readable back: the store lagging or failing, not a
      // conversation policy the goal violated. A plain error, so the activity
      // retries instead of ending the goal.
      throw new Error(`Session "${candidate.id}" could not be created.`);
    }
    return owned(record, session);
  }

  /** The session, once it is proved to be the goal's; a foreign one is refused, never used. */
  function owned(record: GoalState, session: AgentSession): AgentSession {
    const foreign = foreignSessionReason(record, session);
    if (foreign !== undefined) throw new GoalConversationError(foreign);
    return session;
  }

  async function settle(record: GoalState, attemptIndex: number, runId: string): Promise<void> {
    const sessionId = attemptSessionId(
      record.goalRunId,
      record.conversationPolicy.kind,
      attemptIndex,
    );
    // A ref the attempt's start never got to write is written now, so a ref
    // that cannot be found is never what ends a goal.
    await recordStart(record, { attemptIndex, runId });
    const loaded = await sessionStore.load(sessionId);
    const session = loaded === undefined ? undefined : owned(record, loaded);
    const ref = session?.runs.find((candidate) => candidate.runId === runId);
    // `recordStart` has just written this ref, so one that is not there is a
    // store that lags or fails, not a transcript with nothing to commit: returning
    // would tell the caller it is committed. The activity retries the read.
    if (ref === undefined) {
      throw new Error(
        `The run "${runId}" of session "${sessionId}" cannot be read back to commit its transcript.`,
      );
    }
    if (ref.status !== 'running') return;
    const durable = getDurable();
    // Returning here would read as a transcript committed: the forwarder would
    // then tell the controller the attempt ended without it.
    if (durable === undefined) {
      throw new Error(
        `The bureau has no durable engine to read attempt ${attemptIndex}'s transcript with.`,
      );
    }
    // A transcript that cannot be read is an error to retry, never a ref
    // recorded as ended without it: a terminal ref is not reconciled again,
    // so the next attempt would be seeded without this one.
    await reconcileTerminalRunRef(
      sessionStore,
      durable.engine,
      durable.checkpointStore,
      sessionId,
      ref,
      { requireConversation: true },
    );
  }

  /** The trunk with attempt `attemptIndex`'s transcript committed, or an error if it cannot be. */
  async function committedTrunk(record: GoalState, attemptIndex: number): Promise<AgentSession> {
    const trunkId = goalSessionId(record.goalRunId, 0);
    const runId = goalAttemptRunId(record.goalRunId, attemptIndex);
    await settle(record, attemptIndex, runId);
    const loadedTrunk = await sessionStore.load(trunkId);
    const trunk = loadedTrunk === undefined ? undefined : owned(record, loadedTrunk);
    const ref = trunk?.runs.find((candidate) => candidate.runId === runId);
    if (trunk === undefined || ref === undefined) {
      throw new GoalConversationError(
        `Session "${trunkId}" has no record of attempt ${attemptIndex}'s run.`,
      );
    }
    // Not a verdict on the goal: the engine said the run ended before the
    // controller was told, so a run still open here is a read that failed or
    // lagged, and the activity retries it.
    // A completed run is owed a transcript. One that has none was recorded by a
    // read that failed, and seeding from it would drop the attempt.
    if (
      ref.status === 'running' ||
      (ref.status === 'completed' && ref.conversationBoundary === undefined)
    ) {
      throw new Error(
        `Attempt ${attemptIndex} has not committed its transcript to session "${trunkId}".`,
      );
    }
    return trunk;
  }

  async function seedHistory(
    record: GoalState,
    request: AttemptSeatRequest,
    sessionId: string,
  ): Promise<ConversationHistory> {
    const policy = record.conversationPolicy;
    if (policy.kind === 'continue') {
      const trunk = await committedTrunk(record, request.attemptIndex - 1);
      return trunk.conversationHistory;
    }
    // A session an earlier try wrote is the seed, whatever has become of what
    // it was built from: the artifact's retention window may have passed, or its
    // source gone, in the time a crash and a recovery took.
    const written = await sessionStore.load(sessionId);
    if (written !== undefined) return owned(record, written).conversationHistory;
    if (policy.kind === 'fork-from-baseline') {
      // The baseline is a run of the trunk, which is committed once attempt 0 ends.
      const trunk = await committedTrunk(record, 0);
      const forked = createAgentSession({
        agentName: trunk.agentName,
        conversationHistory: conversationThroughRun(trunk, policy.throughRun),
        id: sessionId,
        runs: [],
        metadata: goalSessionMetadata(record),
        runtime,
      });
      const stored = await createOnce(record, forked);
      return stored.conversationHistory;
    }
    const fresh = await createFreshAttemptSession({
      artifact: policy.artifact,
      instructions: record.objective.instructions ?? '',
      agentName: record.objective.agentName,
      runtime,
      resolveSource: resolveFreshAttemptSource ?? (() => undefined),
    });
    const session: AgentSession = {
      ...fresh,
      id: sessionId,
      metadata: { ...fresh.metadata, ...goalSessionMetadata(record) },
    };
    const stored = await createOnce(record, session);
    return stored.conversationHistory;
  }

  async function verify(record: GoalState, attemptIndex: number): Promise<string | undefined> {
    const sessionId = attemptSessionId(
      record.goalRunId,
      record.conversationPolicy.kind,
      attemptIndex,
    );
    const existing = await sessionStore.load(sessionId);
    return existing === undefined ? undefined : foreignSessionReason(record, existing);
  }

  async function seat(record: GoalState, request: AttemptSeatRequest): Promise<AttemptSeat> {
    const { kind } = record.conversationPolicy;
    const sessionId = attemptSessionId(record.goalRunId, kind, request.attemptIndex);
    const turn = goalAttemptInput(
      kind,
      record.objective.prompt,
      request.attemptIndex,
      request.feedback,
    );
    // The first attempt runs the prompt as written, so the agent's own
    // instructions frame its conversation, exactly as in memory.
    if (request.attemptIndex === 0) {
      const foreign = await verify(record, 0);
      return foreign === undefined
        ? { status: 'seated', sessionId, input: turn }
        : { status: 'failed', detail: ATTEMPT_RUN_FAILURE_DETAIL.conversationPolicy(foreign) };
    }

    try {
      const history = await seedHistory(record, request, sessionId);
      const conversation = new Conversation(structuredClone(history), { runtime });
      conversation.appendUserMessage(turn);
      return { status: 'seated', sessionId, input: { conversation: conversation.current } };
    } catch (error) {
      // A fork point or artifact the policy rejects ends the goal, as it does in
      // memory. Anything else is the store or engine failing, which the activity
      // retries rather than ending the goal over.
      if (
        error instanceof ForkThroughRunError ||
        error instanceof FreshAttemptArtifactError ||
        error instanceof GoalConversationError
      ) {
        return {
          status: 'failed',
          detail: ATTEMPT_RUN_FAILURE_DETAIL.conversationPolicy(describe(error)),
        };
      }
      throw error;
    }
  }

  async function recordStart(record: GoalState, request: AttemptSeatRequest): Promise<void> {
    const sessionId = attemptSessionId(
      record.goalRunId,
      record.conversationPolicy.kind,
      request.attemptIndex,
    );
    await sessionStore.update(sessionId, (existing) => {
      if (existing !== undefined) owned(record, existing);
      const session = existing ?? emptySession(record, sessionId);
      if (session.runs.some((ref) => ref.runId === request.runId)) {
        return existing === undefined ? session : undefined;
      }
      const ref: RunRef = {
        runId: request.runId,
        sequence: session.runs.length,
        status: 'running',
        startedAt: runtime.clock.nowISO(),
        agentName: record.objective.agentName,
      };
      return { ...session, runs: [...session.runs, ref] };
    });
  }

  return { seat, verify, recordStart, settle };
}
