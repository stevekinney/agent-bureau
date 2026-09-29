import type { RuntimeClock } from '@lostgradient/lifecycle';
import type { ConditionalTextValueStore } from '@lostgradient/weft';

import {
  CorruptFreshAttemptArtifactError,
  InvalidFreshAttemptArtifactError,
  StaleFreshAttemptArtifactError,
} from './errors';
import type { FreshAttemptHandoffArtifact } from './handoff-artifact';
import {
  canonicalizeFreshAttemptValue,
  freshAttemptHandoffArtifactSchema,
} from './handoff-artifact';
import type { FreshAttemptSourceResolver } from './validate';
import { validateFreshAttemptArtifactForPublication } from './validate';

const HEAD_PREFIX = 'fresh-attempt-artifact:v1:head:';
const REVISION_PREFIX = 'fresh-attempt-artifact:v1:revision:';
// Zero-padded so `list()` returns a history in revision order lexicographically.
const REVISION_WIDTH = 16;

/**
 * COR-1354 — publication and read-back for fresh-attempt handoff artifacts.
 *
 * Writes mirror `SessionStore.update()`: load the latest revision, hand it to
 * an updater, and persist the updater's candidate with optimistic
 * concurrency. Unlike a session write, a conflict is never merged or retried.
 * A publication against a revision that is no longer current rejects with
 * `StaleFreshAttemptArtifactError`, and the caller reads the conflict and
 * either republishes against the new revision or gives up.
 *
 * Nothing is ever deleted. Retention decides whether an artifact may still
 * seed a fresh attempt, not whether its record survives: a failed attempt's
 * handoff stays in history for audit and evaluation.
 */
export interface FreshAttemptArtifactStore {
  /** The latest published revision, or `undefined` when none exists. */
  load(artifactId: string): Promise<FreshAttemptHandoffArtifact | undefined>;

  /** Every published revision, oldest first. */
  history(artifactId: string): Promise<FreshAttemptHandoffArtifact[]>;

  /**
   * Publishes the updater's candidate as the next revision. The candidate's
   * `revision` must be the latest revision plus one (1 for a first
   * publication). Every publish-time check runs before anything is written.
   * Returning `undefined` publishes nothing and resolves the latest revision.
   */
  update(
    artifactId: string,
    updater: (
      latest: FreshAttemptHandoffArtifact | undefined,
    ) => FreshAttemptHandoffArtifact | undefined | Promise<FreshAttemptHandoffArtifact | undefined>,
  ): Promise<FreshAttemptHandoffArtifact | undefined>;
}

export interface FreshAttemptArtifactStoreContext {
  readonly resolveSource: FreshAttemptSourceResolver;
  /** Read on every publish: a candidate dated after it is rejected as stale. */
  readonly clock: Pick<RuntimeClock, 'now'>;
}

function headKey(artifactId: string): string {
  return `${HEAD_PREFIX}${encodeURIComponent(artifactId)}`;
}

function revisionPrefix(artifactId: string): string {
  return `${REVISION_PREFIX}${encodeURIComponent(artifactId)}:`;
}

function revisionKey(artifactId: string, revision: number): string {
  return `${revisionPrefix(artifactId)}${String(revision).padStart(REVISION_WIDTH, '0')}`;
}

function parseStoredArtifact(text: string | null): FreshAttemptHandoffArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '');
  } catch {
    parsed = undefined;
  }
  const result = freshAttemptHandoffArtifactSchema.safeParse(parsed);
  if (!result.success) {
    throw new CorruptFreshAttemptArtifactError([{ path: '', rule: 'unreadable-stored-artifact' }]);
  }
  return result.data;
}

function staleRevision(): StaleFreshAttemptArtifactError {
  return new StaleFreshAttemptArtifactError([{ path: 'revision', rule: 'revision-conflict' }]);
}

export function createFreshAttemptArtifactStore(
  backing: ConditionalTextValueStore,
  context: FreshAttemptArtifactStoreContext,
): FreshAttemptArtifactStore {
  return {
    async load(artifactId) {
      const text = await backing.get(headKey(artifactId));
      return text === null ? undefined : parseStoredArtifact(text);
    },

    async history(artifactId) {
      const keys = await backing.list(revisionPrefix(artifactId));
      const texts = await Promise.all(keys.toSorted().map((key) => backing.get(key)));
      return texts.map((text) => parseStoredArtifact(text));
    },

    async update(artifactId, updater) {
      const head = headKey(artifactId);
      const headText = await backing.get(head);
      const latest = headText === null ? undefined : parseStoredArtifact(headText);

      const candidate = await updater(latest);
      if (candidate === undefined) return latest;

      const { artifact } = await validateFreshAttemptArtifactForPublication(candidate, {
        resolveSource: context.resolveSource,
        now: context.clock.now(),
      });
      if (artifact.artifactId !== artifactId) {
        throw new InvalidFreshAttemptArtifactError([
          { path: 'artifactId', rule: 'artifact-id-mismatch' },
        ]);
      }
      if (artifact.revision !== (latest?.revision ?? 0) + 1) throw staleRevision();

      const body = canonicalizeFreshAttemptValue(artifact);
      const committed = await backing.conditionalBatch(
        [
          { key: head, expectedValue: headText },
          { key: revisionKey(artifactId, artifact.revision), expectedValue: null },
        ],
        [
          { type: 'set', key: revisionKey(artifactId, artifact.revision), value: body },
          { type: 'set', key: head, value: body },
        ],
      );
      if (!committed) throw staleRevision();
      return artifact;
    },
  };
}
