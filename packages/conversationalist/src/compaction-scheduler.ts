import {
  createTimerCompactionSchedule,
  type CompactionScheduleAdapter,
  type CompactionScheduleCancel,
} from './compaction-schedule';
import type {
  CompactionAttempt,
  CompactionOptions,
  ConversationCompactionResult,
  Summarizer,
} from './compaction/types';
import { createInvalidInputError } from './errors';
import type { Conversation } from './history';

/**
 * Where the scheduler's current (or most recent) request stands.
 *
 * - `idle`: nothing has been requested yet.
 * - `pending`: queued with the schedule adapter, waiting for its window
 *   (and, after a cancellation, for the abandoned candidate to return), or
 *   waiting for the conversation to reach a durable boundary. A stale
 *   candidate that is being rescheduled is `pending` again.
 * - `running`: a candidate is being prepared by `Conversation.compact()`.
 * - `committed` / `no-op` / `discarded`: the request settled with that
 *   compaction outcome. `discarded` means every candidate the stale-retry
 *   bound allowed went stale.
 * - `cancelled` / `failed`: the request settled without publishing anything.
 */
export type CompactionSchedulerPhase =
  'idle' | 'pending' | 'running' | 'committed' | 'no-op' | 'discarded' | 'cancelled' | 'failed';

/** Running totals across every request this scheduler has served. */
export interface CompactionSchedulerCounts {
  /** Requests that started a new job (a request that joins a queued or running job is not counted). */
  readonly requested: number;
  /** Candidates handed to `Conversation.compact()`. */
  readonly candidates: number;
  readonly committed: number;
  readonly noOp: number;
  /** Stale candidates `Conversation.compact()` discarded, whether or not they were rescheduled. */
  readonly discarded: number;
  /** Stale candidates that were queued again under the stale-retry bound. */
  readonly rescheduled: number;
  /**
   * Windows that opened away from a durable boundary — a stream open or a
   * tool call pending — and so waited for one instead of starting a candidate.
   */
  readonly deferred: number;
  readonly cancelled: number;
  readonly failed: number;
}

/**
 * A frozen snapshot of the scheduler. It is the scheduler's own record: it
 * is readable at any moment and never depends on conversation events.
 */
export interface CompactionSchedulerState {
  readonly phase: CompactionSchedulerPhase;
  /** `true` once the scheduler, or the conversation it compacts, is disposed or closed. */
  readonly disposed: boolean;
  /** 1-based candidate number within the current or most recent request; `0` before its first candidate. */
  readonly candidate: number;
  /** The attempt record `Conversation.compact()` returned for the most recent candidate that settled with a result. */
  readonly attempt?: CompactionAttempt | undefined;
  readonly counts: CompactionSchedulerCounts;
}

/**
 * Why a request settled `cancelled`: `cancel()` was called, a request
 * signal aborted (run cancellation), or the scheduler or its conversation
 * was disposed or closed.
 */
export type CompactionCancelReason = 'cancelled' | 'signal' | 'disposed';

type SettledCompaction<Outcome extends ConversationCompactionResult['outcome']> = {
  readonly outcome: Outcome;
  readonly result: Extract<ConversationCompactionResult, { outcome: Outcome }>;
  /** Candidates this request ran. */
  readonly candidates: number;
};

/** How one background compaction request settled. It never rejects. */
export type CompactionSchedulerOutcome =
  | SettledCompaction<'committed'>
  | SettledCompaction<'no-op'>
  | SettledCompaction<'discarded'>
  | {
      readonly outcome: 'cancelled';
      readonly reason: CompactionCancelReason;
      readonly candidates: number;
    }
  | { readonly outcome: 'failed'; readonly error: unknown; readonly candidates: number };

export interface CompactionSchedulerOptions {
  readonly summarizer: Summarizer;
  /** Forwarded to every `Conversation.compact()` candidate. The scheduler owns the signal. */
  readonly compaction?: Omit<CompactionOptions, 'signal'> | undefined;
  /**
   * When queued work runs. Default: {@link createTimerCompactionSchedule}, a
   * zero-delay timer that works on Bun, Node, and browsers. Pass
   * `createIdleCompactionSchedule()` to use browser idle time instead.
   */
  readonly schedule?: CompactionScheduleAdapter | undefined;
  /**
   * How many times one request reschedules a stale candidate before it
   * settles `discarded`. Each reschedule waits for a new window from the
   * schedule adapter; nothing is retried inline and nothing is rebased.
   * One request therefore runs at most `maxStaleRetries + 1` candidates.
   * Default: {@link DEFAULT_MAX_STALE_RETRIES}.
   */
  readonly maxStaleRetries?: number | undefined;
}

export interface CompactionRequestOptions {
  /**
   * Cancels this request's job when it aborts — the way an agent run's
   * cancellation withdraws background work it asked for. When several
   * requests share one job, an abort from any of them cancels it.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Prepares compaction for one conversation off the caller's critical path.
 *
 * Idle scheduling is only a *when*: it is neither persistence nor ownership
 * of the conversation. The scheduler publishes nothing itself — every
 * candidate is `Conversation.compact()`, which commits only by
 * compare-and-swap against the revision it captured, so a candidate that a
 * newer write overtook is discarded and the newer history stays as it is.
 */
export interface CompactionScheduler {
  readonly conversation: Conversation;
  readonly state: CompactionSchedulerState;
  /**
   * Queues a compaction, or joins the one already queued or running, and
   * returns how it settles. Never runs the summarizer synchronously.
   */
  request(options?: CompactionRequestOptions): Promise<CompactionSchedulerOutcome>;
  /**
   * Withdraws queued work and aborts a running candidate. A candidate whose
   * summarizer ignores the abort still cannot publish, and its request
   * settles `cancelled` once that summarizer returns. Resolves once the
   * candidate in flight at the time of the call, if any, has settled, so a
   * caller that awaits it can start its own summary without overlapping
   * this one. The scheduler stays usable.
   */
  cancel(): Promise<void>;
  /** Calls `listener` with every new state. Returns the unsubscribe function. */
  subscribe(listener: (state: CompactionSchedulerState) => void): () => void;
  /**
   * Cancels queued and running work, refuses later requests, and resolves
   * once the running candidate, if any, has settled.
   */
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** The default stale-retry bound: up to three candidates per request. */
export const DEFAULT_MAX_STALE_RETRIES = 2;

type MutableCounts = { -readonly [Key in keyof CompactionSchedulerCounts]: number };

type Job = {
  readonly promise: Promise<CompactionSchedulerOutcome>;
  readonly resolve: (outcome: CompactionSchedulerOutcome) => void;
  readonly controller: AbortController;
  /** Requester signals already attached, so a repeated requester adds no listener. */
  readonly signals: Set<AbortSignal>;
  readonly detach: (() => void)[];
  /** Withdraws the queued window, or stops waiting for a durable boundary. */
  cancelQueued: CompactionScheduleCancel | undefined;
  cancelReason: CompactionCancelReason | undefined;
  candidates: number;
  running: boolean;
  settled: boolean;
};

const initialState: CompactionSchedulerState = Object.freeze({
  phase: 'idle',
  disposed: false,
  candidate: 0,
  counts: Object.freeze({
    requested: 0,
    candidates: 0,
    committed: 0,
    noOp: 0,
    discarded: 0,
    rescheduled: 0,
    deferred: 0,
    cancelled: 0,
    failed: 0,
  }),
});

class CompactionSchedulerStateEvent extends Event {
  readonly state: CompactionSchedulerState;

  constructor(state: CompactionSchedulerState) {
    super('state');
    this.state = state;
  }
}

class BackgroundCompactionScheduler implements CompactionScheduler {
  readonly conversation: Conversation;
  readonly #summarizer: Summarizer;
  readonly #compaction: Omit<CompactionOptions, 'signal'> | undefined;
  readonly #schedule: CompactionScheduleAdapter;
  readonly #maxStaleRetries: number;
  readonly #events = new EventTarget();
  readonly #onConversationClosed = (): void => {
    void this.dispose();
  };
  #state: CompactionSchedulerState = initialState;
  /** The job new requests join; `undefined` once it settles or starts cancelling. */
  #job: Job | undefined;
  /** The one candidate in flight. A later candidate waits for it, so summaries never overlap. */
  #inFlight: Promise<void> | undefined;

  constructor(conversation: Conversation, options: CompactionSchedulerOptions) {
    const maxStaleRetries = options.maxStaleRetries ?? DEFAULT_MAX_STALE_RETRIES;
    if (!Number.isSafeInteger(maxStaleRetries) || maxStaleRetries < 0) {
      throw createInvalidInputError('maxStaleRetries must be a non-negative integer', {
        maxStaleRetries,
      });
    }
    this.conversation = conversation;
    this.#summarizer = options.summarizer;
    this.#compaction = options.compaction;
    this.#schedule = options.schedule ?? createTimerCompactionSchedule();
    this.#maxStaleRetries = maxStaleRetries;
    if (conversation.lifecycle !== 'open') {
      this.#state = Object.freeze({ ...initialState, disposed: true });
      return;
    }
    conversation.addEventListener('controller.closed', this.#onConversationClosed);
    conversation.addEventListener('controller.disposed', this.#onConversationClosed);
  }

  get state(): CompactionSchedulerState {
    return this.#state;
  }

  request(options: CompactionRequestOptions = {}): Promise<CompactionSchedulerOutcome> {
    if (this.#state.disposed) return Promise.resolve(cancelled('disposed', 0));
    const { signal } = options;
    if (signal?.aborted) return Promise.resolve(cancelled('signal', 0));
    const job = this.#job ?? this.#startJob();
    if (signal && !job.settled && !job.signals.has(signal)) {
      job.signals.add(signal);
      const onAbort = (): void => this.#cancelJob(job, 'signal');
      signal.addEventListener('abort', onAbort, { once: true });
      job.detach.push(() => signal.removeEventListener('abort', onAbort));
    }
    return job.promise;
  }

  async cancel(): Promise<void> {
    if (this.#job) this.#cancelJob(this.#job, 'cancelled');
    await this.#inFlight;
  }

  subscribe(listener: (state: CompactionSchedulerState) => void): () => void {
    const handler = (event: Event): void => {
      listener((event as CompactionSchedulerStateEvent).state);
    };
    this.#events.addEventListener('state', handler);
    return () => this.#events.removeEventListener('state', handler);
  }

  async dispose(): Promise<void> {
    if (!this.#state.disposed) {
      this.conversation.removeEventListener('controller.closed', this.#onConversationClosed);
      this.conversation.removeEventListener('controller.disposed', this.#onConversationClosed);
      this.#update({ disposed: true });
      if (this.#job) this.#cancelJob(this.#job, 'disposed');
    }
    await this.#inFlight;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #startJob(): Job {
    let resolveJob!: (outcome: CompactionSchedulerOutcome) => void;
    const promise = new Promise<CompactionSchedulerOutcome>((resolve) => {
      resolveJob = resolve;
    });
    const job: Job = {
      promise,
      resolve: resolveJob,
      controller: new AbortController(),
      signals: new Set(),
      detach: [],
      cancelQueued: undefined,
      cancelReason: undefined,
      candidates: 0,
      running: false,
      settled: false,
    };
    this.#job = job;
    this.#update({ phase: 'pending', candidate: 0 }, { requested: 1 });
    this.#queue(job);
    return job;
  }

  #queue(job: Job): void {
    try {
      job.cancelQueued = this.#schedule.schedule(() => this.#run(job));
    } catch (error) {
      this.#settle(job, { outcome: 'failed', error, candidates: job.candidates });
    }
  }

  #run(job: Job): void {
    // A window can open after its task was withdrawn: an adapter whose
    // cancel lost the race with its own timer. Such a task does nothing.
    if (job.settled) return;
    job.cancelQueued = undefined;
    const inFlight = this.#inFlight;
    if (inFlight) {
      // A cancelled candidate whose summarizer ignored its signal is still
      // running. Wait for it rather than run two summaries at once.
      void inFlight.then(() => this.#run(job));
      return;
    }
    if (!this.#atDurableBoundary()) {
      this.#awaitDurableBoundary(job);
      return;
    }
    job.candidates += 1;
    job.running = true;
    this.#update({ phase: 'running', candidate: job.candidates }, { candidates: 1 });
    this.#inFlight = this.#attempt(job);
  }

  /**
   * Whether a candidate may start now: no stream is open and no tool call
   * waits for its result. Every streamed token moves the revision, so a
   * candidate started mid-stream would be discarded as stale, and one
   * started mid-tool-execution could summarize away a call whose result has
   * yet to arrive. Checking at candidate start is
   * enough: a stream or tool call that opens after the base revision is
   * captured moves the revision and makes the candidate stale.
   */
  #atDurableBoundary(): boolean {
    return (
      this.conversation.getStreamingMessage() === undefined &&
      this.conversation.getPendingToolCalls().length === 0
    );
  }

  /**
   * Holds the job, still `pending`, until a committed change reaches a
   * durable boundary, then queues a new window for it. It waits on the
   * conversation's own writes rather than polling windows, spends no
   * candidate and no stale retry, and is withdrawn like a queued window.
   */
  #awaitDurableBoundary(job: Job): void {
    const onChange = (): void => {
      if (!this.#atDurableBoundary()) return;
      stop();
      this.#queue(job);
    };
    const stop = (): void => this.conversation.removeEventListener('change', onChange);
    this.conversation.addEventListener('change', onChange);
    job.cancelQueued = stop;
    this.#update({}, { deferred: 1 });
  }

  /**
   * Runs one candidate. `compact()` captures its base revision synchronously,
   * inside the scheduler window that started it, before anything awaits.
   */
  async #attempt(job: Job): Promise<void> {
    let result: ConversationCompactionResult;
    try {
      result = await this.conversation.compact(this.#summarizer, {
        ...this.#compaction,
        signal: job.controller.signal,
      });
    } catch (error) {
      this.#inFlight = undefined;
      this.#onError(job, error);
      return;
    }
    this.#inFlight = undefined;
    this.#onResult(job, result);
  }

  #onResult(job: Job, result: ConversationCompactionResult): void {
    job.running = false;
    const candidates = job.candidates;
    const attempt = result.attempt;
    if (result.outcome === 'discarded') {
      this.#onDiscarded(job, result);
      return;
    }
    this.#settle(
      job,
      result.outcome === 'committed'
        ? { outcome: 'committed', result, candidates }
        : { outcome: 'no-op', result, candidates },
      { attempt },
    );
  }

  #onDiscarded(
    job: Job,
    result: Extract<ConversationCompactionResult, { outcome: 'discarded' }>,
  ): void {
    const candidates = job.candidates;
    const attempt = result.attempt;
    if (job.cancelReason) {
      this.#settle(
        job,
        { outcome: 'cancelled', reason: job.cancelReason, candidates },
        { attempt, increments: { discarded: 1 } },
      );
      return;
    }
    if (candidates > this.#maxStaleRetries) {
      this.#settle(job, { outcome: 'discarded', result, candidates }, { attempt });
      return;
    }
    this.#update({ phase: 'pending', attempt }, { discarded: 1, rescheduled: 1 });
    this.#queue(job);
  }

  #onError(job: Job, error: unknown): void {
    job.running = false;
    const candidates = job.candidates;
    if (job.cancelReason) {
      this.#settle(job, { outcome: 'cancelled', reason: job.cancelReason, candidates });
      return;
    }
    this.#settle(job, { outcome: 'failed', error, candidates });
  }

  #cancelJob(job: Job, reason: CompactionCancelReason): void {
    if (job.settled || job.cancelReason) return;
    job.cancelReason = reason;
    if (this.#job === job) this.#job = undefined;
    job.controller.abort(reason);
    // A running candidate settles the request itself once `compact()`
    // returns, so the outcome reports what actually happened. The abort
    // makes `compact()` refuse to publish a summary that returns after
    // this point; only a commit that already landed can still be reported.
    if (job.running) return;
    job.cancelQueued?.();
    this.#settle(job, { outcome: 'cancelled', reason, candidates: job.candidates });
  }

  #settle(
    job: Job,
    outcome: CompactionSchedulerOutcome,
    options: {
      readonly attempt?: CompactionAttempt | undefined;
      readonly increments?: Partial<CompactionSchedulerCounts> | undefined;
    } = {},
  ): void {
    job.settled = true;
    for (const detach of job.detach) detach();
    const key = countKey[outcome.outcome];
    const increments = { ...options.increments, [key]: (options.increments?.[key] ?? 0) + 1 };
    // A request that settles after a newer one began only adds to the
    // totals: the phase always describes the newest request.
    const current = this.#job === undefined || this.#job === job;
    if (this.#job === job) this.#job = undefined;
    this.#update(
      {
        ...(current ? { phase: outcome.outcome } : {}),
        ...(options.attempt ? { attempt: options.attempt } : {}),
      },
      increments,
    );
    job.resolve(outcome);
  }

  #update(
    patch: Partial<Omit<CompactionSchedulerState, 'counts'>>,
    increments: Partial<CompactionSchedulerCounts> = {},
  ): void {
    const counts: MutableCounts = { ...this.#state.counts };
    for (const [key, amount] of Object.entries(increments) as [
      keyof CompactionSchedulerCounts,
      number,
    ][]) {
      counts[key] += amount;
    }
    this.#state = Object.freeze({ ...this.#state, ...patch, counts: Object.freeze(counts) });
    this.#events.dispatchEvent(new CompactionSchedulerStateEvent(this.#state));
  }
}

const countKey = {
  committed: 'committed',
  'no-op': 'noOp',
  discarded: 'discarded',
  cancelled: 'cancelled',
  failed: 'failed',
} as const satisfies Record<CompactionSchedulerOutcome['outcome'], keyof CompactionSchedulerCounts>;

function cancelled(reason: CompactionCancelReason, candidates: number): CompactionSchedulerOutcome {
  return { outcome: 'cancelled', reason, candidates };
}

/**
 * Creates a background compaction scheduler for `conversation`.
 *
 * Stale-candidate policy: a candidate that a newer write overtook is
 * discarded by `Conversation.compact()` and rescheduled into a new window
 * from the schedule adapter, at most `maxStaleRetries` times per request
 * (default {@link DEFAULT_MAX_STALE_RETRIES}). After that the request
 * settles `discarded` and the next request starts a fresh budget. A stale
 * candidate is never rebased and never retried inline.
 *
 * Durable-boundary policy: a candidate starts only while no stream is open
 * and no tool call is pending. A window that opens elsewhere starts
 * nothing; the request stays `pending` until a committed change reaches
 * such a boundary, then queues a new window. That wait spends neither a
 * candidate nor a stale retry, and it is withdrawn like any queued work.
 *
 * Cancellation: `cancel()`, `dispose()`, an aborted request signal, and
 * closing or disposing the conversation all withdraw queued work and abort
 * the running candidate, so no summary returned after that point can
 * publish.
 */
export function createCompactionScheduler(
  conversation: Conversation,
  options: CompactionSchedulerOptions,
): CompactionScheduler {
  return new BackgroundCompactionScheduler(conversation, options);
}
