import { readFileSync } from 'node:fs';

import { describe, expect, it, mock } from 'bun:test';

import type { PendingReview } from '../../types';
import { announcePendingReviews } from './chat-review-announcements';

const chatSource = readFileSync(new URL('./chat.svelte', import.meta.url), 'utf8');

function humanReview(id: string, signalName = 'human-response'): PendingReview {
  return {
    kind: 'human-wait',
    id,
    runId: 'run-1',
    sessionId: 'session-1',
    agentName: 'bureau',
    signalName,
    prompt: 'Provide input',
    requestedAt: 0,
    ageMilliseconds: 0,
  };
}

function toolReview(id: string, toolName = 'delete-file'): PendingReview {
  return {
    kind: 'tool-approval',
    id,
    runId: 'run-1',
    sessionId: 'session-1',
    agentName: 'bureau',
    approval: {
      callId: 'call-1',
      toolName,
      arguments: {},
      action: { type: 'approval' },
    },
    requestedAt: 0,
    ageMilliseconds: 0,
  };
}

function announce(reviews: PendingReview[], runId = 'run-1', announced = new Set<string>()) {
  const calls: Array<[string, 'assertive' | 'polite' | undefined]> = [];
  announcePendingReviews(runId, reviews, announced, (message, level) => {
    calls.push([message, level]);
  });
  return calls;
}

describe('announcePendingReviews', () => {
  it('keeps interactive pending-review controls outside app-owned live regions', () => {
    expect(chatSource).not.toContain('chat-pending-input" aria-live');
    expect(chatSource).toContain('bind:this={chatComponent}');
    expect(chatSource).toContain(
      "import { announcePendingReviews } from './chat-review-announcements'",
    );
  });

  it('announces each initial review exactly once through the assertive channel', () => {
    expect(announce([toolReview('approval-1'), humanReview('wait-1')])).toEqual([
      ['Review requires your input: delete-file', 'assertive'],
      ['Review requires your input: human-response', 'assertive'],
    ]);
  });

  it('does not re-announce stable IDs when polling replaces the array', () => {
    const announced = new Set<string>();
    const first = announce([humanReview('wait-1')], 'run-1', announced);
    const second = announce([humanReview('wait-1')], 'run-1', announced);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('announces only a newly appearing review', () => {
    const announced = new Set<string>();
    announce([humanReview('wait-1')], 'run-1', announced);

    expect(announce([humanReview('wait-1'), toolReview('approval-1')], 'run-1', announced)).toEqual(
      [['Review requires your input: delete-file', 'assertive']],
    );
  });

  it('does not re-announce when payload fields change without an ID change', () => {
    const announced = new Set<string>();
    announce([humanReview('wait-1', 'original-signal')], 'run-1', announced);

    expect(announce([humanReview('wait-1', 'changed-signal')], 'run-1', announced)).toEqual([]);
  });

  it('does not re-announce a review that disappears and reappears', () => {
    const announced = new Set<string>();
    announce([humanReview('wait-1')], 'run-1', announced);
    announce([], 'run-1', announced);

    expect(announce([humanReview('wait-1')], 'run-1', announced)).toEqual([]);
  });

  it('treats the same review ID under another run as a distinct review', () => {
    const announced = new Set<string>();
    announce([humanReview('wait-1')], 'run-1', announced);

    expect(announce([humanReview('wait-1')], 'run-2', announced)).toEqual([
      ['Review requires your input: human-response', 'assertive'],
    ]);
  });

  it('adds keys before invoking the callback', () => {
    const announced = new Set<string>();
    const callback = mock((message: string, level: 'assertive' | 'polite' | undefined) => {
      expect(announced.has('run-1:wait-1')).toBe(true);
      expect(message).toBe('Review requires your input: human-response');
      expect(level).toBe('assertive');
    });

    announcePendingReviews('run-1', [humanReview('wait-1')], announced, callback);

    expect(callback).toHaveBeenCalledTimes(1);
  });
});
