import { describe, expect, it } from 'bun:test';
import type { ConversationHistory } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';

import type { RunConversationBoundary, RunRef } from '../agent-session';
import {
  createRunConversationBoundary,
  reconstructRunConversation,
} from './run-conversation-boundary';

function runRef(
  sequence: number,
  boundary?: RunConversationBoundary,
  status: RunRef['status'] = 'completed',
): RunRef {
  return {
    runId: `session:${sequence}`,
    sequence,
    status,
    startedAt: '2026-09-28T00:00:00.000Z',
    agentName: 'agent',
    ...(boundary === undefined ? {} : { conversationBoundary: boundary }),
  };
}

function transcript(...turns: string[]): Conversation {
  const conversation = new Conversation(createConversationHistory({ metadata: { turn: 0 } }));
  for (const turn of turns) {
    conversation.appendUserMessage(turn);
    conversation.appendAssistantMessage(`${turn} reply`);
  }
  return conversation;
}

function extend(history: ConversationHistory, ...turns: string[]): ConversationHistory {
  const conversation = new Conversation(history);
  for (const turn of turns) {
    conversation.appendUserMessage(turn);
    conversation.appendAssistantMessage(`${turn} reply`);
  }
  return conversation.current;
}

function withoutMessage(history: ConversationHistory, id: string): ConversationHistory {
  const messages = { ...history.messages };
  delete messages[id];
  return { ...history, ids: history.ids.filter((candidate) => candidate !== id), messages };
}

/** The ids and message bodies of `history` that `boundary`'s serialized form mentions. */
function storedFrom(boundary: RunConversationBoundary, history: ConversationHistory): string[] {
  const serialized = JSON.stringify(boundary);
  return history.ids.flatMap((id) =>
    [JSON.stringify(id), JSON.stringify(history.messages[id]?.content)].filter((needle) =>
      serialized.includes(needle),
    ),
  );
}

describe('run conversation boundaries', () => {
  it('stores the first boundary self-contained and reconstructs it exactly', () => {
    const first = transcript('first').current;

    const boundary = createRunConversationBoundary([runRef(0, undefined, 'running')], 0, first);

    expect(boundary.baseSequence).toBeUndefined();
    expect(boundary.baseIdCount).toBeUndefined();
    expect(boundary.ids).toEqual([...first.ids]);
    expect(Object.keys(boundary.messages)).toEqual([...first.ids]);
    expect(reconstructRunConversation([runRef(0, boundary)], 0)).toEqual(first);
  });

  it('stores a later boundary as the delta from the nearest earlier recorded boundary', () => {
    const first = transcript('first').current;
    const firstBoundary = createRunConversationBoundary([], 0, first);
    const third = extend(first, 'third');
    const runs = [runRef(0, firstBoundary), runRef(1, undefined, 'running'), runRef(2)];

    const thirdBoundary = createRunConversationBoundary(runs, 2, third);

    expect(thirdBoundary.baseSequence).toBe(0);
    expect(thirdBoundary.baseIdCount).toBe(first.ids.length);
    expect(thirdBoundary.ids).toEqual(third.ids.slice(first.ids.length));
    expect(Object.keys(thirdBoundary.messages)).toEqual(third.ids.slice(first.ids.length));
    expect(reconstructRunConversation([runs[0]!, runs[1]!, runRef(2, thirdBoundary)], 2)).toEqual(
      third,
    );
  });

  it("stores a sequential run's boundary without any of the earlier run's ids or bodies", () => {
    const first = transcript('first').current;
    const firstBoundary = createRunConversationBoundary([], 0, first);
    const second = extend(first, 'second');

    const secondBoundary = createRunConversationBoundary(
      [runRef(0, firstBoundary), runRef(1, undefined, 'running')],
      1,
      second,
    );

    expect(storedFrom(firstBoundary, first)).toHaveLength(first.ids.length * 2);
    expect(storedFrom(secondBoundary, first)).toEqual([]);
    expect(
      reconstructRunConversation([runRef(0, firstBoundary), runRef(1, secondBoundary)], 1),
    ).toEqual(second);
  });

  it('stores the ids after the prefix a boundary shares with its base, even none of them', () => {
    const first = transcript('first').current;
    const reordered: ConversationHistory = { ...first, ids: first.ids.toReversed() };
    const firstBoundary = createRunConversationBoundary([], 0, first);
    const runs = [runRef(0, firstBoundary), runRef(1)];

    const boundary = createRunConversationBoundary(runs, 1, reordered);

    expect(boundary.baseSequence).toBe(0);
    expect(boundary.baseIdCount).toBe(0);
    expect(boundary.ids).toEqual(first.ids.toReversed());
    expect(boundary.messages).toEqual({});
    expect(reconstructRunConversation([runs[0]!, runRef(1, boundary)], 1)).toEqual(reordered);
  });

  it('reconstructs ids through a chain whose middle boundary only partly survives', () => {
    const first = transcript('first').current;
    const second = extend(first, 'second');
    const replaced = extend(withoutMessage(second, second.ids.at(-1)!), 'third');
    const firstBoundary = createRunConversationBoundary([], 0, first);
    const secondBoundary = createRunConversationBoundary([runRef(0, firstBoundary)], 1, second);
    const runs = [runRef(0, firstBoundary), runRef(1, secondBoundary)];

    const replacedBoundary = createRunConversationBoundary([...runs, runRef(2)], 2, replaced);

    expect(replacedBoundary.baseSequence).toBe(1);
    expect(replacedBoundary.baseIdCount).toBe(second.ids.length - 1);
    expect(replacedBoundary.ids).toEqual(replaced.ids.slice(second.ids.length - 1));
    const chain = [...runs, runRef(2, replacedBoundary)];
    expect(reconstructRunConversation(chain, 2)).toEqual(replaced);
    expect(reconstructRunConversation(chain, 1)).toEqual(second);
    expect(reconstructRunConversation(chain, 0)).toEqual(first);
  });

  it('never uses a later run as the base for an earlier boundary', () => {
    const first = transcript('first').current;
    const later = transcript('later').current;
    const runs = [runRef(0), runRef(1, createRunConversationBoundary([], 1, later))];

    const firstBoundary = createRunConversationBoundary(runs, 0, first);

    expect(firstBoundary.baseSequence).toBeUndefined();
    expect(reconstructRunConversation([runRef(0, firstBoundary), runs[1]!], 0)).toEqual(first);
  });

  it('stores edited messages, omits removed ones, and keeps header changes', () => {
    const first = transcript('first', 'second').current;
    const [editedId, removedId] = [first.ids[1]!, first.ids[2]!];
    const edited: ConversationHistory = {
      ...withoutMessage(first, removedId),
      metadata: { turn: 1 },
      title: 'renamed',
      messages: {
        ...withoutMessage(first, removedId).messages,
        [editedId]: { ...first.messages[editedId]!, content: 'edited reply' },
      },
    };
    const runs = [runRef(0, createRunConversationBoundary([], 0, first)), runRef(1)];

    const boundary = createRunConversationBoundary(runs, 1, edited);

    expect(Object.keys(boundary.messages)).toEqual([editedId]);
    expect(boundary.baseIdCount).toBe(2);
    expect(boundary.ids).toEqual(edited.ids.slice(2));
    const reconstructed = reconstructRunConversation([runs[0]!, runRef(1, boundary)], 1);
    expect(reconstructed).toEqual(edited);
    expect(reconstructed?.messages[removedId]).toBeUndefined();
  });

  it('restores a message a base boundary removed without storing its unchanged body again', () => {
    const first = transcript('first').current;
    const restoredId = first.ids[1]!;
    const trimmed = withoutMessage(first, restoredId);
    const firstBoundary = createRunConversationBoundary([], 0, first);
    const trimmedBoundary = createRunConversationBoundary([runRef(0, firstBoundary)], 1, trimmed);
    const runs = [runRef(0, firstBoundary), runRef(1, trimmedBoundary)];

    const restoredBoundary = createRunConversationBoundary([...runs, runRef(2)], 2, first);

    expect(reconstructRunConversation(runs, 1)?.ids).not.toContain(restoredId);
    expect(restoredBoundary.baseSequence).toBe(1);
    expect(restoredBoundary.baseIdCount).toBe(trimmed.ids.length);
    expect(restoredBoundary.ids).toEqual([restoredId]);
    expect(restoredBoundary.messages).toEqual({});
    expect(reconstructRunConversation([...runs, runRef(2, restoredBoundary)], 2)).toEqual(first);
  });

  it('returns a copy that shares nothing with the stored boundaries', () => {
    const first = transcript('first').current;
    const runs = [runRef(0, createRunConversationBoundary([], 0, first))];

    const reconstructed = reconstructRunConversation(runs, 0)!;
    (reconstructed.ids as string[]).push('mutated');
    (reconstructed.messages[first.ids[0]!] as { content: unknown }).content = 'mutated';

    expect(reconstructRunConversation(runs, 0)).toEqual(first);
  });

  it('reconstructs nothing when a boundary is absent, its base chain is broken, or a message is lost', () => {
    const first = transcript('first').current;
    const firstBoundary = createRunConversationBoundary([], 0, first);
    const secondBoundary = createRunConversationBoundary(
      [runRef(0, firstBoundary)],
      1,
      extend(first, 'second'),
    );
    const lostMessage: RunConversationBoundary = { ...firstBoundary, messages: {} };
    const selfBased: RunConversationBoundary = { ...secondBoundary, baseSequence: 1 };
    const overShared: RunConversationBoundary = {
      ...secondBoundary,
      baseIdCount: first.ids.length + 1,
    };
    const negativeShared: RunConversationBoundary = { ...secondBoundary, baseIdCount: -1 };
    const sharedWithoutBase: RunConversationBoundary = { ...firstBoundary, baseIdCount: 1 };

    expect(reconstructRunConversation([runRef(0)], 0)).toBeUndefined();
    expect(reconstructRunConversation([runRef(0)], 3)).toBeUndefined();
    expect(reconstructRunConversation([runRef(0), runRef(1, secondBoundary)], 1)).toBeUndefined();
    expect(reconstructRunConversation([runRef(0, lostMessage)], 0)).toBeUndefined();
    expect(
      reconstructRunConversation([runRef(0, firstBoundary), runRef(1, selfBased)], 1),
    ).toBeUndefined();
    for (const invalid of [overShared, negativeShared]) {
      expect(
        reconstructRunConversation([runRef(0, firstBoundary), runRef(1, invalid)], 1),
      ).toBeUndefined();
    }
    expect(reconstructRunConversation([runRef(0, sharedWithoutBase)], 0)).toBeUndefined();
  });

  it('encodes against the nearest base that still reconstructs, or stands alone', () => {
    const first = transcript('first').current;
    const firstBoundary = createRunConversationBoundary([], 0, first);
    const broken: RunConversationBoundary = { ...firstBoundary, baseSequence: 7 };
    const overShared: RunConversationBoundary = { ...firstBoundary, baseIdCount: 1 };
    const third = extend(first, 'third');

    const overBroken = createRunConversationBoundary(
      [runRef(0, firstBoundary), runRef(1, broken), runRef(2)],
      2,
      third,
    );
    const alone = createRunConversationBoundary([runRef(0, broken), runRef(1)], 1, third);
    const aloneOverShared = createRunConversationBoundary(
      [runRef(0, overShared), runRef(1)],
      1,
      third,
    );

    expect(overBroken.baseSequence).toBe(0);
    expect(overBroken.ids).toEqual(third.ids.slice(first.ids.length));
    expect(Object.keys(overBroken.messages)).toEqual(third.ids.slice(first.ids.length));
    for (const boundary of [alone, aloneOverShared]) {
      expect(boundary.baseSequence).toBeUndefined();
      expect(boundary.ids).toEqual([...third.ids]);
      expect(Object.keys(boundary.messages)).toEqual([...third.ids]);
    }
  });
});
