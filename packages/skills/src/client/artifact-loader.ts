import { join } from 'node:path';

import type { TextValueStore } from '@lostgradient/weft';

import {
  decodeArtifactText,
  findArtifactEntry,
  findArtifactManifest,
  type SkillArtifact,
} from '../artifact';
import type { SkillCatalogRecord } from '../discovery/catalog';
import { readStoredSkillArtifacts } from '../discovery/storage-source';
import { readSkillArtifact } from '../ingestion/read-skill-artifact';

/** Why loading a skill's artifact failed. */
export type SkillArtifactLoadFailure = 'unavailable' | 'changed';

/** The outcome of loading one catalogued skill's bundle. */
export type SkillArtifactLoad =
  | { readonly loaded: true; readonly artifact: SkillArtifact }
  | {
      readonly loaded: false;
      readonly failure: SkillArtifactLoadFailure;
      readonly message: string;
    };

/**
 * Produces the bundle behind a catalog record, or explains why it cannot.
 *
 * Separate from the catalog on purpose. A catalog entry is tier-one disclosure — name, description
 * and provenance — and holding every bundle's bytes in it would defeat progressive disclosure
 * entirely: the whole point is that instructions are not in context until a skill is activated.
 */
export type SkillArtifactLoader = (record: SkillCatalogRecord) => Promise<SkillArtifactLoad>;

/**
 * Reads a skill's bundle back off the filesystem and refuses it if it has changed.
 *
 * The digest comparison is the substance, not a nicety. A catalog revision is an immutable input
 * to a run, so a skill whose files changed after it was catalogued is a *different* skill from the
 * one the trust decision admitted — activating it would put instructions in front of a model that
 * nobody approved, under a name that somebody did. Refusing is what makes the revision's
 * immutability mean something at the moment it matters.
 */
export function createFilesystemArtifactLoader(): SkillArtifactLoader {
  return async (record: SkillCatalogRecord): Promise<SkillArtifactLoad> => {
    if (record.directoryName === undefined) {
      return {
        loaded: false,
        failure: 'unavailable',
        message: `Skill '${record.name}' did not come from a directory, so its bundle cannot be re-read.`,
      };
    }

    const admission = await readSkillArtifact(join(record.sourceLocation, record.directoryName));
    if (!admission.admitted) {
      return {
        loaded: false,
        failure: 'unavailable',
        message: `Skill '${record.name}' could not be re-read: ${admission.diagnostics
          .map((diagnostic) => diagnostic.code)
          .join(', ')}.`,
      };
    }

    if (admission.artifact.digest !== record.artifactDigest) {
      return {
        loaded: false,
        failure: 'changed',
        message: `Skill '${record.name}' has changed since catalog revision recorded digest ${record.artifactDigest}.`,
      };
    }

    return { loaded: true, artifact: admission.artifact };
  };
}

/**
 * A loader over artifacts already in hand, keyed by skill name.
 *
 * For a remote source whose bundle was materialized during discovery and for tests, where
 * re-reading a filesystem would be inventing a dependency the caller does not have.
 */
export function createStaticArtifactLoader(
  artifacts: ReadonlyMap<string, SkillArtifact>,
): SkillArtifactLoader {
  return (record: SkillCatalogRecord): Promise<SkillArtifactLoad> => {
    const artifact = artifacts.get(record.name);
    if (artifact === undefined) {
      return Promise.resolve({
        loaded: false,
        failure: 'unavailable',
        message: `No artifact is held for skill '${record.name}'.`,
      });
    }
    if (artifact.digest !== record.artifactDigest) {
      return Promise.resolve({
        loaded: false,
        failure: 'changed',
        message: `Skill '${record.name}' has changed since it was catalogued.`,
      });
    }
    return Promise.resolve({ loaded: true, artifact });
  };
}

/** The instruction text an artifact carries, or `undefined` when it has no manifest. */
export function readInstructions(artifact: SkillArtifact): string | undefined {
  const manifest = findArtifactManifest(artifact);
  return manifest === undefined ? undefined : decodeArtifactText(manifest);
}

/** One bundled resource, with the media type the artifact recorded for it. */
export interface LoadedSkillResource {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/**
 * Reads one resource out of an artifact.
 *
 * Returns bytes and a media type rather than text, so a caller decides for itself whether the
 * content is decodable — the criterion's "path and media-type fidelity" is only meaningful if the
 * bytes survive to the point where someone can act on the type.
 */
export function readResource(
  artifact: SkillArtifact,
  path: string,
): LoadedSkillResource | undefined {
  const entry = findArtifactEntry(artifact, path);
  if (entry === undefined) return undefined;
  return { path: entry.path, mediaType: entry.mediaType, bytes: entry.bytes };
}

/**
 * A loader that re-reads a storage-backed skill from the store it was catalogued out of.
 *
 * A `storage` record's `sourceLocation` is not a filesystem path, so the filesystem loader cannot
 * follow it. Re-reading rather than holding the artifacts from discovery is deliberate and matches
 * what the filesystem loader does: the digest comparison is only evidence if the bytes are fetched
 * again at activation time, and a loader serving a cached copy would report `loaded` for a skill
 * whose stored bytes had since been rewritten.
 */
export function createStorageArtifactLoader(store: TextValueStore): SkillArtifactLoader {
  return async (record: SkillCatalogRecord): Promise<SkillArtifactLoad> => {
    const artifacts = await readStoredSkillArtifacts(store);
    return createStaticArtifactLoader(artifacts)(record);
  };
}

/**
 * Routes each record to the loader that can actually read its source.
 *
 * A run's catalog can mix kinds — a host's filesystem roots alongside the bureau's own store — and
 * one loader cannot serve both, because `sourceLocation` means something different for each. A kind
 * with no loader configured reports `unavailable` rather than falling back to a loader that would
 * misread it: a wrong loader produces a confident digest mismatch, which reads as tamper evidence.
 */
export function createSkillArtifactLoader(options: {
  readonly storage?: TextValueStore;
  readonly filesystem?: boolean;
}): SkillArtifactLoader {
  const filesystem = options.filesystem === false ? undefined : createFilesystemArtifactLoader();
  const storage =
    options.storage === undefined ? undefined : createStorageArtifactLoader(options.storage);

  return (record: SkillCatalogRecord): Promise<SkillArtifactLoad> => {
    const loader = record.sourceKind === 'storage' ? storage : filesystem;
    if (loader === undefined) {
      return Promise.resolve({
        loaded: false,
        failure: 'unavailable',
        message: `Skill '${record.name}' comes from a '${record.sourceKind}' source, which this run has no loader for.`,
      });
    }
    return loader(record);
  };
}
