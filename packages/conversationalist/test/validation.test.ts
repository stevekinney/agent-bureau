import { describe, expect, it } from 'bun:test';

import { validateSnapshot } from '../src/conversation/snapshot-integrity';
import { Conversation } from '../src/history';
import { createConversationHistory } from '../src/index';
import type { ConversationSnapshot } from '../src/types';
import { deepFreeze } from '../src/utilities/type-helpers';

describe('Conversation state integrity', () => {
  it('deeply freezes public state and preserves cached snapshot identity until a commit', () => {
    const initial = createConversationHistory({ metadata: { nested: { enabled: true } } });
    const conversation = new Conversation(initial);
    const first = conversation.getSnapshot();

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.metadata)).toBe(true);
    expect(Object.isFrozen(first.metadata['nested'])).toBe(true);
    expect(() => {
      (first.metadata['nested'] as { enabled: boolean }).enabled = false;
    }).toThrow();
    expect(conversation.getSnapshot()).toBe(first);

    conversation.appendUserMessage([{ type: 'text', text: 'hello' }]);
    const second = conversation.getSnapshot();
    const message = second.messages[second.ids[0]!]!;
    expect(second).not.toBe(first);
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.content)).toBe(true);
    expect(conversation.revision).toBe(1);
  });

  it('descends into shallow-frozen containers', () => {
    const nested = { enabled: true };
    const shallow = Object.freeze({ nested });

    deepFreeze(shallow);

    expect(Object.isFrozen(nested)).toBe(true);
  });

  it('returns a deeply frozen, integrity-protected versioned snapshot', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('hello');
    const snapshot = conversation.snapshot();

    expect(snapshot.snapshotFormatVersion).toBe(1);
    expect(snapshot.conversationSchemaVersion).toBe(5);
    expect(snapshot.controllerRevision).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.root)).toBe(true);
    expect(Object.isFrozen(snapshot.root.conversation)).toBe(true);
    expect(Conversation.from(snapshot).current).toEqual(conversation.current);

    const corrupted = structuredClone(snapshot);
    corrupted.root.conversation.title = 'tampered';
    expect(() => Conversation.from(corrupted)).toThrow('integrity digest mismatch');
  });

  it('strictly rejects unsupported versions, partial paths, duplicate identities, and invalid revisions', () => {
    const conversation = new Conversation(createConversationHistory());
    conversation.appendUserMessage('first');
    conversation.undo();
    conversation.appendUserMessage('second');
    const snapshot = conversation.snapshot();

    const future = structuredClone(snapshot) as ConversationSnapshot & {
      snapshotFormatVersion: number;
    };
    future.snapshotFormatVersion = 2;
    expect(() => Conversation.from(future as ConversationSnapshot)).toThrow(
      'unsupported snapshot format version',
    );

    const partialPath = structuredClone(snapshot);
    partialPath.currentPath = [99];
    expect(() => Conversation.from(resign(partialPath))).toThrow('current path index 99');

    const duplicate = structuredClone(snapshot);
    duplicate.root.children[1]!.id = duplicate.root.children[0]!.id;
    expect(() => Conversation.from(resign(duplicate))).toThrow('duplicate node id');

    const invalidRevision = structuredClone(snapshot);
    invalidRevision.root.children[0]!.revision = snapshot.controllerRevision + 1;
    expect(() => Conversation.from(resign(invalidRevision))).toThrow('invalid node revision');

    const invalidRootRevision = structuredClone(snapshot);
    invalidRootRevision.root.revision = snapshot.controllerRevision + 1;
    expect(() => Conversation.from(resign(invalidRootRevision))).toThrow('invalid node revision');
  });

  it('preserves fork and prune lineage in round trips', () => {
    const source = new Conversation(createConversationHistory(), { maxHistoryDepth: 2 });
    source.appendUserMessage('one');
    const forkPointMessageId = source.current.ids[0]!;
    const forked = source.fork(forkPointMessageId);
    forked.appendAssistantMessage('two');

    const forkSnapshot = forked.snapshot();
    expect(forkSnapshot.lineage).toMatchObject({
      parentConversationId: source.current.id,
      forkPointMessageId,
      sourceRevision: source.revision,
    });
    expect(Conversation.from(forkSnapshot).snapshot().lineage).toEqual(forkSnapshot.lineage);

    source.appendAssistantMessage('two');
    source.appendUserMessage('three');
    const pruned = source.snapshot();
    expect(pruned.lineage.removedNodeIds.length).toBeGreaterThan(0);
    expect(pruned.lineage.retainedFloorNodeId).toBe(pruned.root.id);
    expect(pruned.lineage.removedNodeIds).not.toContain(pruned.currentBranchId);
    expect(Conversation.from(pruned).snapshot().lineage).toEqual(pruned.lineage);

    const branched = new Conversation(createConversationHistory(), { maxHistoryDepth: 3 });
    branched.appendUserMessage('discarded branch');
    const discardedBranchId = branched.snapshot().currentBranchId;
    branched.appendAssistantMessage('discarded descendant');
    const discardedDescendantId = branched.snapshot().currentBranchId;
    branched.undo();
    branched.undo();
    branched.appendUserMessage('retained one');
    branched.appendAssistantMessage('retained two');
    branched.appendUserMessage('retained three');
    const branchedSnapshot = branched.snapshot();

    expect(branchedSnapshot.lineage.removedNodeIds).toContain(discardedBranchId);
    expect(branchedSnapshot.lineage.removedNodeIds).toContain(discardedDescendantId);
    expect(branchedSnapshot.lineage.removedNodeIds).not.toContain(branchedSnapshot.currentBranchId);
  });

  it('rejects every malformed snapshot envelope boundary', () => {
    const snapshot = new Conversation(createConversationHistory()).snapshot();
    const invalidValues: unknown[] = [
      null,
      1,
      { ...structuredClone(snapshot), conversationSchemaVersion: 999 },
      { ...structuredClone(snapshot), controllerRevision: -1 },
      { ...structuredClone(snapshot), conversationId: '' },
      { ...structuredClone(snapshot), currentBranchId: 1 },
      { ...structuredClone(snapshot), createdAt: 'not-a-date' },
      { ...structuredClone(snapshot), currentPath: [-1] },
      { ...structuredClone(snapshot), currentPath: 'root' },
      { ...structuredClone(snapshot), lineage: undefined },
      {
        ...structuredClone(snapshot),
        lineage: { ...structuredClone(snapshot.lineage), parentConversationId: 'parent' },
      },
      {
        ...structuredClone(snapshot),
        lineage: { ...structuredClone(snapshot.lineage), sourceRevision: 'one' },
      },
      {
        ...structuredClone(snapshot),
        lineage: { ...structuredClone(snapshot.lineage), forkPointMessageId: 1 },
      },
      { ...structuredClone(snapshot), lineage: { retainedFloorNodeId: 1, removedNodeIds: [] } },
      {
        ...structuredClone(snapshot),
        lineage: { retainedFloorNodeId: 'root', removedNodeIds: [1] },
      },
      { ...structuredClone(snapshot), integrity: undefined },
      { ...structuredClone(snapshot), integrity: { algorithm: 'fnv1a-64', digest: 1 } },
      { ...structuredClone(snapshot), integrity: { algorithm: 'sha256', digest: 'nope' } },
      { ...structuredClone(snapshot), root: null },
      { ...structuredClone(snapshot), root: { id: 1 } },
      {
        ...structuredClone(snapshot),
        root: { ...structuredClone(snapshot.root), children: [null] },
      },
      {
        ...structuredClone(snapshot),
        root: {
          ...structuredClone(snapshot.root),
          conversation: { ...structuredClone(snapshot.root.conversation), schemaVersion: 1 },
        },
      },
    ];

    for (const invalid of invalidValues) {
      expect(() => validateSnapshot(invalid)).toThrow('failed to restore snapshot');
    }
  });
});

function resign(snapshot: ConversationSnapshot): ConversationSnapshot {
  const { integrity: _integrity, ...unsigned } = snapshot;
  let hash = 0xcbf29ce484222325n;
  const stable = (value: unknown): string => {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(',')}}`;
  };
  for (const character of stable(unsigned)) {
    hash ^= BigInt(character.charCodeAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  snapshot.integrity = { algorithm: 'fnv1a-64', digest: hash.toString(16).padStart(16, '0') };
  return snapshot;
}
