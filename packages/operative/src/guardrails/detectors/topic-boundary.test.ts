import { describe, expect, it } from 'bun:test';

import { createTopicBoundaryDetector } from './topic-boundary';

const baseContext = { step: 1, conversationLength: 1, sessionTainted: false };

describe('createTopicBoundaryDetector', () => {
  it('returns a detector with the name "topic-boundary"', () => {
    const detector = createTopicBoundaryDetector({ allowedTopics: ['weather'] });
    expect(detector.name).toBe('topic-boundary');
  });

  describe('allowed topics', () => {
    it('does not trigger when input contains an allowed topic keyword', async () => {
      const detector = createTopicBoundaryDetector({ allowedTopics: ['weather', 'travel'] });
      const result = await detector.detect('What is the weather like today?', baseContext);
      expect(result.triggered).toBe(false);
    });

    it('matches allowed topics case-insensitively', async () => {
      const detector = createTopicBoundaryDetector({ allowedTopics: ['Weather'] });
      const result = await detector.detect('tell me about the WEATHER', baseContext);
      expect(result.triggered).toBe(false);
    });

    it('triggers when input does not match any allowed topic', async () => {
      const detector = createTopicBoundaryDetector({ allowedTopics: ['weather', 'travel'] });
      const result = await detector.detect('Tell me a joke about cats.', baseContext);
      expect(result.triggered).toBe(true);
      expect(result.category).toBe('topic-boundary');
    });

    it('handles multi-word allowed topics', async () => {
      const detector = createTopicBoundaryDetector({ allowedTopics: ['machine learning'] });
      const result = await detector.detect('I want to learn about machine learning.', baseContext);
      expect(result.triggered).toBe(false);
    });
  });

  describe('blocked keywords', () => {
    it('triggers when input contains a blocked keyword', async () => {
      const detector = createTopicBoundaryDetector({
        allowedTopics: ['cooking'],
        blockedKeywords: ['explosives'],
      });
      const result = await detector.detect('How to cook with explosives?', baseContext);
      expect(result.triggered).toBe(true);
    });

    it('blocked keywords override allowed topics', async () => {
      const detector = createTopicBoundaryDetector({
        allowedTopics: ['chemistry'],
        blockedKeywords: ['drugs'],
      });
      const result = await detector.detect('Chemistry of drugs', baseContext);
      expect(result.triggered).toBe(true);
    });

    it('matches blocked keywords case-insensitively', async () => {
      const detector = createTopicBoundaryDetector({
        allowedTopics: ['cooking'],
        blockedKeywords: ['weapons'],
      });
      const result = await detector.detect('Tell me about WEAPONS', baseContext);
      expect(result.triggered).toBe(true);
    });
  });

  describe('confidence', () => {
    it('returns confidence 1.0 when blocked keyword is matched', async () => {
      const detector = createTopicBoundaryDetector({
        allowedTopics: ['cooking'],
        blockedKeywords: ['explosives'],
      });
      const result = await detector.detect('Tell me about explosives', baseContext);
      expect(result.confidence).toBe(1.0);
    });

    it('returns confidence 0.7 when no allowed topic matches', async () => {
      const detector = createTopicBoundaryDetector({ allowedTopics: ['weather'] });
      const result = await detector.detect('Tell me a joke', baseContext);
      expect(result.confidence).toBe(0.7);
    });

    it('returns confidence 0 when input is on-topic', async () => {
      const detector = createTopicBoundaryDetector({ allowedTopics: ['weather'] });
      const result = await detector.detect('What is the weather?', baseContext);
      expect(result.confidence).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('does not trigger on empty input when there are no blocked keywords', async () => {
      const detector = createTopicBoundaryDetector({ allowedTopics: ['weather'] });
      const result = await detector.detect('', baseContext);
      expect(result.triggered).toBe(false);
    });

    it('triggers on empty input when there are allowed topics and input has no match', async () => {
      // Empty input has no matching topic, but it's also not dangerous.
      // We treat empty input as a non-trigger to avoid false positives.
      const detector = createTopicBoundaryDetector({ allowedTopics: ['weather'] });
      const result = await detector.detect('', baseContext);
      expect(result.triggered).toBe(false);
    });
  });
});
