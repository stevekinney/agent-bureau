import { describe, expect, it } from 'bun:test';

import { runDetectorPipeline } from './pipeline';
import type { DetectorContext, InputDetector } from './types';

const baseContext: DetectorContext = {
  step: 1,
  conversationLength: 1,
  sessionTainted: false,
  provenance: 'user-input',
};

function makeDetector(
  name: string,
  triggered: boolean,
  confidence = 0,
  behavior?: 'throw',
): InputDetector {
  return {
    name,
    detect() {
      if (behavior === 'throw') {
        return Promise.reject(new Error(`${name} exploded`));
      }
      return Promise.resolve({ triggered, confidence, category: name });
    },
  };
}

describe('runDetectorPipeline', () => {
  it('returns undefined when no detector triggers', async () => {
    const result = await runDetectorPipeline(
      'clean text',
      [makeDetector('a', false), makeDetector('b', false)],
      baseContext,
    );

    expect(result).toBeUndefined();
  });

  it('returns the highest-confidence trigger in parallel mode', async () => {
    const result = await runDetectorPipeline(
      'suspicious text',
      [makeDetector('low', true, 0.4), makeDetector('high', true, 0.9)],
      baseContext,
    );

    expect(result?.detectorName).toBe('high');
    expect(result?.result.confidence).toBe(0.9);
  });

  it('stops at the first trigger in sequential mode', async () => {
    const result = await runDetectorPipeline(
      'suspicious text',
      [makeDetector('first', true, 0.3), makeDetector('second', true, 0.9)],
      baseContext,
      'sequential',
    );

    expect(result?.detectorName).toBe('first');
  });

  it('catches detector errors in parallel mode without crashing', async () => {
    const result = await runDetectorPipeline(
      'text',
      [makeDetector('broken', false, 0, 'throw'), makeDetector('clean', true, 0.7)],
      baseContext,
    );

    expect(result?.detectorName).toBe('clean');
  });

  it('catches detector errors in sequential mode without crashing', async () => {
    const result = await runDetectorPipeline(
      'text',
      [makeDetector('broken', false, 0, 'throw'), makeDetector('clean', true, 0.7)],
      baseContext,
      'sequential',
    );

    expect(result?.detectorName).toBe('clean');
  });

  it('passes provenance through to detectors', async () => {
    let seenProvenance: string | undefined;
    const detector: InputDetector = {
      name: 'provenance-check',
      detect(_input, context) {
        seenProvenance = context.provenance;
        return Promise.resolve({ triggered: false, confidence: 0, category: 'noop' });
      },
    };

    await runDetectorPipeline('text', [detector], {
      ...baseContext,
      provenance: 'recalled-memory',
    });

    expect(seenProvenance).toBe('recalled-memory');
  });
});
