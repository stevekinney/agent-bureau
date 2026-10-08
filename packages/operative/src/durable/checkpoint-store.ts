import type { TextValueStore } from '@lostgradient/weft';
import type { ConversationSnapshot } from 'conversationalist';

import type { RunCheckpoint, RunCursor, StepRecord } from './types';

/**
 * A run id is caller-chosen (a child run, a goal's attempt), and the key
 * layout below separates its parts with `:`. An unencoded id containing `:`
 * would put one run's keys inside another run's prefix (`x-a0:step:q`'s cursor
 * under `x-a0`'s step prefix), so `loadSteps` would read it as a step and
 * `clear` would delete it. `:` and `%` are escaped, which is injective and
 * leaves every ordinary id (no `:`, no `%`) exactly as it was.
 */
function encodeRunId(runId: string): string {
  return runId.replaceAll('%', '%25').replaceAll(':', '%3A');
}

/**
 * Key layout for durable run checkpoints. All keys are namespaced under
 * `durable-run:{runId}:` so a single backing store can hold many runs alongside
 * sessions, cache, and identity data without collision.
 */
const keys = {
  prefix: (runId: string) => `durable-run:${encodeRunId(runId)}:`,
  cursor: (runId: string) => `${keys.prefix(runId)}cursor`,
  transcript: (runId: string) => `${keys.prefix(runId)}transcript`,
  stepPrefix: (runId: string) => `${keys.prefix(runId)}step:`,
  /** Steps are zero-padded so lexicographic `list()` order matches step order. */
  step: (runId: string, step: number) =>
    `${keys.stepPrefix(runId)}${String(step).padStart(10, '0')}`,
};

/**
 * Operative 0.15.x wrote the run id verbatim: `durable-run:{runId}:{part}`.
 * Session run ids (`${sessionId}:${sequence}`) contain `:`, so 0.16.0 reads
 * those keys as a fallback whenever escaping changed the id. Writes never use
 * this layout.
 */
const legacyKeys = {
  prefix: (runId: string) => `durable-run:${runId}:`,
  cursor: (runId: string) => `${legacyKeys.prefix(runId)}cursor`,
  transcript: (runId: string) => `${legacyKeys.prefix(runId)}transcript`,
  stepPrefix: (runId: string) => `${legacyKeys.prefix(runId)}step:`,
};

/**
 * Whether the run id has 0.15.x keys to fall back to: escaping changed its
 * keys, and its verbatim prefix is not some other run's current prefix. An
 * id that is itself a complete escaping of a different id (no `:`, and every
 * `%` begins `%25` or `%3A`, such as `a%3Ab` for run `a:b`) would read that
 * run's keys, so it gets no fallback. Session run ids (`${sessionId}:${n}`)
 * and ids like `job%one` keep theirs.
 */
function hasLegacyKeys(runId: string): boolean {
  if (encodeRunId(runId) === runId) return false;
  const isEscapingOfAnotherId = !runId.includes(':') && /^(?:[^%]|%25|%3A)*$/.test(runId);
  return !isEscapingOfAnotherId;
}

/** A step number in a key: `String(step).padStart(10, '0')`, which never truncates. */
const STEP_NUMBER = /^\d{10,}$/;

/** Numeric order for zero-padded step numbers of any width. */
function compareStepNumbers(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The step keys under `stepPrefix`, keyed by their step number (ten or more digits). The
 * unescaped layout is ambiguous (run `x-a0:step:q`'s keys sit under run
 * `x-a0`'s step prefix), so a key whose remainder is anything but exactly a
 * step number belongs to another run and is not a step.
 */
function stepKeysByNumber(keysUnderPrefix: string[], stepPrefix: string): Map<string, string> {
  const byNumber = new Map<string, string>();
  for (const key of keysUnderPrefix) {
    const stepNumber = key.slice(stepPrefix.length);
    if (STEP_NUMBER.test(stepNumber)) byNumber.set(stepNumber, key);
  }
  return byNumber;
}

/**
 * Options for the checkpoint reads. With `strict`, persisted data that is
 * present but malformed rejects instead of reading as absent (a cursor or
 * transcript) or being skipped (a step record). A key that is genuinely absent
 * still reads as absent, so a run with no checkpoint yet is not an error.
 */
export interface CheckpointReadOptions {
  readonly strict?: boolean;
}

/**
 * A durable store for agent-run checkpoints, backed by a Weft
 * {@link TextValueStore}. Persists three independent pieces per run:
 *
 * - the {@link RunCursor} (`{ step }`) — the minimal resume position,
 * - a {@link ConversationSnapshot} of the run transcript (plain, cloneable),
 * - one {@link StepRecord} per completed step (no `Conversation` instance).
 *
 * Splitting them lets the durable workflow commit the cheap cursor at every
 * yield while writing the heavier transcript only at step boundaries.
 */
export interface CheckpointStore {
  saveCursor(runId: string, cursor: RunCursor): Promise<void>;
  loadCursor(runId: string, options?: CheckpointReadOptions): Promise<RunCursor | null>;
  saveConversation(runId: string, snapshot: ConversationSnapshot): Promise<void>;
  loadConversation(
    runId: string,
    options?: CheckpointReadOptions,
  ): Promise<ConversationSnapshot | null>;
  saveStep(runId: string, record: StepRecord): Promise<void>;
  loadSteps(runId: string, options?: CheckpointReadOptions): Promise<StepRecord[]>;
  /** Assemble the full checkpoint from its persisted pieces. */
  loadCheckpoint(runId: string, options?: CheckpointReadOptions): Promise<RunCheckpoint>;
  /** Remove every key for a run. Returns the number of keys deleted. */
  clear(runId: string): Promise<number>;
}

/**
 * Parse JSON, returning `null` on malformed data rather than throwing. In
 * strict mode malformed data throws, naming the key; an absent key is still
 * `null`.
 */
function parseJson(raw: string | null, strictKey?: string): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (cause) {
    if (strictKey !== undefined) {
      throw new Error(`Persisted checkpoint data at "${strictKey}" is malformed JSON.`, { cause });
    }
    return null;
  }
}

/** The strict key to report, or `undefined` for the tolerant read. */
function strictKeyFor(options: CheckpointReadOptions | undefined, key: string): string | undefined {
  return options?.strict === true ? key : undefined;
}

/** The keys under `prefix` that are exactly this run's cursor, transcript, or step records. */
function ownKeys(keysUnderPrefix: string[], prefix: string): string[] {
  return keysUnderPrefix.filter((key) => {
    const part = key.slice(prefix.length);
    return (
      part === 'cursor' ||
      part === 'transcript' ||
      (part.startsWith('step:') && STEP_NUMBER.test(part.slice('step:'.length)))
    );
  });
}

/**
 * Creates a {@link CheckpointStore} backed by the given {@link TextValueStore}.
 *
 * Values are JSON-serialized strings; the store treats them as opaque, matching
 * how every other agent-bureau persistence layer (sessions, identity, skills)
 * uses the text-value surface.
 */
export function createCheckpointStore(store: TextValueStore): CheckpointStore {
  /**
   * Reads a cursor or transcript. The escaped key wins when present; a run id
   * that has a legacy key falls back to it only when the escaped key is absent.
   */
  async function readPart(
    key: string,
    legacyKey: string | undefined,
    options?: CheckpointReadOptions,
  ) {
    const raw = await store.get(key);
    if (raw !== null || legacyKey === undefined) return parseJson(raw, strictKeyFor(options, key));
    return parseJson(await store.get(legacyKey), strictKeyFor(options, legacyKey));
  }

  const checkpointStore: CheckpointStore = {
    async saveCursor(runId, cursor) {
      await store.set(keys.cursor(runId), JSON.stringify(cursor));
    },

    async loadCursor(runId, options) {
      const cursor = (await readPart(
        keys.cursor(runId),
        hasLegacyKeys(runId) ? legacyKeys.cursor(runId) : undefined,
        options,
      )) as RunCursor | null;
      // A cursor persisted before AB-221 added `lastAppliedConfigVersion` to
      // `RunCursor` deserializes with every OTHER field present but that one
      // `undefined` — `parseJson` casts the stored JSON to `RunCursor`
      // without validating it, so nothing else catches this. Left as-is,
      // `undefined` would leak into the durable driver's `RunState` and
      // `run-step.ts`'s `state.configVersion !== runState.lastAppliedConfigVersion`
      // dedupe check, treating every `configVersion` (including 0, the
      // un-steered default) as novel and misfiring `steering.applied`.
      // Normalized here, in the one place a persisted cursor is deserialized
      // (both this method's direct callers and `loadCheckpoint`, which calls
      // this), rather than pushing the same `?? 0` into every reader.
      return cursor
        ? { ...cursor, lastAppliedConfigVersion: cursor.lastAppliedConfigVersion ?? 0 }
        : null;
    },

    async saveConversation(runId, snapshot) {
      await store.set(keys.transcript(runId), JSON.stringify(snapshot));
    },

    async loadConversation(runId, options) {
      return (await readPart(
        keys.transcript(runId),
        hasLegacyKeys(runId) ? legacyKeys.transcript(runId) : undefined,
        options,
      )) as ConversationSnapshot | null;
    },

    async saveStep(runId, record) {
      await store.set(keys.step(runId, record.step), JSON.stringify(record));
    },

    async loadSteps(runId, options) {
      const stepPrefix = keys.stepPrefix(runId);
      const byNumber = stepKeysByNumber(await store.list(stepPrefix), stepPrefix);
      if (hasLegacyKeys(runId)) {
        // A run started on 0.15.x and resumed on 0.16.0 has steps in both
        // layouts. The escaped record wins a duplicate step number.
        const legacyPrefix = legacyKeys.stepPrefix(runId);
        const legacy = stepKeysByNumber(await store.list(legacyPrefix), legacyPrefix);
        for (const [stepNumber, key] of legacy) {
          if (!byNumber.has(stepNumber)) byNumber.set(stepNumber, key);
        }
      }
      const stepKeys = [...byNumber.entries()]
        .toSorted(([left], [right]) => compareStepNumbers(left, right))
        .map(([, key]) => key);
      const records: StepRecord[] = [];
      for (const key of stepKeys) {
        const record = parseJson(
          await store.get(key),
          strictKeyFor(options, key),
        ) as StepRecord | null;
        if (record) records.push(record);
      }
      return records;
    },

    async loadCheckpoint(runId, options) {
      const [cursor, conversation, steps] = await Promise.all([
        checkpointStore.loadCursor(runId, options),
        checkpointStore.loadConversation(runId, options),
        checkpointStore.loadSteps(runId, options),
      ]);
      return {
        runId,
        // `loadCursor` already normalizes a persisted-but-incomplete cursor
        // (a pre-AB-221 `RunCursor` missing `lastAppliedConfigVersion`); a
        // missing cursor (no run persisted yet) gets the full zeroed default.
        cursor: cursor ?? {
          step: 0,
          totalUsage: { prompt: 0, completion: 0, total: 0 },
          lastContent: '',
          schemaAttempts: 0,
          lastAppliedConfigVersion: 0,
        },
        conversation,
        steps,
      };
    },

    async clear(runId) {
      // Exact keys only, never a prefix wipe: 0.15.x wrote ids verbatim, so a
      // prefix such as `durable-run:x-a0:` can also hold run `x-a0:step:q`'s
      // legacy keys, whichever layout `x-a0` itself uses.
      const doomed = ownKeys(await store.list(keys.prefix(runId)), keys.prefix(runId));
      if (hasLegacyKeys(runId)) {
        const legacyPrefix = legacyKeys.prefix(runId);
        doomed.push(...ownKeys(await store.list(legacyPrefix), legacyPrefix));
      }
      for (const key of doomed) await store.delete(key);
      return doomed.length;
    },
  };

  return checkpointStore;
}
