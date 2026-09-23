import type { TextValueStore } from '@lostgradient/weft';

import {
  createSkillArtifact,
  SKILL_MANIFEST_FILENAME,
  type SkillAdmissionLimits,
  type SkillArtifact,
} from '../artifact';
import { serializeSkillMarkdown } from '../parse-skill-markdown';
import type { SkillContent } from '../types';

/**
 * Durable skill storage, read as a discovery source.
 *
 * A skill does not have to live on a filesystem: the self-improvement flow writes one straight
 * into a key-value store, and a host may ship skills it never puts on disk. Before this, those
 * skills were reachable only through a second, provider-shaped read path that duplicated
 * discovery — so a KV-backed skill had no catalog entry, no trust decision, no artifact digest and
 * no compatibility verdict, and the run holding it could not say where it came from.
 *
 * Reading them as a *source* instead means one path: a stored skill is catalogued, digested,
 * trust-decided and activated exactly like a filesystem one, and its provenance says `storage`
 * rather than nothing.
 */

const SKILL_PREFIX = 'skill:';
const METADATA_SUFFIX = ':metadata';
const BODY_SUFFIX = ':body';
const RESOURCE_SEGMENT = ':resource:';
const ENABLED_SUFFIX = ':enabled';

function decodeResourceBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Every skill name the store holds, in a deterministic order. */
async function listStoredSkillNames(store: TextValueStore): Promise<string[]> {
  const keys = await store.list(SKILL_PREFIX);
  const names = new Set<string>();
  for (const key of keys) {
    if (!key.endsWith(METADATA_SUFFIX)) continue;
    names.add(key.slice(SKILL_PREFIX.length, key.length - METADATA_SUFFIX.length));
  }
  // Sorted so two reads of an unchanged store produce the same catalog, whatever order the
  // backing store happens to enumerate keys in.
  return [...names].toSorted();
}

/**
 * Rebuilds one stored skill as an artifact.
 *
 * The stored form is a metadata record plus a body, which is not what a bundle looks like — so the
 * manifest is re-serialized from them. That round trip is deliberate: it means a stored skill is
 * validated by exactly the same strict parser as a published one rather than trusted because it
 * came from our own store.
 */
async function readStoredArtifact(
  store: TextValueStore,
  name: string,
  limits: SkillAdmissionLimits | undefined,
): Promise<SkillArtifact | undefined> {
  const [rawMetadata, rawBody] = await Promise.all([
    store.get(`${SKILL_PREFIX}${name}${METADATA_SUFFIX}`),
    store.get(`${SKILL_PREFIX}${name}${BODY_SUFFIX}`),
  ]);
  if (rawMetadata === null || rawMetadata === undefined) return undefined;

  let metadata: SkillContent['metadata'];
  try {
    metadata = JSON.parse(rawMetadata) as SkillContent['metadata'];
  } catch {
    return undefined;
  }

  const manifest = serializeSkillMarkdown({ metadata, body: rawBody ?? '' });
  const files: { path: string; bytes: Uint8Array }[] = [
    { path: SKILL_MANIFEST_FILENAME, bytes: new TextEncoder().encode(manifest) },
  ];

  const resourcePrefix = `${SKILL_PREFIX}${name}${RESOURCE_SEGMENT}`;
  const storedResourceKeys = await store.list(resourcePrefix);
  const resourceKeys = storedResourceKeys.toSorted();
  for (const key of resourceKeys) {
    const encoded = await store.get(key);
    if (encoded === null || encoded === undefined) continue;
    files.push({
      path: key.slice(resourcePrefix.length),
      bytes: decodeResourceBytes(encoded),
    });
  }

  const admission = await createSkillArtifact(
    name,
    files,
    limits === undefined ? undefined : { limits },
  );
  return admission.admitted ? admission.artifact : undefined;
}

/** Whether a stored skill is enabled. Absent means enabled, matching the stored convention. */
async function isEnabled(store: TextValueStore, name: string): Promise<boolean> {
  const raw = await store.get(`${SKILL_PREFIX}${name}${ENABLED_SUFFIX}`);
  return raw === null || raw === undefined ? true : raw !== 'false';
}

/** Artifacts for every enabled skill the store holds, keyed by name. */
export async function readStoredSkillArtifacts(
  store: TextValueStore,
  options?: { readonly limits?: SkillAdmissionLimits },
): Promise<Map<string, SkillArtifact>> {
  const artifacts = new Map<string, SkillArtifact>();
  for (const name of await listStoredSkillNames(store)) {
    // A disabled skill is not offered at all, rather than catalogued as unavailable: `enabled` is
    // an operator switch on the store, not a trust or compatibility verdict about the skill.
    if (!(await isEnabled(store, name))) continue;
    const artifact = await readStoredArtifact(store, name, options?.limits);
    if (artifact !== undefined) artifacts.set(name, artifact);
  }
  return artifacts;
}
