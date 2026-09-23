import type {
  LivenessEvidenceEntry,
  LivenessSnapshot,
  SemanticProgress,
} from '@lostgradient/operative';

import { toJsonSafe } from './serialization-json';

function serializeProgress(progress: SemanticProgress, seen: WeakSet<object>): SemanticProgress {
  seen.add(progress);
  try {
    return {
      ...progress,
      ...(Object.hasOwn(progress, 'checkpoint')
        ? { checkpoint: toJsonSafe(progress.checkpoint, seen) }
        : {}),
    };
  } finally {
    seen.delete(progress);
  }
}

function serializeEvidenceEntry(
  entry: LivenessEvidenceEntry,
  seen: WeakSet<object>,
): LivenessEvidenceEntry {
  seen.add(entry);
  try {
    return {
      ...entry,
      ...(Object.hasOwn(entry, 'detail') ? { detail: toJsonSafe(entry.detail, seen) } : {}),
    };
  } finally {
    seen.delete(entry);
  }
}

function serializeEvidence(
  evidence: readonly LivenessEvidenceEntry[],
  seen: WeakSet<object>,
): LivenessEvidenceEntry[] {
  seen.add(evidence);
  try {
    return evidence.map((entry) => serializeEvidenceEntry(entry, seen));
  } finally {
    seen.delete(evidence);
  }
}

/** Clone the plain-data snapshot and serialize its three explicitly unknown leaf types. */
export function serializeLivenessSnapshot(snapshot: LivenessSnapshot): LivenessSnapshot {
  const seen = new WeakSet<object>([snapshot]);
  return {
    ...snapshot,
    ...(Object.hasOwn(snapshot, 'result') ? { result: toJsonSafe(snapshot.result, seen) } : {}),
    ...(snapshot.semanticProgress
      ? { semanticProgress: serializeProgress(snapshot.semanticProgress, seen) }
      : {}),
    ...(snapshot.declaredWait ? { declaredWait: { ...snapshot.declaredWait } } : {}),
    ...(snapshot.lease ? { lease: { ...snapshot.lease } } : {}),
    evidence: serializeEvidence(snapshot.evidence, seen),
  };
}
