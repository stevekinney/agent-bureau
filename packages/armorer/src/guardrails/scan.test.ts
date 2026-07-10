import { describe, expect, it } from 'bun:test';

import { scanContent } from './scan';
import type { DetectorContext, InputDetector } from './types';

const baseContext: DetectorContext = {
  step: 1,
  conversationLength: 1,
  sessionTainted: false,
  provenance: 'ingested-document',
};

const triggeringDetector: InputDetector = {
  name: 'always-triggers',
  detect() {
    return Promise.resolve({
      triggered: true,
      confidence: 0.95,
      category: 'poison',
      detail: 'looked poisoned',
      sanitized: 'sanitized content',
    });
  },
};

const cleanDetector: InputDetector = {
  name: 'always-clean',
  detect() {
    return Promise.resolve({ triggered: false, confidence: 0, category: 'poison' });
  },
};

describe('scanContent', () => {
  it('passes clean content through unchanged', async () => {
    const result = await scanContent('hello', baseContext, { detectors: [cleanDetector] });

    expect(result).toEqual({ triggered: false, blocked: false, content: 'hello' });
  });

  it('blocks content by default when a detector triggers', async () => {
    const result = await scanContent('poisoned', baseContext, {
      detectors: [triggeringDetector],
    });

    expect(result.triggered).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.content).toBe('');
    expect(result.event).toEqual({
      detector: 'always-triggers',
      category: 'poison',
      confidence: 0.95,
      action: 'block',
      input: 'poisoned',
      detail: 'looked poisoned',
      provenance: 'ingested-document',
    });
  });

  it('flags without blocking when action is warn', async () => {
    const result = await scanContent('poisoned', baseContext, {
      detectors: [triggeringDetector],
      action: 'warn',
    });

    expect(result.triggered).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.content).toBe('poisoned');
  });

  it('replaces content with the sanitized version when action is sanitize', async () => {
    const result = await scanContent('poisoned', baseContext, {
      detectors: [triggeringDetector],
      action: 'sanitize',
    });

    expect(result.blocked).toBe(false);
    expect(result.content).toBe('sanitized content');
  });

  it('falls back to blocking when sanitize has no sanitized text', async () => {
    const noSanitizeDetector: InputDetector = {
      name: 'no-sanitize',
      detect() {
        return Promise.resolve({ triggered: true, confidence: 0.8, category: 'poison' });
      },
    };

    const result = await scanContent('poisoned', baseContext, {
      detectors: [noSanitizeDetector],
      action: 'sanitize',
    });

    expect(result.blocked).toBe(true);
    expect(result.content).toBe('');
  });

  it('blocks content when action is tripwire, leaving the throw to the caller', async () => {
    const result = await scanContent('poisoned', baseContext, {
      detectors: [triggeringDetector],
      action: 'tripwire',
    });

    expect(result.blocked).toBe(true);
    expect(result.event?.action).toBe('tripwire');
  });

  it('calls onTriggered with the built event', async () => {
    const events: unknown[] = [];

    await scanContent('poisoned', baseContext, {
      detectors: [triggeringDetector],
      onTriggered: (event) => events.push(event),
    });

    expect(events).toHaveLength(1);
    expect((events[0] as { provenance: string }).provenance).toBe('ingested-document');
  });

  it('does not call onTriggered for clean content', async () => {
    const events: unknown[] = [];

    await scanContent('hello', baseContext, {
      detectors: [cleanDetector],
      onTriggered: (event) => events.push(event),
    });

    expect(events).toHaveLength(0);
  });
});
