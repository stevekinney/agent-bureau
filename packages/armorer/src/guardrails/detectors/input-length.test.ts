import { describe, expect, it } from 'bun:test';

import { createInputLengthDetector } from './input-length';

const baseContext = {
  step: 1,
  conversationLength: 1,
  sessionTainted: false,
  provenance: 'user-input' as const,
};

describe('createInputLengthDetector', () => {
  it('returns a detector with the name "input-length"', () => {
    const detector = createInputLengthDetector();
    expect(detector.name).toBe('input-length');
  });

  it('does not trigger for input within the default limit', async () => {
    const detector = createInputLengthDetector();
    const result = await detector.detect('Hello world', baseContext);
    expect(result.triggered).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it('triggers when input exceeds the default 10,000 character limit', async () => {
    const detector = createInputLengthDetector();
    const longInput = 'a'.repeat(10_001);
    const result = await detector.detect(longInput, baseContext);
    expect(result.triggered).toBe(true);
    expect(result.confidence).toBe(1.0);
    expect(result.category).toBe('input-length');
  });

  it('does not trigger at exactly the default limit', async () => {
    const detector = createInputLengthDetector();
    const exactInput = 'a'.repeat(10_000);
    const result = await detector.detect(exactInput, baseContext);
    expect(result.triggered).toBe(false);
  });

  it('respects custom maxLength', async () => {
    const detector = createInputLengthDetector({ maxLength: 100 });
    const result = await detector.detect('a'.repeat(101), baseContext);
    expect(result.triggered).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it('does not trigger for input within custom maxLength', async () => {
    const detector = createInputLengthDetector({ maxLength: 100 });
    const result = await detector.detect('a'.repeat(100), baseContext);
    expect(result.triggered).toBe(false);
  });

  it('includes the length in the detail', async () => {
    const detector = createInputLengthDetector({ maxLength: 50 });
    const result = await detector.detect('a'.repeat(60), baseContext);
    expect(result.triggered).toBe(true);
    expect(result.detail).toContain('60');
    expect(result.detail).toContain('50');
  });

  it('does not trigger for empty input', async () => {
    const detector = createInputLengthDetector();
    const result = await detector.detect('', baseContext);
    expect(result.triggered).toBe(false);
  });
});
