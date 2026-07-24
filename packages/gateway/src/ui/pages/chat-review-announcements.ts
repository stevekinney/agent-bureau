import type { ChatAnnounceLevel } from '@lostgradient/chat';

import type { PendingReview } from '../../types';

/** Announces newly appearing pending reviews while retaining lifetime deduplication state. */
export function announcePendingReviews(
  runId: string,
  reviews: readonly PendingReview[],
  announcedKeys: Set<string>,
  announce: (message: string, level: ChatAnnounceLevel) => void,
): void {
  for (const review of reviews) {
    const key = `${runId}:${review.id}`;
    if (announcedKeys.has(key)) continue;

    announcedKeys.add(key);
    const label = review.kind === 'tool-approval' ? review.approval.toolName : review.signalName;
    announce(`Review requires your input: ${label}`, 'assertive');
  }
}
